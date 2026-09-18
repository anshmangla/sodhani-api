import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { app } from '../src/app';
import { authHeader, raAuthHeader, clearCallsData, closeTestPool, testPool } from './helpers';
import { TEST_RA_ID, TEST_USER_ID } from './constants';

// A fixed, RFC-4122-shaped id (unlike TEST_RA_ID, which is deliberately not
// version-4 compliant) so it passes src/routes/analysts.ts's UUID_REGEX
// check on :id. Used by the "GET /api/analyst/*" describe blocks below,
// which exercise the new analyst-profile routes but still need to create
// research_calls rows - kept in this file (rather than test/analysts.test.ts)
// so they share this file's single clearCallsData beforeEach instead of
// racing a second file's clearCallsData against this one under vitest's
// default parallel file execution.
const FIXTURE_ANALYST_ID = '00000000-0000-4000-8000-000000000201';

beforeAll(async () => {
  await testPool.query(
    `INSERT INTO research_analysts (id, email, password_hash, full_name, designation, is_active, token_version)
     VALUES ($1, 'fixture-analyst-active@example.com', 'not-a-real-hash', 'Fixture Analyst', 'Chief Analyst', true, 0)
     ON CONFLICT (id) DO UPDATE SET is_active = true, token_version = 0`,
    [FIXTURE_ANALYST_ID]
  );
});

beforeEach(clearCallsData);
afterAll(closeTestPool);

function futureDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function pastDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

const raHeaders = () => raAuthHeader(TEST_RA_ID);

function baseEquity(overrides: Record<string, unknown> = {}) {
  return {
    scrip_code: 'RELIANCE',
    company_name: 'Reliance Industries Ltd',
    instrument_type: 'EQUITY',
    recommendation: 'Buy',
    entry_price_min: 2900,
    target_price: 3100,
    ...overrides,
  };
}

function baseFutures(overrides: Record<string, unknown> = {}) {
  return {
    scrip_code: 'RELIANCE',
    company_name: 'Reliance Industries Ltd',
    instrument_type: 'FUTURES',
    recommendation: 'Buy',
    expiry_date: futureDate(20),
    entry_price_min: 2900,
    target_price: 3100,
    ...overrides,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    scrip_code: 'RELIANCE',
    company_name: 'Reliance Industries Ltd',
    instrument_type: 'OPTIONS',
    recommendation: 'Buy',
    expiry_date: futureDate(20),
    strike_price: 3000,
    option_type: 'CE',
    entry_price_min: 45,
    target_price: 90,
    ...overrides,
  };
}

describe('POST /api/ra/calls — instrument types', () => {
  it('creates an Equity call with a single entry price', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseEquity());
    expect(res.status).toBe(201);
    expect(res.body.call.instrument_type).toBe('EQUITY');
    expect(Number(res.body.call.entry_price_min)).toBe(2900);
    expect(Number(res.body.call.entry_price_max)).toBe(2900);
    expect(res.body.call.buying_range).toBe('2900');
  });

  it('creates an Equity call with an entry price range', async () => {
    const res = await request(app)
      .post('/api/ra/calls')
      .set(raHeaders())
      .send(baseEquity({ entry_price_min: 100, entry_price_max: 105 }));
    expect(res.status).toBe(201);
    expect(res.body.call.buying_range).toBe('100-105');
    expect(Number(res.body.call.entry_price_min)).toBe(100);
    expect(Number(res.body.call.entry_price_max)).toBe(105);
  });

  it('creates a Futures call', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseFutures());
    expect(res.status).toBe(201);
    expect(res.body.call.instrument_type).toBe('FUTURES');
    expect(res.body.call.expiry_date).toBe(futureDate(20));
    expect(res.body.call.strike_price).toBeNull();
    expect(res.body.call.option_type).toBeNull();
  });

  it('creates an Options call', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseOptions());
    expect(res.status).toBe(201);
    expect(res.body.call.instrument_type).toBe('OPTIONS');
    expect(Number(res.body.call.strike_price)).toBe(3000);
    expect(res.body.call.option_type).toBe('CE');
  });

  it('rejects Options without a strike price', async () => {
    const body = baseOptions();
    delete (body as Record<string, unknown>).strike_price;
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(body);
    expect(res.status).toBe(400);
  });

  it('rejects Futures carrying a strike price', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseFutures({ strike_price: 3000 }));
    expect(res.status).toBe(400);
  });

  it('rejects Equity carrying an expiry date', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseEquity({ expiry_date: futureDate(20) }));
    expect(res.status).toBe(400);
  });

  it("rejects 'Hold' on Options", async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseOptions({ recommendation: 'Hold' }));
    expect(res.status).toBe(400);
  });

  it('rejects an expiry date in the past', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseFutures({ expiry_date: pastDate(5) }));
    expect(res.status).toBe(400);
  });

  it('rejects entry_price_max less than entry_price_min', async () => {
    const res = await request(app)
      .post('/api/ra/calls')
      .set(raHeaders())
      .send(baseEquity({ entry_price_min: 105, entry_price_max: 100 }));
    expect(res.status).toBe(400);
  });

  it('rejects an entry price range on Futures', async () => {
    const res = await request(app)
      .post('/api/ra/calls')
      .set(raHeaders())
      .send(baseFutures({ entry_price_min: 2900, entry_price_max: 2950 }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown holding_period', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseEquity({ holding_period: '6-9 months' }));
    expect(res.status).toBe(400);
  });

  it('accepts a valid holding_period', async () => {
    const res = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseEquity({ holding_period: 'Positional' }));
    expect(res.status).toBe(201);
    expect(res.body.call.holding_period).toBe('Positional');
  });
});

