// MSG91's exact verifyAccessToken response shape isn't confirmed from their docs
// (JS-rendered docs site didn't yield the schema via fetch/search). The raw
// response is logged so the `type === 'success'` check can be adjusted against
// a real response on first live call.
//
// Trust model: this only proves the access token is valid to MSG91, not which
// phone number it belongs to. `phone_number` is otherwise trusted from the
// request body since only our own frontend constructs it — an accepted trust
// boundary, not a bug.
export async function verifyMsg91AccessToken(accessToken: string): Promise<boolean> {
  const authkey = process.env.MSG91_AUTH_KEY;
  if (!authkey) {
    throw new Error('MSG91_AUTH_KEY is not set');
  }

  const res = await fetch('https://control.msg91.com/api/v5/widget/verifyAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authkey, 'access-token': accessToken }),
  });

  const data = (await res.json()) as { type?: string };
  console.log('MSG91 verifyAccessToken response:', JSON.stringify(data));

  return data?.type === 'success';
}
