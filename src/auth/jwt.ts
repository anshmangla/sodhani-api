import jwt from 'jsonwebtoken';

export type AuthTokenPayload = {
  sub: string;
  token_version: number;
  typ?: 'auth';
};

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

export function signAuthToken(userId: string, tokenVersion: number): string {
  const payload: AuthTokenPayload = { sub: userId, token_version: tokenVersion, typ: 'auth' };
  return jwt.sign(payload, getSecret(), {
    algorithm: 'HS256',
    expiresIn: '30d',
    issuer: 'sodhani-api',
    audience: 'sodhani-client',
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
  }) as any;

  if (payload.typ && payload.typ !== 'auth') {
    throw new Error('Invalid token type');
  }
  if (!payload.sub || typeof payload.token_version !== 'number') {
    throw new Error('Malformed token payload');
  }
  return { sub: payload.sub, token_version: payload.token_version, typ: payload.typ };
}

// Short-lived, single-purpose token issued after a phone's OTP is verified but
// before the (new) user's profile is complete. Carries only the verified phone
// number so `complete-signup` can't be called with an unverified number.
export type SignupTokenPayload = { phone: string; typ?: 'signup' };

export function signSignupToken(phone: string): string {
  return jwt.sign({ phone, typ: 'signup' }, getSecret(), {
    algorithm: 'HS256',
    expiresIn: '10m',
    issuer: 'sodhani-api',
    audience: 'sodhani-client',
  });
}

export function verifySignupToken(token: string): SignupTokenPayload {
  const payload = jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
  }) as any;

  if (payload.typ !== 'signup' || !payload.phone || typeof payload.phone !== 'string') {
    throw new Error('Invalid or non-signup token');
  }
  return { phone: payload.phone, typ: payload.typ };
}

