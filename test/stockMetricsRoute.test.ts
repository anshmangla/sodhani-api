import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../src/app';
import { closeTestPool } from './helpers';
import { SEEDED_PEER_STOCK_METRICS } from './constants';

afterAll(closeTestPool);

// HDFCBANK -> fin_instrm_id 500180, seeded at cmp 1650 / pe 19 / mktCap 900000.
const HDFC = SEEDED_PEER_STOCK_METRICS['500180'];

describe('GET /api/metrics/:symbol', () => {
  it('404s for an unknown symbol', async () => {
    const res = await request(app).get('/api/metrics/NOPE');
    expect(res.status).toBe(404);
  });

  it('returns the stored metrics unchanged', async () => {
    const res = await request(app).get('/api/metrics/HDFCBANK');
    expect(res.status).toBe(200);
    expect(res.body['CMP']).toBe(HDFC.cmp);
    expect(res.body['P/E']).toBe(HDFC.pe);
    expect(res.body['Mkt Cap']).toBe(HDFC.mktCap);
    expect(res.body['Profit Var']).toBe(HDFC.profitVar);
  });

  it('derives the share count and EPS behind the stored pair', async () => {
    const res = await request(app).get('/api/metrics/HDFCBANK');
    expect(res.body['Shares']).toBeCloseTo(HDFC.mktCap / HDFC.cmp, 6);
    expect(res.body['EPS']).toBeCloseTo(HDFC.cmp / HDFC.pe, 6);
  });

  it('derives values that re-price back to the stored pair at the sync CMP', async () => {
    const res = await request(app).get('/api/metrics/HDFCBANK');
    // This is the property the frontend relies on: swapping the sync CMP for a
    // live quote price is the only thing that changes the displayed figures.
    expect(res.body['Shares'] * HDFC.cmp).toBeCloseTo(HDFC.mktCap, 4);
    expect(HDFC.cmp / res.body['EPS']).toBeCloseTo(HDFC.pe, 4);
  });

  it('resolves a BSE-only listing by its scrip code', async () => {
    const bse = SEEDED_PEER_STOCK_METRICS['888001'];
    const res = await request(app).get('/api/metrics/888001');
    expect(res.status).toBe(200);
    expect(res.body['Shares']).toBeCloseTo(bse.mktCap / bse.cmp, 6);
  });
});
