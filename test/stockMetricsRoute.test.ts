import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../src/app';
import { closeTestPool } from './helpers';
import { SEEDED_PEER_STOCK_METRICS, SEEDED_DUPLICATE_METRICS } from './constants';

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

// stock_metrics carries two rows for some companies - one keyed by ticker, one
// by numeric BSE code, written by different metricsSync runs and independently
// stale. /api/screener and /api/company/:symbol/peers both already pin this
// down with `ORDER BY mkt_cap DESC NULLS LAST`; this route used to take a bare
// `LIMIT 1` and could serve the other row, so the same stock showed one P/E on
// the screener list and a different one on its own detail view.
describe('GET /api/metrics/:symbol with duplicate stock_metrics rows', () => {
  const { symbol, finInstrmId, fresh, stale } = SEEDED_DUPLICATE_METRICS;

  it('resolves the same row by ticker and by scrip code', async () => {
    const byTicker = await request(app).get(`/api/metrics/${symbol}`);
    const byCode = await request(app).get(`/api/metrics/${finInstrmId}`);
    expect(byTicker.status).toBe(200);
    expect(byCode.status).toBe(200);
    expect(byTicker.body['P/E']).toBe(byCode.body['P/E']);
    expect(byTicker.body['CMP']).toBe(byCode.body['CMP']);
    expect(byTicker.body['Mkt Cap']).toBe(byCode.body['Mkt Cap']);
  });

  it('picks the highest-mkt_cap row, matching /api/screener and /peers', async () => {
    const res = await request(app).get(`/api/metrics/${symbol}`);
    expect(res.body['Mkt Cap']).toBe(fresh.mktCap);
    expect(res.body['P/E']).toBe(fresh.pe);
    expect(res.body['CMP']).toBe(fresh.cmp);
    expect(res.body['P/E']).not.toBe(stale.pe);
  });

  it('agrees with the P/E /api/screener serves for the same company', async () => {
    const metrics = await request(app).get(`/api/metrics/${symbol}`);
    const screener = await request(app).get('/api/screener?limit=100');
    const row = screener.body.data.find(
      (r: { TckrSymb: string }) => r.TckrSymb === symbol
    );
    expect(row).toBeDefined();
    expect(Number(row.pe)).toBe(metrics.body['P/E']);
    expect(Number(row.cmp)).toBe(metrics.body['CMP']);
  });

  it('derives EPS against the CMP of the row it actually served', async () => {
    // Guards the cross-row mismatch this bug could produce: an EPS derived
    // from one row's CMP and another row's P/E is a number for no company.
    const res = await request(app).get(`/api/metrics/${symbol}`);
    expect(res.body['EPS']).toBeCloseTo(fresh.cmp / fresh.pe, 6);
    expect(res.body['Shares']).toBeCloseTo(fresh.mktCap / fresh.cmp, 6);
  });
});
