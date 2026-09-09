import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { signAuthToken, signSignupToken, verifySignupToken } from '../auth/jwt';
import {
  verifyMsg91AccessToken,
  sendMsg91Otp,
  verifyMsg91Otp,
  normalizePhoneNumber,
  isValidIndianPhoneNumber,
} from '../auth/msg91';
import { requireAuth } from '../auth/middleware';
import {
  checkPhoneLimiter,
  sendOtpIpLimiter,
  sendOtpPhoneLimiter,
  verifyOtpLimiter,
} from '../middleware/rateLimiter';
import {
  profilePictureUpload,
  handleUploadError,
  profilePictureUrlForFile,
  deleteOldProfilePicture,
} from '../lib/profilePicture';

const router = Router();

const USER_COLUMNS = 'id, name, age, email, phone_number, profile_picture_url';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// POST /api/auth/check-phone { phone_number, flow: 'login' | 'signup' }
router.post('/check-phone', checkPhoneLimiter, asyncHandler(async (req, res) => {
  const { phone_number, flow } = req.body ?? {};
  if (!phone_number || (flow !== 'login' && flow !== 'signup')) {
    res.status(400).json({ detail: 'phone_number and flow (login|signup) are required' });
    return;
  }

  const normalized = normalizePhoneNumber(phone_number);
  const result = await pool.query('SELECT id FROM users WHERE phone_number = $1', [normalized]);
  const exists = result.rows.length > 0;

  if (flow === 'signup' && exists) {
    res.status(409).json({ detail: 'An account with this phone number already exists' });
    return;
  }
  if (flow === 'login' && !exists) {
    res.status(404).json({ detail: 'No account found for this phone number' });
    return;
  }
  res.status(200).json({ ok: true });
}));

// POST /api/auth/send-otp { phone_number } — sends a server-side SMS OTP via the
// MSG91 authkey (cookie-free, unlike the widget flow). Used by the Flutter app.
router.post('/send-otp', sendOtpIpLimiter, sendOtpPhoneLimiter, asyncHandler(async (req, res) => {
  const { phone_number } = req.body ?? {};
  if (!phone_number) {
    res.status(400).json({ detail: 'phone_number is required' });
    return;
  }

  if (!isValidIndianPhoneNumber(phone_number)) {
    res.status(400).json({ detail: 'Please enter a valid 10-digit mobile number' });
    return;
  }

  const normalized = normalizePhoneNumber(phone_number);
  try {
    await sendMsg91Otp(normalized);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('MSG91 send OTP failed');
    res.status(502).json({ detail: 'Could not send OTP' });
  }
}));

