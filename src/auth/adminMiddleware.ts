import { Request, Response, NextFunction } from 'express';
import { verifyAdminAuthToken } from './adminJwt';

// Unlike requireAuth/requireRaAuth, this makes no DB call: there is no
// admin-accounts table and no token_version to check a single shared
// password against. Validity is entirely determined by the JWT signature
// and expiry — that's the deliberate scope of the "single shared password"
// design (see the admin dashboard plan).
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ detail: 'Missing or malformed Authorization header' });
    return;
  }

  try {
    verifyAdminAuthToken(token);
  } catch {
    res.status(401).json({ detail: 'Invalid or expired token' });
    return;
  }

  next();
}
