import request from 'supertest';
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { app } from '../src/app';
import { testPool, closeTestPool } from './helpers';

describe('C-01 Security Regression Test: OTP Access Token Phone Number Binding', () => {
  const ATTACKER_PHONE = '9876500001';
  const ATTACKER_NORMALIZED = '919876500001';
  const VICTIM_PHONE = '9876500002';
  const VICTIM_NORMALIZED = '919876500002';

  beforeEach(async () => {
    // Seed victim user with normalized phone
    await testPool.query(
      `INSERT INTO users (id, name, phone_number, token_version)
       VALUES ('00000000-0000-0000-0000-00000000c001', 'Victim User', $1, 0)
       ON CONFLICT (phone_number) DO NOTHING`,
      [VICTIM_NORMALIZED]
    );
  });

  afterAll(closeTestPool);

  it('PREVENTS account takeover on verify-otp-login when token mobile mismatches target phone', async () => {
    // Mock MSG91 to return verified token for ATTACKER's mobile number
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: 'success',
        data: {
          mobile: ATTACKER_NORMALIZED,
        },
      }),
    } as any);

    process.env.MSG91_AUTH_KEY = 'test-auth-key';

    // Attacker presents valid token issued for ATTACKER_PHONE, but claims VICTIM_PHONE
    const res = await request(app)
      .post('/api/auth/verify-otp-login')
      .send({
        access_token: 'valid_token_for_attacker',
        phone_number: VICTIM_PHONE,
      });

    // In the unpatched C-01 state: this would return 200 and issue a JWT for Victim!
    // In the patched state: must return 401 Unauthorized with phone mismatch detail.
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('OTP verification token does not match this phone number');
    expect(res.body.token).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('PREVENTS account creation hijack on verify-otp-signup when token mobile mismatches target phone', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: 'success',
        data: {
          mobile: ATTACKER_NORMALIZED,
        },
      }),
    } as any);

    process.env.MSG91_AUTH_KEY = 'test-auth-key';

    // Attacker tries to register an account under a new phone number using their own token
    const res = await request(app)
      .post('/api/auth/verify-otp-signup')
      .send({
        access_token: 'valid_token_for_attacker',
        phone_number: '9876500003',
        name: 'Attacker Impersonator',
      });

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('OTP verification token does not match this phone number');
    expect(res.body.token).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('ALLOWS login when verified token matches requested phone number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: 'success',
        data: {
          mobile: VICTIM_NORMALIZED,
        },
      }),
    } as any);

    process.env.MSG91_AUTH_KEY = 'test-auth-key';

    // Legitimate login: token mobile matches target phone
    const res = await request(app)
      .post('/api/auth/verify-otp-login')
      .send({
        access_token: 'valid_token_for_victim',
        phone_number: VICTIM_PHONE,
      });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.name).toBe('Victim User');

    fetchSpy.mockRestore();
  });
});
