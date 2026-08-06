import { OAuth2Client } from 'google-auth-library';

export type GoogleIdentity = {
  email: string;
  name: string;
};

function getClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not set');
  }
  return new OAuth2Client(clientId);
}

export async function verifyGoogleIdToken(credential: string): Promise<GoogleIdentity> {
  const client = getClient();
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || payload.email_verified === false || !payload.email) {
    throw new Error('Google ID token has no verified email');
  }

  return { email: payload.email, name: payload.name ?? payload.email };
}