describe('GET /api/calls — paywalled instrument fields', () => {
  async function createPaidOptionsCall(): Promise<string> {
    const res = await request(app)
      .post('/api/ra/calls')
      .set(raHeaders())
      .send(baseOptions({ is_paid: true, price_paise: 5000, description: 'A short rationale.' }));
    expect(res.status).toBe(201);
    return res.body.call.id as string;
  }

  it('hides contract fields on a locked (unpurchased paid) call, but shows instrument_type', async () => {
    const callId = await createPaidOptionsCall();
    const res = await request(app).get(`/api/calls/${callId}`);
    expect(res.status).toBe(200);
    const call = res.body.call;
    expect(call.instrument_type).toBe('OPTIONS');
    expect(call.strike_price).toBeUndefined();
    expect(call.option_type).toBeUndefined();
    expect(call.expiry_date).toBeUndefined();
    expect(call.description).toBeUndefined();
    expect(call.recommendation).toBeUndefined();
  });

  it('reveals contract fields once purchased', async () => {
    const callId = await createPaidOptionsCall();

    const paymentId = '00000000-0000-0000-0000-0000000000f1';
    await testPool.query(
      `INSERT INTO payments (id, user_id, call_id, razorpay_order_id, amount_paise, status)
       VALUES ($1, $2, $3, 'order_test_1', 5250, 'paid')`,
      [paymentId, TEST_USER_ID, callId]
    );
    await testPool.query(
      `INSERT INTO purchased_calls (user_id, call_id, payment_id) VALUES ($1, $2, $3)`,
      [TEST_USER_ID, callId, paymentId]
    );

    const res = await request(app).get(`/api/calls/${callId}`).set(authHeader(TEST_USER_ID));
    expect(res.status).toBe(200);
    const call = res.body.call;
    expect(call.instrument_type).toBe('OPTIONS');
    expect(Number(call.strike_price)).toBe(3000);
    expect(call.option_type).toBe('CE');
    expect(call.description).toBe('A short rationale.');
    expect(call.recommendation).toBe('Buy');
  });
});

