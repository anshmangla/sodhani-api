import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { verifyRaAuthToken } from './raJwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authRaId?: string;
    }
  }
}

export async function requireRaAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ detail: 'Missing or malformed Authorization header' });
    return;
  }

  let payload;
  try {
    payload = verifyRaAuthToken(token);
  } catch {
    res.status(401).json({ detail: 'Invalid or expired token' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT token_version, is_active FROM research_analysts WHERE id = $1',
      [payload.sub]
    );
    if (result.rows.length === 0 || result.rows[0].token_version !== payload.token_version) {
      res.status(401).json({ detail: 'Token has been revoked' });
      return;
    }
    if (result.rows[0].is_active === false) {
      res.status(401).json({ detail: 'Account is inactive' });
      return;
    }
  } catch (err) {
    next(err);
    return;
  }

  req.authRaId = payload.sub;
  next();
}
