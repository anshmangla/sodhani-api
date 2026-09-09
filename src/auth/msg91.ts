// MSG91's exact verifyAccessToken response shape isn't confirmed from their docs
// (JS-rendered docs site didn't yield the schema via fetch/search). The raw
// response is logged so the `type === 'success'` check can be adjusted against
// a real response on first live call.
//
// Trust model: this only proves the access token is valid to MSG91, not which
// phone number it belongs to. `phone_number` is otherwise trusted from the
// request body since only our own frontend constructs it — an accepted trust
// boundary, not a bug.
export function normalizePhoneNumber(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

export function isValidIndianPhoneNumber(phone: string): boolean {
  const norm = normalizePhoneNumber(phone);
  // Valid Indian mobile: 91 followed by 6, 7, 8, or 9 and 9 more digits (total 12 digits)
  return /^91[6-9]\d{9}$/.test(norm);
}

export async function verifyMsg91AccessToken(
  accessToken: string
): Promise<{ verified: boolean; mobile?: string }> {
  const authkey = process.env.MSG91_AUTH_KEY;
  if (!authkey) {
    throw new Error('MSG91_AUTH_KEY is not set');
  }

  const res = await fetch('https://control.msg91.com/api/v5/widget/verifyAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authkey, 'access-token': accessToken }),
  });

  let data: any;
  try {
    data = await res.json();
  } catch (err) {
    console.error('Failed to parse MSG91 response');
    return { verified: false };
  }

  // Redacted logging (L-05): log only outcome, never raw verification payload/tokens
  const verified = data?.type === 'success';
  const extractedMobile =
    data?.data?.mobile ||
    data?.message?.mobile ||
    data?.mobile ||
    (typeof data?.message === 'string' && data?.message.match(/\d{10,12}/)?.[0]) ||
    undefined;

  return {
    verified,
    mobile: extractedMobile ? normalizePhoneNumber(String(extractedMobile)) : undefined,
  };
}

// ── Server-side OTP (authkey) flow ────────────────────────────────────────────
// The MSG91 "OTP widget" flow (tokenAuth + sendOtpMobile) is incompatible with
// the Flutter `sendotp_flutter_sdk`: it returns a 302 into a 7-hop cross-domain
// redirect chain (zumigo / Jio Mobile Connect "invisible OTP") that requires a
// persistent cookie jar — the Dart `http` client neither keeps cookies across
// redirects nor follows more than 5 hops, so every send ends "Unauthorized".
//
// The authkey flow below is a single, cookie-free POST per step and is the
// standard MSG91 server-side OTP API.

function msg91AuthKey(): string {
  const authkey = process.env.MSG91_AUTH_KEY;
  if (!authkey) {
    throw new Error('MSG91_AUTH_KEY is not set');
  }
  return authkey;
}

export async function sendMsg91Otp(mobile: string): Promise<void> {
  const authkey = msg91AuthKey();
  const res = await fetch(
    `https://control.msg91.com/api/v5/otp?mobile=${encodeURIComponent(mobile)}&authkey=${encodeURIComponent(authkey)}`,
    { method: 'POST' }
  );

  const data = (await res.json()) as { type?: string; message?: string };
  if (data?.type !== 'success') {
    throw new Error(data?.message || 'MSG91 send OTP failed');
  }
}

export async function verifyMsg91Otp(mobile: string, otp: string): Promise<boolean> {
  const authkey = msg91AuthKey();
  const res = await fetch(
    `https://control.msg91.com/api/v5/otp/verify?otp=${encodeURIComponent(otp)}&mobile=${encodeURIComponent(mobile)}&authkey=${encodeURIComponent(authkey)}`,
    { method: 'POST' }
  );

  const data = (await res.json()) as { type?: string; message?: string };
  return data?.type === 'success';
}
