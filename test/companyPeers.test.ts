import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../src/app';
import { closeTestPool } from './helpers';

afterAll(closeTestPool);

describe('GET /api/company/:symbol/peers', () => {
  it('404s for an unknown symbol', async () => {
    const res = await request(app).get('/api/company/NOPE/peers');
    expect(res.status).toBe(404);
  });

  it('resolves peers at the leaf level when it has enough companies, keyed by ticker', async () => {
    const res = await request(app).get('/api/company/HDFCBANK/peers');
    expect(res.status).toBe(200);
    expect(res.body.peerLevel).toBe('leaf');
    expect(res.body.classification.leaf.code).toBe('IN020101');
    const peerSymbols = res.body.peers.map((p: { symbol: string }) => p.symbol);
    expect(peerSymbols).toContain('ICICIBANK');
    expect(peerSymbols).toContain('AXISBANK');
    expect(peerSymbols).toContain('KOTAKBANK');
    expect(peerSymbols).not.toContain('HDFCBANK');
    expect(typeof res.body.industryPe).toBe('number');
  });

  it('resolves a BSE-only stock (numeric fin_instrm_id, null ticker) by its scrip code', async () => {
    const res = await request(app).get('/api/company/888001/peers');
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('888001');
    expect(res.body.peerLevel).toBe('leaf');
    const peerSymbols = res.body.peers.map((p: { symbol: string }) => p.symbol);
    expect(peerSymbols).toContain('HDFCBANK');
    expect(peerSymbols).not.toContain('888001');
  });

  it('falls back to the industry level when the leaf alone has too few peers', async () => {
    const res = await request(app).get('/api/company/SPARSECO/peers');
    expect(res.status).toBe(200);
    expect(res.body.peerLevel).toBe('industry');
    const peerSymbols = res.body.peers.map((p: { symbol: string }) => p.symbol).sort();
    expect(peerSymbols).toEqual(['SPARSEPEERA', 'SPARSEPEERB', 'SPARSEPEERC']);
  });

  it('returns null classification and empty peers for a stock with no company_sectors row, but still computes marketCapCategory', async () => {
    const res = await request(app).get('/api/company/NOCLASS/peers');
    expect(res.status).toBe(200);
    expect(res.body.classification).toBeNull();
    expect(res.body.peers).toEqual([]);
    expect(res.body.industryPe).toBeNull();
    expect(res.body.peerLevel).toBe('none');
    expect(res.body.marketCapCategory).not.toBeNull();
  });
});
