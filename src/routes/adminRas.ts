import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { clampLimit } from './calls';
import { getEarningsSummary } from '../services/raTransfersService';
import { EMAIL_REGEX, isValidPassword } from './raAuth';

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

const RA_COLUMNS =
  'id, email, full_name, profile_picture_url, designation, is_active, total_sales, onboarding_status, created_at, updated_at';

// GET /api/admin/ras?search=&is_active=&onboarding_status=&page=&limit=
router.get('/', asyncHandler(async (req, res) => {
  const { search, is_active, onboarding_status } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length})`);
  }
  if (is_active === 'true' || is_active === 'false') {
    params.push(is_active === 'true');
    conditions.push(`is_active = $${params.length}`);
  }
  if (typeof onboarding_status === 'string' && onboarding_status.trim()) {
    params.push(onboarding_status.trim());
    conditions.push(`onboarding_status = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*) FROM research_analysts ${whereClause}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT ${RA_COLUMNS} FROM research_analysts ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  res.status(200).json({
    data: dataResult.rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

// GET /api/admin/ras/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  const raResult = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [id]);
  if (raResult.rows.length === 0) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  const [callsResult, earnings] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_calls, COUNT(*) FILTER (WHERE is_paid = true)::int AS total_paid_calls
       FROM research_calls WHERE ra_id = $1`,
      [id]
    ),
    getEarningsSummary(id),
  ]);

  res.status(200).json({
    ra: raResult.rows[0],
    stats: callsResult.rows[0],
    earnings: {
      total_paise: earnings.totalPaise,
      this_month_paise: earnings.thisMonthPaise,
      this_year_paise: earnings.thisYearPaise,
      failed_transfer_count: earnings.failedTransferCount,
    },
  });
}));

// POST /api/admin/ras { email, full_name, designation?, password? }
// If password is omitted, a temporary one is generated and returned once —
// there's no email/invite infrastructure in this codebase to deliver it
// automatically, so it's on the admin operator to relay it out-of-band.
router.post('/', asyncHandler(async (req, res) => {
  const { email, full_name, designation, password } = req.body ?? {};

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim()) || email.length > 255) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }
  if (typeof full_name !== 'string' || full_name.trim().length === 0 || full_name.length > 100) {
    res.status(400).json({ error: 'full_name must be between 1 and 100 characters' });
    return;
  }
  if (designation != null && (typeof designation !== 'string' || designation.length > 100)) {
    res.status(400).json({ error: 'designation must be at most 100 characters' });
    return;
  }

  let plainPassword: string;
  if (password != null) {
    if (typeof password !== 'string' || !isValidPassword(password)) {
      res.status(400).json({ error: 'Password must be 8-128 characters and contain at least one letter and one number or symbol' });
      return;
    }
    plainPassword = password;
  } else {
    plainPassword = crypto.randomBytes(9).toString('base64url');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await pool.query('SELECT 1 FROM research_analysts WHERE lower(email) = $1', [normalizedEmail]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'Account with this email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(plainPassword, 12);
  const result = await pool.query(
    `INSERT INTO research_analysts (email, password_hash, full_name, designation)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [normalizedEmail, passwordHash, full_name.trim(), designation ? designation.trim() : null]
  );

  const raResult = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [result.rows[0].id]);

  res.status(201).json({
    ra: raResult.rows[0],
    // Only ever returned here — the hash is all that's stored from this point on.
    temporary_password: password != null ? undefined : plainPassword,
  });
}));

// PATCH /api/admin/ras/:id { full_name?, designation?, is_active? }
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  const { full_name, designation, is_active } = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  if (full_name !== undefined) {
    if (typeof full_name !== 'string' || full_name.trim().length === 0 || full_name.length > 100) {
      res.status(400).json({ error: 'full_name must be between 1 and 100 characters' });
      return;
    }
    params.push(full_name.trim());
    updates.push(`full_name = $${params.length}`);
  }
  if (designation !== undefined) {
    if (designation !== null && (typeof designation !== 'string' || designation.length > 100)) {
      res.status(400).json({ error: 'designation must be at most 100 characters' });
      return;
    }
    params.push(designation ? String(designation).trim() : null);
    updates.push(`designation = $${params.length}`);
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
    `UPDATE research_analysts SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  const raResult = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [id]);
  res.status(200).json({ ra: raResult.rows[0] });
}));

// POST /api/admin/ras/:id/reset-password — generates a new temporary
// password and bumps token_version, revoking all of the RA's existing
// sessions (the same mechanism raMiddleware.ts already checks).
router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  const temporaryPassword = crypto.randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);

  const result = await pool.query(
    `UPDATE research_analysts
     SET password_hash = $1, token_version = token_version + 1, updated_at = now()
     WHERE id = $2 RETURNING id`,
    [passwordHash, id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  res.status(200).json({ temporary_password: temporaryPassword });
}));

// DELETE /api/admin/ras/:id — soft-deactivate only. research_calls.ra_id and
// ra_transfers.ra_id reference this row with no ON DELETE CASCADE, so a real
// delete would throw a 23503 for any RA who's ever posted a call — which is
// almost always. This is just is_active = false under a DELETE verb.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  const result = await pool.query(
    `UPDATE research_analysts SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`,
    [id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Research analyst not found' });
    return;
  }

  res.status(200).json({ ok: true });
}));

export default router;
