import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../src/app';
import { closeTestPool } from './helpers';

afterAll(closeTestPool);

describe('GET /api/screener industry filter', () => {
  it('includes a company whose company_sectors row is keyed by ticker, not FinInstrmId', async () => {
    const res = await request(app).get('/api/screener?industry=IN777701');
    expect(res.status).toBe(200);
    const tickers = res.body.data.map((r: { TckrSymb: string }) => r.TckrSymb);
    expect(tickers).toContain('TICKERKEYED');
  });
});
