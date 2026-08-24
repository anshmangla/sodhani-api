import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { signAuthToken, signSignupToken, verifySignupToken } from '../auth/jwt';
import { verifyMsg91AccessToken, sendMsg91Otp, verifyMsg91Otp } from '../auth/msg91';
import { verifyGoogleIdToken } from '../auth/google';
import { requireAuth } from '../auth/middleware';

const router = Router();

const USER_COLUMNS = 'id, name, age, email, phone_number';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// POST /api/auth/check-phone { phone_number, flow: 'login' | 'signup' }
router.post('/check-phone', asyncHandler(async (req, res) => {
  const { phone_number, flow } = req.body ?? {};
  if (!phone_number || (flow !== 'login' && flow !== 'signup')) {
    res.status(400).json({ detail: 'phone_number and flow (login|signup) are required' });
    return;
  }

  const result = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone_number]);
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
router.post('/send-otp', asyncHandler(async (req, res) => {
  const { phone_number } = req.body ?? {};
  if (!phone_number) {
    res.status(400).json({ detail: 'phone_number is required' });
    return;
  }
  try {
    await sendMsg91Otp(phone_number);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('MSG91 send OTP failed:', err);
    res.status(502).json({ detail: 'Could not send OTP' });
  }
}));

// POST /api/auth/verify-otp { phone_number, otp } — verifies the SMS OTP. On
// success returns `{ token, user }` for an existing account, or
// `{ signup_token, requires_profile: true }` for a new number (auto-signup).
router.post('/verify-otp', asyncHandler(async (req, res) => {
  const { phone_number, otp } = req.body ?? {};
  if (!phone_number || !otp) {
    res.status(400).json({ detail: 'phone_number and otp are required' });
    return;
  }

  const verified = await verifyMsg91Otp(phone_number, otp);
  if (!verified) {
    res.status(401).json({ detail: 'OTP verification failed' });
    return;
  }

  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, token_version FROM users WHERE phone_number = $1`,
    [phone_number]
  );

  if (result.rows.length === 0) {
    // New number: issue a short-lived signup token; the profile step completes it.
    const signupToken = signSignupToken(phone_number);
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
  if (!signup_token || !name) {
    res.status(400).json({ detail: 'signup_token and name are required' });
    return;
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

  if (email) {
    const existingEmail = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existingEmail.rows.length > 0) {
      res.status(409).json({ detail: 'An account with this email already exists' });
      return;
    }
  }

  const result = await pool.query(
    `INSERT INTO users (name, age, email, phone_number, auth_provider)
     VALUES ($1, $2, $3, $4, 'otp')
     RETURNING ${USER_COLUMNS}`,
    [name, age ?? null, email ?? null, phone]
  );
  const user = result.rows[0];
  const token = signAuthToken(user.id, 0);
  res.status(201).json({ token, user });
}));

// POST /api/auth/verify-otp-signup { access_token, name, age, email?, phone_number }
router.post('/verify-otp-signup', asyncHandler(async (req, res) => {
  const { access_token, name, age, email, phone_number } = req.body ?? {};
  if (!access_token || !name || !phone_number) {
    res.status(400).json({ detail: 'access_token, name and phone_number are required' });
    return;
  }

  const verified = await verifyMsg91AccessToken(access_token);
  if (!verified) {
    res.status(401).json({ detail: 'OTP verification failed' });
    return;
  }

  const existing = await pool.query('SELECT id FROM users WHERE phone_number = $1', [phone_number]);
  if (existing.rows.length > 0) {
    res.status(409).json({ detail: 'An account with this phone number already exists' });
    return;
  }

  if (email) {
    const existingEmail = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existingEmail.rows.length > 0) {
      res.status(409).json({ detail: 'An account with this email already exists' });
      return;
    }
  }

  const result = await pool.query(
    `INSERT INTO users (name, age, email, phone_number, auth_provider)
     VALUES ($1, $2, $3, $4, 'otp')
     RETURNING ${USER_COLUMNS}`,
    [name, age ?? null, email ?? null, phone_number]
  );
  const user = result.rows[0];
  const token = signAuthToken(user.id, 0);
  res.status(201).json({ token, user });
}));

// POST /api/auth/verify-otp-login { access_token, phone_number }
router.post('/verify-otp-login', asyncHandler(async (req, res) => {
  const { access_token, phone_number } = req.body ?? {};
  if (!access_token || !phone_number) {
    res.status(400).json({ detail: 'access_token and phone_number are required' });
    return;
  }

  const verified = await verifyMsg91AccessToken(access_token);
  if (!verified) {
    res.status(401).json({ detail: 'OTP verification failed' });
    return;
  }

  const result = await pool.query(
    `SELECT ${USER_COLUMNS}, token_version FROM users WHERE phone_number = $1`,
    [phone_number]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ detail: 'No account found for this phone number' });
    return;
  }

  const { token_version, ...user } = result.rows[0];
  const token = signAuthToken(user.id, token_version);
  res.status(200).json({ token, user });
}));

// POST /api/auth/google { credential }
router.post('/google', asyncHandler(async (req, res) => {
  const { credential } = req.body ?? {};
  if (!credential) {
    res.status(400).json({ detail: 'credential is required' });
    return;
  }

  let identity;
  try {
    identity = await verifyGoogleIdToken(credential);
  } catch {
    res.status(401).json({ detail: 'Google sign-in verification failed' });
    return;
  }

  const existing = await pool.query(
    `SELECT ${USER_COLUMNS}, token_version FROM users WHERE lower(email) = lower($1)`,
    [identity.email]
  );

  let user;
  let tokenVersion: number;
  if (existing.rows.length > 0) {
    const { token_version, ...rest } = existing.rows[0];
    user = rest;
    tokenVersion = token_version;
  } else {
    const inserted = await pool.query(
      `INSERT INTO users (name, email, auth_provider)
       VALUES ($1, $2, 'google')
       RETURNING ${USER_COLUMNS}`,
      [identity.name, identity.email]
    );
    user = inserted.rows[0];
    tokenVersion = 0;
  }

  const token = signAuthToken(user.id, tokenVersion);
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

// POST /api/auth/logout
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1', [req.authUserId]);
  res.status(200).json({ ok: true });
}));

export default router;
