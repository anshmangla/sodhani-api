import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearResponseCache, responseCache } from '../src/middleware/responseCache';

// A stand-alone app so the middleware is tested without the database.
let calls = 0;
const app = express();
app.use('/api', responseCache);
app.get('/api/top-gainers', (_req, res) => {
  calls += 1;
  res.json({ calls });
});
app.get('/api/metrics/:symbol', (req, res) => {
  calls += 1;
  if (req.params.symbol === 'bad') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ symbol: req.params.symbol, calls });
});
app.get('/api/watchlist', (_req, res) => {
  calls += 1;
  res.json({ calls });
});

beforeAll(() => {
  process.env.RESPONSE_CACHE_IN_TESTS = '1';
});
afterAll(() => {
  delete process.env.RESPONSE_CACHE_IN_TESTS;
});
beforeEach(() => {
  calls = 0;
  clearResponseCache();
});

describe('responseCache', () => {
  it('serves repeat requests from memory and sets Cache-Control', async () => {
    const first = await request(app).get('/api/top-gainers?limit=50');
    expect(first.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=300');
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await request(app).get('/api/top-gainers?limit=50');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
    expect(calls).toBe(1);
  });

  it('keys on the full URL including the query string', async () => {
    await request(app).get('/api/top-gainers?limit=10');
    await request(app).get('/api/top-gainers?limit=50');
    expect(calls).toBe(2);
  });

  it('uses the longer TTL for daily data', async () => {
    const res = await request(app).get('/api/metrics/500325');
    expect(res.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=3000');
  });

  it('never caches error responses', async () => {
    const a = await request(app).get('/api/metrics/bad');
    const b = await request(app).get('/api/metrics/bad');
    expect(a.status).toBe(404);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(b.headers['x-cache']).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('leaves paths outside the rules untouched', async () => {
    const a = await request(app).get('/api/watchlist');
    await request(app).get('/api/watchlist');
    expect(a.headers['cache-control']).toBeUndefined();
    expect(calls).toBe(2);
  });
});
