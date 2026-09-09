import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../src/app';

describe('rate limiting', () => {
  it('enforces rate limit when test header is present', async () => {
    const responses = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/auth/check-phone')
        .set('x-test-rate-limit', 'true')
        .send({ phone_number: '9876543210', flow: 'login' });
      responses.push(res);
    }

    const rateLimited = responses.find((r) => r.status === 429);
    expect(rateLimited).toBeDefined();
    expect(rateLimited?.body.detail).toContain('Too many');
    expect(rateLimited?.headers['retry-after']).toBeDefined();
  });
});
