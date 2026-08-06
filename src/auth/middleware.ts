import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { verifyAuthToken } from './jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ detail: 'Missing or malformed Authorization header' });
    return;
  }

  let payload;
  try {
    payload = verifyAuthToken(token);
  } catch {
    res.status(401).json({ detail: 'Invalid or expired token' });
    return;
  }

  try {
    const result = await pool.query('SELECT token_version FROM users WHERE id = $1', [payload.sub]);
    if (result.rows.length === 0 || result.rows[0].token_version !== payload.token_version) {
      res.status(401).json({ detail: 'Token has been revoked' });
      return;
    }
  } catch (err) {
    next(err);
    return;
  }

  req.authUserId = payload.sub;
  next();
}
