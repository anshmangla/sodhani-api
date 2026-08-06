import jwt from 'jsonwebtoken';

export type AuthTokenPayload = {
  sub: string;
  token_version: number;
};

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

export function signAuthToken(userId: string, tokenVersion: number): string {
  const payload: AuthTokenPayload = { sub: userId, token_version: tokenVersion };
  return jwt.sign(payload, getSecret(), { algorithm: 'HS256', expiresIn: '30d' });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, getSecret(), { algorithms: ['HS256'] }) as AuthTokenPayload;
}
