import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { clampLimit } from './calls';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

const USER_COLUMNS =
  'id, name, age, email, phone_number, auth_provider, is_active, profile_picture_url, created_at, updated_at';

// GET /api/admin/users/stats — must be registered before /:id so "stats"
// isn't swallowed as a :id path param.
router.get('/stats', asyncHandler(async (_req, res) => {
  const [byProvider, dailySignups, totalResult] = await Promise.all([
    pool.query(`SELECT auth_provider, COUNT(*)::int AS count FROM users GROUP BY auth_provider`),
    pool.query(`
      SELECT d::date AS day, COALESCE(u.count, 0)::int AS count
      FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
      LEFT JOIN (
        SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, COUNT(*) AS count
        FROM users GROUP BY 1
      ) u ON u.day = d::date
      ORDER BY d
    `),
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active = false)::int AS inactive FROM users`),
  ]);

  res.status(200).json({
    total: totalResult.rows[0].total,
    inactive: totalResult.rows[0].inactive,
    by_auth_provider: byProvider.rows,
    daily_signups: dailySignups.rows,
  });
}));

// GET /api/admin/users?search=&auth_provider=&is_active=&page=&limit=
router.get('/', asyncHandler(async (req, res) => {
  const { search, auth_provider, is_active } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone_number ILIKE $${params.length})`);
  }
  if (typeof auth_provider === 'string' && auth_provider.trim()) {
    params.push(auth_provider.trim());
    conditions.push(`auth_provider = $${params.length}`);
  }
  if (is_active === 'true' || is_active === 'false') {
    params.push(is_active === 'true');
    conditions.push(`is_active = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*) FROM users ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  res.status(200).json({
    data: dataResult.rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

// GET /api/admin/users/:id — detail + purchase history, same join shape as
// myCalls.ts's GET /api/me/calls, just parameterized by an admin-supplied id.
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const userResult = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const purchasesResult = await pool.query(
    `SELECT rc.id AS call_id, rc.company_name, rc.recommendation, ra.full_name AS ra_name,
            pc.purchased_at, p.amount_paise
     FROM purchased_calls pc
     JOIN research_calls rc ON rc.id = pc.call_id
     JOIN research_analysts ra ON ra.id = rc.ra_id
     JOIN payments p ON p.id = pc.payment_id
     WHERE pc.user_id = $1
     ORDER BY pc.purchased_at DESC`,
    [id]
  );

  res.status(200).json({
    user: userResult.rows[0],
    purchases: purchasesResult.rows,
  });
}));

// PATCH /api/admin/users/:id { name?, age?, email?, phone_number?, is_active? }
// Note: editing phone_number changes the identity used for OTP login —
// allowed, but higher-risk than the other fields (existing UNIQUE constraint
// + the app.ts 23505 handler still guard against collisions). is_active is
// here (not just on DELETE) so a deactivated user can also be reactivated —
// symmetric with adminRas.ts's PATCH.
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const { name, age, email, phone_number, is_active } = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
      res.status(400).json({ error: 'name must be between 1 and 100 characters' });
      return;
    }
    params.push(name.trim());
    updates.push(`name = $${params.length}`);
  }
  if (age !== undefined) {
    if (age !== null && (typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > 150)) {
      res.status(400).json({ error: 'age must be an integer between 0 and 150' });
      return;
    }
    params.push(age);
    updates.push(`age = $${params.length}`);
  }
  if (email !== undefined) {
    if (email !== null && (typeof email !== 'string' || email.length > 255)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    params.push(email ? String(email).trim() : null);
    updates.push(`email = $${params.length}`);
  }
  if (phone_number !== undefined) {
    if (phone_number !== null && (typeof phone_number !== 'string' || phone_number.length > 20)) {
      res.status(400).json({ error: 'Invalid phone_number' });
      return;
    }
    params.push(phone_number ? String(phone_number).trim() : null);
    updates.push(`phone_number = $${params.length}`);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be a boolean' });
      return;
    }
    params.push(is_active);
    updates.push(`is_active = $${params.length}`);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  params.push(id);
  const result = await pool.query(
    `UPDATE users SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const userResult = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  res.status(200).json({ user: userResult.rows[0] });
}));

// DELETE /api/admin/users/:id — soft-deactivate only, same FK reasoning as
// adminRas.ts (payments.user_id / purchased_calls.user_id have no cascade).
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const result = await pool.query(
    `UPDATE users SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`,
    [id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.status(200).json({ ok: true });
}));

export default router;
