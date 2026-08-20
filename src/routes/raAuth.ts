import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { signRaAuthToken } from '../auth/raJwt';
import { requireRaAuth } from '../auth/raMiddleware';

const router = Router();

const RA_COLUMNS = 'id, email, full_name, profile_picture_url, designation, is_active, onboarding_status';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// POST /api/ra/signup
router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, full_name, designation } = req.body ?? {};
  if (!email || !password || !full_name) {
    res.status(400).json({ detail: 'email, password, and full_name are required' });
    return;
  }

  const existing = await pool.query('SELECT 1 FROM research_analysts WHERE lower(email) = lower($1)', [email]);
  if (existing.rows.length > 0) {
    res.status(400).json({ detail: 'Account with this email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO research_analysts (email, password_hash, full_name, designation) 
     VALUES ($1, $2, $3, $4) RETURNING id, token_version`,
    [email, passwordHash, full_name, designation || null]
  );
  
  const row = result.rows[0];
  const token = signRaAuthToken(row.id, row.token_version);
  const raResult = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [row.id]);
  
  res.status(201).json({
    token,
    ra: raResult.rows[0],
  });
}));

// POST /api/ra/login { email, password }
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ detail: 'email and password are required' });
    return;
  }

  const result = await pool.query(
    'SELECT id, password_hash, is_active, token_version FROM research_analysts WHERE lower(email) = lower($1)',
    [email]
  );

  const row = result.rows[0];
  const passwordMatches = row ? await bcrypt.compare(password, row.password_hash) : false;
  if (!row || !passwordMatches) {
    res.status(401).json({ detail: 'Invalid email or password' });
    return;
  }

  if (row.is_active === false) {
    res.status(401).json({ detail: 'Account is inactive' });
    return;
  }

  const token = signRaAuthToken(row.id, row.token_version);
  const raResult = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [row.id]);
  res.status(200).json({
    token,
    ra: raResult.rows[0],
  });
}));

// POST /api/ra/change-password { current_password, new_password }
router.post('/change-password', requireRaAuth, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password) {
    res.status(400).json({ detail: 'current_password and new_password are required' });
    return;
  }

  const result = await pool.query('SELECT password_hash FROM research_analysts WHERE id = $1', [req.authRaId]);
  const row = result.rows[0];
  const currentMatches = row ? await bcrypt.compare(current_password, row.password_hash) : false;
  if (!currentMatches) {
    res.status(401).json({ detail: 'Current password is incorrect' });
    return;
  }

  const newHash = await bcrypt.hash(new_password, 10);
  await pool.query(
    'UPDATE research_analysts SET password_hash = $1, token_version = token_version + 1, updated_at = now() WHERE id = $2',
    [newHash, req.authRaId]
  );
  res.status(200).json({ ok: true });
}));

// GET /api/ra/me
router.get('/me', requireRaAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [req.authRaId]);
  if (result.rows.length === 0) {
    res.status(404).json({ detail: 'Research analyst not found' });
    return;
  }
  res.status(200).json({ ra: result.rows[0] });
}));

// POST /api/ra/logout
router.post('/logout', requireRaAuth, asyncHandler(async (req, res) => {
  await pool.query(
    'UPDATE research_analysts SET token_version = token_version + 1, updated_at = now() WHERE id = $1',
    [req.authRaId]
  );
  res.status(200).json({ ok: true });
}));

export default router;
