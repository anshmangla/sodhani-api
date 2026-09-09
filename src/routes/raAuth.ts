import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { signRaAuthToken } from '../auth/raJwt';
import { requireRaAuth } from '../auth/raMiddleware';
import { fetchProductStatus } from '../services/razorpayService';
import { raLoginLimiter } from '../middleware/rateLimiter';
import {
  profilePictureUpload,
  handleUploadError,
  profilePictureUrlForFile,
  deleteOldProfilePicture,
} from '../lib/profilePicture';

const router = Router();

const RA_COLUMNS = 'id, email, full_name, profile_picture_url, designation, is_active, onboarding_status';

// Statuses that can still change without another app action from the RA —
// worth reconciling against Razorpay's live status on read. 'pending' and
// 'account_created' are excluded: no product exists yet to check.
const RECONCILABLE_STATUSES = ['stakeholder_created', 'under_review', 'needs_clarification'];
const ACTIVATION_STATUS_MAP: Record<string, string> = {
  activated: 'active',
  under_review: 'under_review',
  needs_clarification: 'needs_clarification',
  rejected: 'rejected',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = '$2a$12$e8k8W8eLwz5bHj/bA3b4ie6uQkYtY5gWkS7A7oEsm/oZ2YF5R2nUq';

function isValidPassword(password: string): boolean {
  if (typeof password !== 'string') return false;
  if (password.length < 8 || password.length > 128) return false;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumberOrSymbol = /[\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
  return hasLetter && hasNumberOrSymbol;
}

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

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim()) || email.length > 255) {
    res.status(400).json({ detail: 'Invalid email address' });
    return;
  }

  if (typeof full_name !== 'string' || full_name.trim().length === 0 || full_name.length > 100) {
    res.status(400).json({ detail: 'full_name must be between 1 and 100 characters' });
    return;
  }

  if (designation && (typeof designation !== 'string' || designation.length > 100)) {
    res.status(400).json({ detail: 'designation must be at most 100 characters' });
    return;
  }

  if (!isValidPassword(password)) {
    res.status(400).json({ detail: 'Password must be 8-128 characters and contain at least one letter and one number or symbol' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await pool.query('SELECT 1 FROM research_analysts WHERE lower(email) = $1', [normalizedEmail]);
  if (existing.rows.length > 0) {
    res.status(400).json({ detail: 'Account with this email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO research_analysts (email, password_hash, full_name, designation) 
     VALUES ($1, $2, $3, $4) RETURNING id, token_version`,
    [normalizedEmail, passwordHash, full_name.trim(), designation ? designation.trim() : null]
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
router.post('/login', raLoginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ detail: 'email and password are required' });
    return;
  }

  const result = await pool.query(
    'SELECT id, password_hash, is_active, token_version FROM research_analysts WHERE lower(email) = lower($1)',
    [email.trim()]
  );

  const row = result.rows[0];
  // Timing oracle protection: always run bcrypt.compare even if email not found
  const passwordMatches = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
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
  if (!current_password || !new_password || typeof current_password !== 'string' || typeof new_password !== 'string') {
    res.status(400).json({ detail: 'current_password and new_password are required' });
    return;
  }

  if (!isValidPassword(new_password)) {
    res.status(400).json({ detail: 'New password must be 8-128 characters and contain at least one letter and one number or symbol' });
    return;
  }

  const result = await pool.query('SELECT password_hash FROM research_analysts WHERE id = $1', [req.authRaId]);
  const row = result.rows[0];
  const currentMatches = row ? await bcrypt.compare(current_password, row.password_hash) : false;
  if (!currentMatches) {
    res.status(401).json({ detail: 'Current password is incorrect' });
    return;
  }

  const newHash = await bcrypt.hash(new_password, 12);
  await pool.query(
    'UPDATE research_analysts SET password_hash = $1, token_version = token_version + 1, updated_at = now() WHERE id = $2',
    [newHash, req.authRaId]
  );
  res.status(200).json({ ok: true });
}));

// GET /api/ra/me
router.get('/me', requireRaAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ${RA_COLUMNS}, razorpay_account_id, razorpay_product_id FROM research_analysts WHERE id = $1`,
    [req.authRaId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ detail: 'Research analyst not found' });
    return;
  }
  let ra = result.rows[0];

  // Self-heal: Route KYC-status webhooks have proven unreliable to depend on
  // alone (a Dashboard config gap silently meant these were never sent for
  // months), so reconcile against Razorpay's live status on every read while
  // we're sitting in a state that could still change.
  if (RECONCILABLE_STATUSES.includes(ra.onboarding_status) && ra.razorpay_account_id && ra.razorpay_product_id) {
    try {
      const { activationStatus } = await fetchProductStatus(ra.razorpay_account_id, ra.razorpay_product_id);
      const resolvedStatus = ACTIVATION_STATUS_MAP[activationStatus];
      if (resolvedStatus && resolvedStatus !== ra.onboarding_status) {
        await pool.query(
          `UPDATE research_analysts SET onboarding_status = $1, updated_at = now() WHERE id = $2`,
          [resolvedStatus, ra.id]
        );
        ra = { ...ra, onboarding_status: resolvedStatus };
      }
    } catch (err) {
      console.error('[ra/me] Live status reconciliation failed:', err);
    }
  }

  const { razorpay_account_id, razorpay_product_id, ...publicRa } = ra;
  res.status(200).json({ ra: publicRa });
}));

// POST /api/ra/profile-picture (multipart, field name "picture")
router.post('/profile-picture', requireRaAuth, profilePictureUpload, asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ detail: 'picture file is required' });
    return;
  }

  const current = await pool.query('SELECT profile_picture_url FROM research_analysts WHERE id = $1', [req.authRaId]);
  const url = profilePictureUrlForFile(req.file.filename);
  await pool.query(
    'UPDATE research_analysts SET profile_picture_url = $1, updated_at = now() WHERE id = $2',
    [url, req.authRaId]
  );
  await deleteOldProfilePicture(current.rows[0]?.profile_picture_url);

  const raResult = await pool.query(`SELECT ${RA_COLUMNS} FROM research_analysts WHERE id = $1`, [req.authRaId]);
  res.status(200).json({ ra: raResult.rows[0] });
}), handleUploadError);

// POST /api/ra/logout
router.post('/logout', requireRaAuth, asyncHandler(async (req, res) => {
  await pool.query(
    'UPDATE research_analysts SET token_version = token_version + 1, updated_at = now() WHERE id = $1',
    [req.authRaId]
  );
  res.status(200).json({ ok: true });
}));

export default router;
