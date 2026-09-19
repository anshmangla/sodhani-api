import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { signAdminAuthToken } from '../auth/adminJwt';
import { requireAdminAuth } from '../auth/adminMiddleware';
import { adminLoginLimiter } from '../middleware/rateLimiter';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Constant-time comparison that also tolerates different-length inputs
// (crypto.timingSafeEqual throws on a length mismatch, which a naive
// password-length probe could otherwise use as an oracle) by comparing
// fixed-length hashes of both sides instead of the raw strings.
function passwordMatches(candidate: string, expected: string): boolean {
  const candidateHash = crypto.createHash('sha256').update(candidate).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

// POST /api/admin/auth/login { password }
router.post('/login', adminLoginLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    throw new Error('ADMIN_PASSWORD is not set');
  }
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ detail: 'password is required' });
    return;
  }

  if (!passwordMatches(password, expected)) {
    res.status(401).json({ detail: 'Invalid password' });
    return;
  }

  res.status(200).json({ token: signAdminAuthToken() });
}));

// GET /api/admin/auth/verify — lets the admin frontend cheaply confirm a
// stored token is still valid before rendering protected routes.
router.get('/verify', requireAdminAuth, (_req, res) => {
  res.status(200).json({ ok: true });
});

export default router;
