import jwt from 'jsonwebtoken';

// Deliberately minimal: there is no admin-accounts table, so the payload
// carries no identity to revoke — just proof that whoever holds this token
// once knew ADMIN_PASSWORD. See adminMiddleware.ts.
export type AdminAuthTokenPayload = {
  role: 'admin';
};

function getSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    throw new Error('ADMIN_JWT_SECRET is not set');
  }
  return secret;
}

export function signAdminAuthToken(): string {
  const payload: AdminAuthTokenPayload = { role: 'admin' };
  return jwt.sign(payload, getSecret(), {
    algorithm: 'HS256',
    expiresIn: '24h',
    issuer: 'sodhani-api',
    audience: 'sodhani-admin',
  });
}

export function verifyAdminAuthToken(token: string): AdminAuthTokenPayload {
  return jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
    audience: 'sodhani-admin',
    issuer: 'sodhani-api',
  }) as AdminAuthTokenPayload;
}