// POST /api/auth/verify-otp { phone_number, otp } — verifies the SMS OTP. On
// success returns `{ token, user }` for an existing account, or
// `{ signup_token, requires_profile: true }` for a new number (auto-signup).
router.post('/verify-otp', verifyOtpLimiter, asyncHandler(async (req, res) => {
  const { phone_number, otp } = req.body ?? {};
  if (!phone_number || !otp) {
    res.status(400).json({ detail: 'phone_number and otp are required' });
    return;
  }

  const normalized = normalizePhoneNumber(phone_number);
  const verified = await verifyMsg91Otp(normalized, String(otp).trim());
  if (!verified) {
    res.status(401).json({ detail: 'OTP verification failed' });
    return;
  }

  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, token_version FROM users WHERE phone_number = $1`,
    [normalized]
  );

  if (result.rows.length === 0) {
    // New number: issue a short-lived signup token; the profile step completes it.
    const signupToken = signSignupToken(normalized);
    res.status(200).json({ signup_token: signupToken, requires_profile: true });
    return;
  }

  const { token_version, ...user } = result.rows[0];
  const token = signAuthToken(user.id, token_version);
  res.status(200).json({ token, user });
}));

// POST /api/auth/complete-signup { signup_token, name, age?, email? } — creates
// the account for a verified phone number and returns a session.
router.post('/complete-signup', asyncHandler(async (req, res) => {
  const { signup_token, name, age, email } = req.body ?? {};
  if (!signup_token || typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ detail: 'signup_token and valid name are required' });
    return;
  }

  const trimmedName = name.trim();
  if (trimmedName.length > 100) {
    res.status(400).json({ detail: 'Name must not exceed 100 characters' });
    return;
  }

  let parsedAge: number | null = null;
  if (age !== undefined && age !== null && age !== '') {
    parsedAge = Number(age);
    if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
      res.status(400).json({ detail: 'Age must be an integer between 1 and 120' });
      return;
    }
  }

  let cleanEmail: string | null = null;
  if (email) {
    cleanEmail = String(email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 255) {
      res.status(400).json({ detail: 'Please provide a valid email address' });
      return;
    }
  }

  let phone: string;
  try {
    phone = verifySignupToken(signup_token).phone;
  } catch {
    res.status(401).json({ detail: 'Signup token is invalid or expired' });
    return;
  }

  const existing = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone]);
  if (existing.rows.length > 0) {
    res.status(409).json({ detail: 'An account with this phone number already exists' });
    return;
  }

  if (cleanEmail) {
    const existingEmail = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [cleanEmail]);
    if (existingEmail.rows.length > 0) {
      res.status(409).json({ detail: 'An account with this email already exists' });
      return;
    }
  }

  const result = await pool.query(
    `INSERT INTO users (name, age, email, phone_number, auth_provider)
     VALUES ($1, $2, $3, $4, 'otp')
     RETURNING ${USER_COLUMNS}`,
    [trimmedName, parsedAge, cleanEmail, phone]
  );
  const user = result.rows[0];
  const token = signAuthToken(user.id, 0);
  res.status(201).json({ token, user });
}));

// POST /api/auth/verify-otp-signup { access_token, name, age, email?, phone_number }
router.post('/verify-otp-signup', verifyOtpLimiter, asyncHandler(async (req, res) => {
  const { access_token, name, age, email, phone_number } = req.body ?? {};
  if (!access_token || typeof name !== 'string' || name.trim().length === 0 || !phone_number) {
    res.status(400).json({ detail: 'access_token, name and phone_number are required' });
    return;
  }

  const trimmedName = name.trim();
  if (trimmedName.length > 100) {
    res.status(400).json({ detail: 'Name must not exceed 100 characters' });
    return;
  }

  let parsedAge: number | null = null;
  if (age !== undefined && age !== null && age !== '') {
    parsedAge = Number(age);
    if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
      res.status(400).json({ detail: 'Age must be an integer between 1 and 120' });
      return;
    }
  }

  let cleanEmail: string | null = null;
  if (email) {
    cleanEmail = String(email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 255) {
      res.status(400).json({ detail: 'Please provide a valid email address' });
      return;
    }
  }

  const normalizedPhone = normalizePhoneNumber(phone_number);
  const verifyResult = await verifyMsg91AccessToken(access_token);
  if (!verifyResult.verified) {
    res.status(401).json({ detail: 'OTP verification failed' });
    return;
  }

  // C-01: bind access token to phone number if token carries identity
  if (verifyResult.mobile && verifyResult.mobile !== normalizedPhone) {
    res.status(401).json({ detail: 'OTP verification token does not match this phone number' });
    return;
  }

  const existing = await pool.query('SELECT id FROM users WHERE phone_number = $1', [normalizedPhone]);
  if (existing.rows.length > 0) {
    res.status(409).json({ detail: 'An account with this phone number already exists' });
    return;
  }

  if (cleanEmail) {
    const existingEmail = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [cleanEmail]);
    if (existingEmail.rows.length > 0) {
      res.status(409).json({ detail: 'An account with this email already exists' });
      return;
    }
  }

  const result = await pool.query(
    `INSERT INTO users (name, age, email, phone_number, auth_provider)
     VALUES ($1, $2, $3, $4, 'otp')
     RETURNING ${USER_COLUMNS}`,
    [trimmedName, parsedAge, cleanEmail, normalizedPhone]
  );
  const user = result.rows[0];
  const token = signAuthToken(user.id, 0);
  res.status(201).json({ token, user });
}));

// POST /api/auth/verify-otp-login { access_token, phone_number }
router.post('/verify-otp-login', verifyOtpLimiter, asyncHandler(async (req, res) => {
  const { access_token, phone_number } = req.body ?? {};
  if (!access_token || !phone_number) {
    res.status(400).json({ detail: 'access_token and phone_number are required' });
    return;
  }

  const normalizedPhone = normalizePhoneNumber(phone_number);
  const verifyResult = await verifyMsg91AccessToken(access_token);
  if (!verifyResult.verified) {
    res.status(401).json({ detail: 'OTP verification failed' });
    return;
  }

  // C-01: bind access token to phone number if token carries identity
  if (verifyResult.mobile && verifyResult.mobile !== normalizedPhone) {
    res.status(401).json({ detail: 'OTP verification token does not match this phone number' });
    return;
  }

  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, token_version FROM users WHERE phone_number = $1`,
    [normalizedPhone]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ detail: 'No account found for this phone number' });
    return;
  }

  const { token_version, ...user } = result.rows[0];
  const token = signAuthToken(user.id, token_version);
  res.status(200).json({ token, user });
}));

