import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../src/app';
import { closeTestPool } from './helpers';

afterAll(closeTestPool);

// Regression test: search used to source companies from a CSV that carried
// every scraped company. After the switch to a live company_stock query
// (2c0880c/da88af8), BSE-only companies with no NSE ticker - e.g. the real
// "Sodhani Capital" (544560) - silently dropped out of search. '888001'
// ("Bse Only Peer Co") is the existing fixture for exactly this shape:
// a company_stock row with a null TckrSymb, findable only via its
// company_sectors row keyed by the raw BSE scrip code.
describe('GET /api/ra/companies (search)', () => {
  it('finds a BSE-only company (no NSE ticker) by name', async () => {
    const res = await request(app).get('/api/ra/companies?search=Bse Only Peer');
    expect(res.status).toBe(200);
    const codes = res.body.companies.map((c: { code: string }) => c.code);
    expect(codes).toContain('888001');
  });

  it('finds a BSE-only company by its scrip code', async () => {
    const res = await request(app).get('/api/ra/companies?search=888001');
    expect(res.status).toBe(200);
    const codes = res.body.companies.map((c: { code: string }) => c.code);
    expect(codes).toContain('888001');
  });

  it('does not duplicate a company that has both a company_stock and a company_sectors row', async () => {
    const res = await request(app).get('/api/ra/companies?search=HDFC Bank');
    expect(res.status).toBe(200);
    const codes = res.body.companies.map((c: { code: string }) => c.code);
    expect(codes.filter((c: string) => c === 'HDFCBANK')).toHaveLength(1);
  });
});