// ra_id is deliberately safe to expose on every call, even in the locked
// preview - it's how web/mobile link a call card to the public analyst
// profile page (GET /api/analyst/:id).
describe('GET /api/calls — ra_id exposure', () => {
  it('includes ra_id on both the list and detail views, so clients can link to the analyst profile', async () => {
    const createRes = await request(app).post('/api/ra/calls').set(raHeaders()).send(baseEquity());
    expect(createRes.status).toBe(201);
    const callId = createRes.body.call.id;

    const listRes = await request(app).get('/api/calls');
    expect(listRes.status).toBe(200);
    const listedCall = listRes.body.data.find((c: { id: string }) => c.id === callId);
    expect(listedCall.ra_id).toBe(TEST_RA_ID);

    const detailRes = await request(app).get(`/api/calls/${callId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.call.ra_id).toBe(TEST_RA_ID);
  });
});

describe('GET /api/analyst/:id — call stats', () => {
  it('returns total/open/closed call stats and no Buy/Hold/Sell breakdown', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/ra/calls')
        .set(raAuthHeader(FIXTURE_ANALYST_ID))
        .send(baseEquity());
      expect(res.status).toBe(201);
      created.push(res.body.call.id);
    }
    const closeRes = await request(app)
      .patch(`/api/ra/calls/${created[0]}/status`)
      .set(raAuthHeader(FIXTURE_ANALYST_ID))
      .send({ status: 'closed' });
    expect(closeRes.status).toBe(200);

    const res = await request(app).get(`/api/analyst/${FIXTURE_ANALYST_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.analyst.id).toBe(FIXTURE_ANALYST_ID);
    expect(res.body.analyst.name).toBe('Fixture Analyst');
    expect(res.body.analyst.stats).toEqual({ total_calls: 3, open_calls: 2, closed_calls: 1 });
    expect(res.body.analyst.member_since).toBeDefined();
    expect(res.body.analyst.recommendation).toBeUndefined();
    expect(res.body.analyst.stats.buy_calls).toBeUndefined();
  });
});

describe('GET /api/analyst/:id/calls — pagination', () => {
  it('paginates using the same page/limit convention as /api/calls', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/ra/calls')
        .set(raAuthHeader(FIXTURE_ANALYST_ID))
        .send(baseEquity());
      expect(res.status).toBe(201);
    }

    const fullRes = await request(app).get(`/api/analyst/${FIXTURE_ANALYST_ID}/calls`);
    expect(fullRes.status).toBe(200);
    expect(fullRes.body.data).toHaveLength(3);
    expect(fullRes.body.pagination).toEqual({ total: 3, page: 1, limit: 25, totalPages: 1 });

    const pagedRes = await request(app).get(`/api/analyst/${FIXTURE_ANALYST_ID}/calls?page=2&limit=1`);
    expect(pagedRes.status).toBe(200);
    expect(pagedRes.body.data).toHaveLength(1);
    expect(pagedRes.body.pagination).toEqual({ total: 3, page: 2, limit: 1, totalPages: 3 });
  });
});

describe('GET /api/analyst/:id/calls — paywalled fields via buildCallPayload', () => {
  it('hides paid contract fields until purchased, reusing calls.ts entitlement logic exactly', async () => {
    const createRes = await request(app)
      .post('/api/ra/calls')
      .set(raAuthHeader(FIXTURE_ANALYST_ID))
      .send(baseEquity({ is_paid: true, price_paise: 5000, description: 'A short rationale.' }));
    expect(createRes.status).toBe(201);
    const callId = createRes.body.call.id;

    const lockedRes = await request(app).get(`/api/analyst/${FIXTURE_ANALYST_ID}/calls`);
    expect(lockedRes.status).toBe(200);
    const lockedCall = lockedRes.body.data.find((c: { id: string }) => c.id === callId);
    expect(lockedCall.ra_id).toBe(FIXTURE_ANALYST_ID);
    expect(lockedCall.instrument_type).toBe('EQUITY');
    expect(lockedCall.recommendation).toBeUndefined();
    expect(lockedCall.description).toBeUndefined();

    const paymentId = '00000000-0000-0000-0000-0000000000f2';
    await testPool.query(
      `INSERT INTO payments (id, user_id, call_id, razorpay_order_id, amount_paise, status)
       VALUES ($1, $2, $3, 'order_test_2', 5250, 'paid')`,
      [paymentId, TEST_USER_ID, callId]
    );
    await testPool.query(`INSERT INTO purchased_calls (user_id, call_id, payment_id) VALUES ($1, $2, $3)`, [
      TEST_USER_ID,
      callId,
      paymentId,
    ]);

    const unlockedRes = await request(app)
      .get(`/api/analyst/${FIXTURE_ANALYST_ID}/calls`)
      .set(authHeader(TEST_USER_ID));
    expect(unlockedRes.status).toBe(200);
    const unlockedCall = unlockedRes.body.data.find((c: { id: string }) => c.id === callId);
    expect(unlockedCall.recommendation).toBe('Buy');
    expect(unlockedCall.description).toBe('A short rationale.');
  });
});
