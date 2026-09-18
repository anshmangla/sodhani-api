import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { buildCallPayload, resolveOptionalUserId, clampLimit } from './calls';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Same literal as raCalls.ts's UUID_REGEX — kept local per this codebase's
// convention of not sharing small helpers across route files.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

// GET /api/analyst/:id — public analyst profile. No Buy/Hold/Sell breakdown
// in stats, by explicit decision: that would surface a signal derived from
// the paywalled `recommendation` field without the caller having paid for it.
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Analyst not found' });
    return;
  }

  const analystResult = await pool.query(
    `SELECT id, full_name, designation, profile_picture_url, created_at
     FROM research_analysts
     WHERE id = $1 AND is_active = true`,
    [id]
  );
  if (analystResult.rows.length === 0) {
    res.status(404).json({ error: 'Analyst not found' });
    return;
  }
  const analyst = analystResult.rows[0];

  const statsResult = await pool.query(
    `SELECT
       COUNT(*) AS total_calls,
       COUNT(*) FILTER (WHERE status = 'open') AS open_calls,
       COUNT(*) FILTER (WHERE status = 'closed') AS closed_calls
     FROM research_calls
     WHERE ra_id = $1`,
    [id]
  );
  const stats = statsResult.rows[0];

  res.status(200).json({
    analyst: {
      id: analyst.id,
      name: analyst.full_name,
      designation: analyst.designation,
      profile_picture_url: analyst.profile_picture_url,
      member_since: analyst.created_at,
      stats: {
        total_calls: parseInt(stats.total_calls, 10),
        open_calls: parseInt(stats.open_calls, 10),
        closed_calls: parseInt(stats.closed_calls, 10),
      },
    },
  });
}));

// GET /api/analyst/:id/calls?page=&limit= — paginated calls for that
// analyst, reusing calls.ts's paywall/entitlement logic exactly (imported
// buildCallPayload/resolveOptionalUserId/clampLimit) rather than
// reimplementing it here.
router.get('/:id/calls', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Analyst not found' });
    return;
  }

  const analystResult = await pool.query(
    `SELECT id FROM research_analysts WHERE id = $1 AND is_active = true`,
    [id]
  );
  if (analystResult.rows.length === 0) {
    res.status(404).json({ error: 'Analyst not found' });
    return;
  }

  const userId = await resolveOptionalUserId(req);
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    `SELECT COUNT(*)
     FROM research_calls rc
     JOIN research_analysts ra ON ra.id = rc.ra_id
     WHERE rc.ra_id = $1 AND ra.is_active = true`,
    [id]
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT rc.*, ra.full_name AS ra_name, ra.profile_picture_url AS ra_profile_picture_url, ra.designation AS ra_designation
     FROM research_calls rc
     JOIN research_analysts ra ON ra.id = rc.ra_id
     WHERE rc.ra_id = $1 AND ra.is_active = true
     ORDER BY rc.created_at DESC
     LIMIT $2 OFFSET $3`,
    [id, limit, offset]
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

  res.status(200).json({
    data: rows.map((r) => buildCallPayload(r, purchasedSet.has(r.id))),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

export default router;
