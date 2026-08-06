import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { verifyAuthToken } from '../auth/jwt';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Non-rejecting auth resolution: any failure (missing header, bad/expired token,
// revoked token, DB error) resolves to `undefined` — the caller is treated as
// anonymous rather than being 401'd. This is deliberately distinct from `requireAuth`.
async function resolveOptionalUserId(req: Request): Promise<string | undefined> {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return undefined;
  let payload;
  try {
    payload = verifyAuthToken(token); // consumer verifier from '../auth/jwt'
  } catch {
    return undefined;
  }
  try {
    const result = await pool.query('SELECT token_version FROM users WHERE id = $1', [payload.sub]);
    if (result.rows.length === 0 || result.rows[0].token_version !== payload.token_version) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return payload.sub;
}

// Explicit field whitelist for the "preview" (non-entitled) view of a call. Every
// field is named individually — a future new column on research_calls is
// locked-out-by-default rather than silently leaking through a row spread.
function buildPreviewPayload(row: any, purchased: boolean) {
  return {
    id: row.id,
    scrip_code: row.scrip_code,
    company_name: row.company_name,
    recommendation: row.recommendation,
    is_paid: row.is_paid,
    price_paise: row.price_paise,
    status: row.status,
    created_at: row.created_at,
    ra_name: row.ra_name,
    ra_profile_picture_url: row.ra_profile_picture_url,
    ra_designation: row.ra_designation,
    purchased,
  };
}

function buildFullPayload(row: any, purchased: boolean) {
  return {
    ...buildPreviewPayload(row, purchased),
    current_price_at_publish: row.current_price_at_publish,
    volume_at_publish: row.volume_at_publish,
    target_price: row.target_price,
    stop_loss: row.stop_loss,
    buying_range: row.buying_range,
    holding_period: row.holding_period,
    updated_at: row.updated_at,
  };
}

function buildCallPayload(row: any, purchased: boolean) {
  const entitled = !row.is_paid || purchased;
  return entitled ? buildFullPayload(row, purchased) : buildPreviewPayload(row, purchased);
}

const CALL_JOIN_SELECT = `
  SELECT rc.*, ra.full_name AS ra_name, ra.profile_picture_url AS ra_profile_picture_url, ra.designation AS ra_designation
  FROM research_calls rc
  JOIN research_analysts ra ON ra.id = rc.ra_id
`;

// GET /api/calls?page=&limit=
router.get('/', asyncHandler(async (req, res) => {
  const userId = await resolveOptionalUserId(req);

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const countResult = await pool.query('SELECT COUNT(*) FROM research_calls');
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `${CALL_JOIN_SELECT}
     ORDER BY rc.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const rows = dataResult.rows;

  let purchasedSet = new Set<string>();
  if (userId && rows.some((r) => r.is_paid)) {
    const purchasedResult = await pool.query(
      'SELECT call_id FROM purchased_calls WHERE user_id = $1 AND call_id = ANY($2::uuid[])',
      [userId, rows.map((r) => r.id)]
    );
    purchasedSet = new Set(purchasedResult.rows.map((r) => r.call_id));
  }

  res.json({
    data: rows.map((r) => buildCallPayload(r, purchasedSet.has(r.id))),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

// GET /api/calls/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const userId = await resolveOptionalUserId(req);
  const { id } = req.params;

  const result = await pool.query(`${CALL_JOIN_SELECT} WHERE rc.id = $1`, [id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const row = result.rows[0];

  let purchased = false;
  if (row.is_paid && userId) {
    const purchasedResult = await pool.query(
      'SELECT 1 FROM purchased_calls WHERE user_id = $1 AND call_id = $2',
      [userId, id]
    );
    purchased = purchasedResult.rows.length > 0;
  }

  res.status(200).json({ call: buildCallPayload(row, purchased) });
}));

// GET /api/calls/:id/comments
router.get('/:id/comments', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const callResult = await pool.query('SELECT id, is_paid FROM research_calls WHERE id = $1', [id]);
  if (callResult.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const call = callResult.rows[0];

  if (call.is_paid) {
    const userId = await resolveOptionalUserId(req);
    if (!userId) {
      res.status(403).json({ error: 'Purchase required' });
      return;
    }
    const purchasedResult = await pool.query(
      'SELECT 1 FROM purchased_calls WHERE user_id = $1 AND call_id = $2',
      [userId, id]
    );
    if (purchasedResult.rows.length === 0) {
      res.status(403).json({ error: 'Purchase required' });
      return;
    }
  }

  const commentsResult = await pool.query(
    'SELECT id, body, created_at FROM call_comments WHERE call_id = $1 ORDER BY created_at ASC',
    [id]
  );

  res.status(200).json({ comments: commentsResult.rows });
}));

export default router;
