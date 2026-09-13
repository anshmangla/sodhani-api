import request from 'supertest';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app } from '../src/app';
import { authHeader, raAuthHeader, clearCallsData, closeTestPool, testPool } from './helpers';
import { TEST_RA_ID, TEST_USER_ID } from './constants';

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
