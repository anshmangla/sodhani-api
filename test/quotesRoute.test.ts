import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/app';
import { testPool, closeTestPool } from './helpers';

// Fixtures for the latest-day / previous-close logic shared by /api/quote and
// /api/quotes (LATEST_DAY_LATERALS in src/routes/market.ts). Own codes so they
// can't collide with the shared seed data.
const INTRADAY = { id: '999101', symbol: 'QTINTRA' };   // ticks today, no prev_close on them
const WITH_PREV = { id: '999102', symbol: 'QTPREV' };   // today's rows carry the exchange prev_close
const EOD_ONLY = { id: '999103', symbol: 'QTEOD' };     // midnight EOD bars only, with a gap
const NO_HISTORY = { id: '999104', symbol: 'QTNONE' };  // listed, no bars yet
const ALL = [INTRADAY, WITH_PREV, EOD_ONLY, NO_HISTORY];

const CORE_FIELDS = [
  'FinInstrmId', 'TckrSymb', 'LastPric', 'TtlTradgVol', 'TradDt', 'OpenPric',
  'HighPric', 'LowPric', 'ClosePric', 'PrevClosePric', 'ChangeVal', 'ChangePercent',
];

function core(row: Record<string, unknown>) {
  return Object.fromEntries(CORE_FIELDS.map((k) => [k, row[k]]));
}

describe('latest-day quote logic', () => {
  beforeAll(async () => {
    const ids = ALL.map((s) => s.id);
    await testPool.query(`DELETE FROM historical_prices WHERE "FinInstrmId" = ANY($1)`, [ids]);
    await testPool.query(`DELETE FROM company_stock WHERE "FinInstrmId" = ANY($1)`, [ids]);
    for (const s of ALL) {
      await testPool.query(
        `INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric") VALUES ($1, $2, $3, 0)`,
        [s.id, s.symbol, `${s.symbol} Ltd`]
      );
    }

    // INTRADAY: the previous day has both a midnight EOD bar (close 100) and a
    // later intraday tick (close 105); the EOD bar must win as prev close.
    await testPool.query(
      `INSERT INTO historical_prices ("FinInstrmId", record_date, open_price, high_price, low_price, close_price, volume, prev_close)
       VALUES
         ($1, '2026-10-15 00:00:00',  90,  92,  88,  91, 1000, NULL),
         ($1, '2026-10-16 00:00:00',  98, 101,  97, 100, 2000, NULL),
         ($1, '2026-10-16 14:00:00', 104, 106, 103, 105,  300, NULL),
         ($1, '2026-10-19 09:30:00', 110, 112, 109, 111,  400, NULL),
         ($1, '2026-10-19 11:00:00', 111, 120, 108, 118,  500, NULL),
         ($1, '2026-10-19 15:30:00', 118, 119, 115, 116,  600, NULL)`,
      [INTRADAY.id]
    );

    // WITH_PREV: today's rows carry the exchange's prev_close, which wins over
    // the previous day's close.
    await testPool.query(
      `INSERT INTO historical_prices ("FinInstrmId", record_date, open_price, high_price, low_price, close_price, volume, prev_close)
       VALUES
         ($1, '2026-10-16 00:00:00', 50, 51, 49, 50, 100, NULL),
         ($1, '2026-10-19 10:00:00', 52, 55, 51, 54, 200, 49.5),
         ($1, '2026-10-19 12:00:00', 54, 56, 53, 55, 300, 49.5)`,
      [WITH_PREV.id]
    );

    // EOD_ONLY: one bar per day with a gap, so "previous day" is the last
    // earlier day that has a bar, not the calendar day before.
    await testPool.query(
      `INSERT INTO historical_prices ("FinInstrmId", record_date, open_price, high_price, low_price, close_price, volume, prev_close)
       VALUES
         ($1, '2026-10-09 00:00:00', 10, 11,  9, 10, 50, NULL),
         ($1, '2026-10-12 00:00:00', 11, 13, 10, 12, 60, NULL),
         ($1, '2026-10-19 00:00:00', 12, 15, 12, 14, 70, NULL)`,
      [EOD_ONLY.id]
    );
  });

  afterAll(async () => {
    const ids = ALL.map((s) => s.id);
    await testPool.query(`DELETE FROM historical_prices WHERE "FinInstrmId" = ANY($1)`, [ids]);
    await testPool.query(`DELETE FROM company_stock WHERE "FinInstrmId" = ANY($1)`, [ids]);
    await closeTestPool();
  });

  it('aggregates every bar on the latest day and prefers the prior day\'s EOD bar as prev close', async () => {
    const res = await request(app).get(`/api/quote/${INTRADAY.symbol}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.OpenPric)).toBe(110);
    expect(Number(res.body.HighPric)).toBe(120);
    expect(Number(res.body.LowPric)).toBe(108);
    expect(Number(res.body.ClosePric)).toBe(116);
    expect(Number(res.body.TtlTradgVol)).toBe(1500);
    expect(Number(res.body.PrevClosePric)).toBe(100);
    expect(res.body.ChangeVal).toBeCloseTo(16, 6);
    expect(res.body.ChangePercent).toBeCloseTo(16, 6);
  });

  it('uses the exchange prev_close stored on the latest day when present', async () => {
    const res = await request(app).get(`/api/quote/${WITH_PREV.id}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.OpenPric)).toBe(52);
    expect(Number(res.body.ClosePric)).toBe(55);
    expect(Number(res.body.TtlTradgVol)).toBe(500);
    expect(Number(res.body.PrevClosePric)).toBe(49.5);
  });

  it('takes the last earlier day with a bar as the previous day', async () => {
    const res = await request(app).get(`/api/quote/${EOD_ONLY.symbol}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.ClosePric)).toBe(14);
    expect(Number(res.body.TtlTradgVol)).toBe(70);
    expect(Number(res.body.PrevClosePric)).toBe(12);
  });

  it('returns a listed instrument with no bars, with null price fields', async () => {
    const res = await request(app).get(`/api/quote/${NO_HISTORY.symbol}`);
    expect(res.status).toBe(200);
    expect(res.body.FinInstrmId).toBe(NO_HISTORY.id);
    expect(res.body.ClosePric).toBeNull();
    expect(res.body.TradDt).toBeNull();
    expect(res.body.PrevClosePric).toBeNull();
  });

  it('/api/quotes returns the same rows as /api/quote, by ticker or code, omitting unknown codes', async () => {
    const codes = [INTRADAY.symbol, WITH_PREV.id, EOD_ONLY.symbol.toLowerCase(), NO_HISTORY.id, 'NOSUCHCODE'];
    const batch = await request(app).get(`/api/quotes?codes=${codes.join(',')}`);
    expect(batch.status).toBe(200);
    expect(batch.body.count).toBe(4);

    for (const s of ALL) {
      const single = await request(app).get(`/api/quote/${s.id}`);
      const row = batch.body.quotes.find((q: { FinInstrmId: string }) => q.FinInstrmId === s.id);
      expect(row, s.symbol).toBeDefined();
      expect(core(row)).toEqual(core(single.body));
    }
  });
});
