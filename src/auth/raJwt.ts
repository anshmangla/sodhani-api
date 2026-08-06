import jwt from 'jsonwebtoken';

export type RaAuthTokenPayload = {
  sub: string;
  token_version: number;
};

function getSecret(): string {
  const secret = process.env.RA_JWT_SECRET;
  if (!secret) {
    throw new Error('RA_JWT_SECRET is not set');
  }
  return secret;
}

export function signRaAuthToken(raId: string, tokenVersion: number): string {
  const payload: RaAuthTokenPayload = { sub: raId, token_version: tokenVersion };
  return jwt.sign(payload, getSecret(), { algorithm: 'HS256', expiresIn: '30d' });
}

export function verifyRaAuthToken(token: string): RaAuthTokenPayload {
  return jwt.verify(token, getSecret(), { algorithms: ['HS256'] }) as RaAuthTokenPayload;
}