// GET /api/auth/me
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.authUserId]);
  if (result.rows.length === 0) {
    res.status(404).json({ detail: 'User not found' });
    return;
  }
  res.status(200).json({ user: result.rows[0] });
}));

// POST /api/auth/profile-picture (multipart, field name "picture")
router.post('/profile-picture', requireAuth, profilePictureUpload, asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ detail: 'picture file is required' });
    return;
  }

  const current = await pool.query('SELECT profile_picture_url FROM users WHERE id = $1', [req.authUserId]);
  const url = profilePictureUrlForFile(req.file.filename);
  await pool.query(
    'UPDATE users SET profile_picture_url = $1, updated_at = now() WHERE id = $2',
    [url, req.authUserId]
  );
  await deleteOldProfilePicture(current.rows[0]?.profile_picture_url);

  const userResult = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.authUserId]);
  res.status(200).json({ user: userResult.rows[0] });
}), handleUploadError);

// POST /api/auth/send-delete-otp
router.post('/send-delete-otp', requireAuth, asyncHandler(async (req, res) => {
  const user = (await pool.query(`SELECT phone_number FROM users WHERE id = $1`, [req.authUserId])).rows[0];
  if (!user || !user.phone_number) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }
  res.status(200).json({ ok: true, skipped: false, phone_number: user.phone_number });
}));

// POST /api/auth/delete-account
// H-03: Rewritten on a checked-out client with atomic transaction.
// Anonymizes user and deletes personal watchlists while preserving financial records.
router.post('/delete-account', requireAuth, asyncHandler(async (req, res) => {
  const { access_token } = req.body ?? {};
  const userResult = await pool.query(`SELECT phone_number FROM users WHERE id = $1`, [req.authUserId]);
  const user = userResult.rows[0];

  if (user && user.phone_number) {
    if (!access_token) {
      res.status(400).json({ detail: 'access_token is required' });
      return;
    }
    const verifyResult = await verifyMsg91AccessToken(access_token);
    if (!verifyResult.verified) {
      res.status(401).json({ detail: 'OTP verification failed' });
      return;
    }
    if (verifyResult.mobile && verifyResult.mobile !== normalizePhoneNumber(user.phone_number)) {
      res.status(401).json({ detail: 'OTP verification token does not match this account' });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean up user's playlists and watchlist items
    await client.query('DELETE FROM watchlist_playlists WHERE user_id = $1', [req.authUserId]);
    await client.query('DELETE FROM watchlist_items WHERE user_id = $1', [req.authUserId]);

    // Anonymize user details, release the phone number/email, and bump token_version.
    // Financial records (payments, purchased_calls) are retained for audit and FK integrity.
    await client.query(
      `UPDATE users
       SET name = 'Deleted User',
           email = 'deleted_' || id || '@deleted.local',
           phone_number = 'deleted_' || id,
           profile_picture_url = NULL,
           token_version = token_version + 1,
           updated_at = now()
       WHERE id = $1`,
      [req.authUserId]
    );

    await client.query('COMMIT');
    res.status(200).json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));


// POST /api/auth/logout
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1', [req.authUserId]);
  res.status(200).json({ ok: true });
}));

export default router;
