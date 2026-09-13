import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/app';
import { testPool, closeTestPool } from './helpers';

describe('Volume API Routes', () => {
  beforeAll(async () => {
    // Ensure historical_prices has all columns in test DB
    await testPool.query(`
      ALTER TABLE historical_prices
        ADD COLUMN IF NOT EXISTS high_price NUMERIC,
        ADD COLUMN IF NOT EXISTS low_price  NUMERIC,
        ADD COLUMN IF NOT EXISTS volume     BIGINT
    `);

    // Clean any prior volume rows for test fixtures
    await testPool.query(`DELETE FROM bse_volume_history WHERE scrip_cd IN ('500325', '500012')`);
    await testPool.query(`DELETE FROM nse_volume_history WHERE symbol IN ('RELIANCE')`);

    // Ensure 500012 is in company_stock for symbol lookup fallback
    await testPool.query(`
      INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric")
      VALUES ('500012', 'ANDHRAPET', 'Andhra Petrochemicals Ltd', 100)
      ON CONFLICT ("FinInstrmId") DO NOTHING
    `);

    // Seed BSE volume history for 500325 (RELIANCE)
    // 2026-09-11 and 2026-09-10 are in the same week (week starts 2026-09-07)
    // 2026-09-03 is in the previous week (week starts 2026-08-31)
    await testPool.query(`
      INSERT INTO bse_volume_history (scrip_cd, record_date, volume, delivery_qty, delivery_val, turnover, delivery_pct)
      VALUES
        ('500325', '2026-09-11', 100000, 60000, 180000000.00, 300000000.00, 60.00),
        ('500325', '2026-09-10', 80000, 40000, 120000000.00, 240000000.00, 50.00),
        ('500325', '2026-09-03', 90000, 45000, 135000000.00, 270000000.00, 50.00)
    `);

    // Seed NSE volume history for RELIANCE
    await testPool.query(`
      INSERT INTO nse_volume_history (symbol, series, record_date, volume, delivery_qty, delivery_pct, turnover, no_of_trades)
      VALUES
        ('RELIANCE', 'EQ', '2026-09-11', 400000, 240000, 60.00, 1200000000.00, 150000),
        ('RELIANCE', 'EQ', '2026-09-10', 320000, 160000, 50.00, 960000000.00, 120000),
        ('RELIANCE', 'EQ', '2026-09-03', 360000, 180000, 50.00, 1080000000.00, 130000)
    `);

    // Seed BSE-only volume history for 500012
    await testPool.query(`
      INSERT INTO bse_volume_history (scrip_cd, record_date, volume, delivery_qty, delivery_val, turnover, delivery_pct)
      VALUES
        ('500012', '2026-09-11', 5000, 3000, 300000.00, 500000.00, 60.00)
    `);
  });

  afterAll(async () => {
    await testPool.query(`DELETE FROM bse_volume_history WHERE scrip_cd IN ('500325', '500012')`);
    await testPool.query(`DELETE FROM nse_volume_history WHERE symbol IN ('RELIANCE')`);
    await closeTestPool();
  });

  describe('GET /api/volume/:symbol', () => {
    it('returns 404 for an unknown symbol', async () => {
      const res = await request(app).get('/api/volume/UNKNOWN_SYMBOL_999');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/No volume history found/);
    });

    it('returns combined volume and delivery metrics for a dual-listed stock queried by BSE scrip code', async () => {
      const res = await request(app).get('/api/volume/500325?range=1d');
      expect(res.status).toBe(200);
      expect(res.body.symbol).toBe('500325');
      expect(res.body.is_dual_listed).toBe(true);
      expect(res.body.exchange_codes).toEqual({
        bse: '500325',
        nse: 'RELIANCE',
      });
      expect(res.body.count).toBe(1);

      const latest = res.body.history[0];
      expect(latest.time).toBe('2026-09-11');
      // 100,000 (BSE) + 400,000 (NSE) = 500,000
      expect(Number(latest.combined_volume)).toBe(500000);
      // 60,000 (BSE) + 240,000 (NSE) = 300,000
      expect(Number(latest.combined_delivery_qty)).toBe(300000);
      // (300,000 / 500,000) * 100 = 60.00%
      expect(Number(latest.combined_delivery_pct)).toBe(60.0);
      // 300,000,000 (BSE) + 1,200,000,000 (NSE) = 1,500,000,000
      expect(Number(latest.combined_turnover)).toBe(1500000000);

      // BSE breakdown
      expect(Number(latest.bse.volume)).toBe(100000);
      expect(Number(latest.bse.delivery_qty)).toBe(60000);
      expect(Number(latest.bse.delivery_pct)).toBe(60.0);

      // NSE breakdown
      expect(Number(latest.nse.volume)).toBe(400000);
      expect(Number(latest.nse.delivery_qty)).toBe(240000);
      expect(Number(latest.nse.delivery_pct)).toBe(60.0);
    });

    it('returns identical combined results when queried by NSE ticker', async () => {
      const res = await request(app).get('/api/volume/RELIANCE?range=1d');
      expect(res.status).toBe(200);
      expect(res.body.is_dual_listed).toBe(true);
      expect(res.body.exchange_codes).toEqual({
        bse: '500325',
        nse: 'RELIANCE',
      });
      expect(Number(res.body.history[0].combined_volume)).toBe(500000);
      expect(Number(res.body.history[0].combined_delivery_qty)).toBe(300000);
    });

    it('handles BSE-only stocks with is_dual_listed=false and nse=null', async () => {
      const res = await request(app).get('/api/volume/500012?range=1d');
      expect(res.status).toBe(200);
      expect(res.body.is_dual_listed).toBe(false);
      expect(res.body.exchange_codes.bse).toBe('500012');
      expect(res.body.exchange_codes.nse).toBeNull();

      const latest = res.body.history[0];
      expect(Number(latest.combined_volume)).toBe(5000);
      expect(Number(latest.bse.volume)).toBe(5000);
      expect(latest.nse).toBeNull();
    });

    it('filters correctly by start_date and end_date', async () => {
      const res = await request(app).get(
        '/api/volume/RELIANCE?start_date=2026-09-10&end_date=2026-09-11'
      );
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.history[0].time).toBe('2026-09-11');
      expect(res.body.history[1].time).toBe('2026-09-10');
    });

    it('applies weekly bucketing for 1y range', async () => {
      const res = await request(app).get('/api/volume/RELIANCE?range=1y');
      expect(res.status).toBe(200);
      // 2026-09-10 and 2026-09-11 bucket into week 2026-09-07
      // 2026-09-03 buckets into week 2026-08-31
      expect(res.body.count).toBe(2);

      const week1 = res.body.history[0];
      expect(week1.time).toBe('2026-09-07');
      // Day 1: 500k, Day 2: (80k + 320k = 400k) => Total = 900,000
      expect(Number(week1.combined_volume)).toBe(900000);
      // Day 1 delivery: 300k, Day 2 delivery: (40k + 160k = 200k) => Total = 500,000
      expect(Number(week1.combined_delivery_qty)).toBe(500000);
      // Weighted delivery pct: (500,000 / 900,000) * 100 = 55.56%
      expect(Number(week1.combined_delivery_pct)).toBeCloseTo(55.56, 1);
    });

    it('downsamples line chart data when chartType=line', async () => {
      const res = await request(app).get('/api/volume/RELIANCE?chartType=line&range=1m');
      expect(res.status).toBe(200);
      expect(res.body.history.length).toBeGreaterThan(0);
      const point = res.body.history[0];
      expect(point).toHaveProperty('time');
      expect(point).toHaveProperty('combined_volume');
      // Candlestick-only fields should not be in line points
      expect(point.bse).toBeUndefined();
      expect(point.nse).toBeUndefined();
      expect(point.combined_delivery_qty).toBeUndefined();
    });

    it('returns raw daily bars for range=max instead of monthly buckets when under threshold', async () => {
      const res = await request(app).get('/api/volume/RELIANCE?range=max');
      expect(res.status).toBe(200);
      expect(res.body.range).toBe('max');
      // Must NOT be grouped into a single monthly bucket; returns all 3 individual daily bars
      expect(res.body.count).toBe(3);
      expect(res.body.history).toHaveLength(3);
      expect(res.body.history[0].time).toBe('2026-09-11');
      expect(res.body.history[1].time).toBe('2026-09-10');
      expect(res.body.history[2].time).toBe('2026-09-03');
      // Bar-chart fields are fully populated
      expect(res.body.history[0].bse).toBeDefined();
      expect(res.body.history[0].nse).toBeDefined();
      expect(Number(res.body.history[0].combined_volume)).toBe(500000);
    });

    it('downsamples to suitable bars via algorithm for range=max when rows exceed downsample threshold', async () => {
      // Seed 30 daily rows for 500012
      const dates = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(2026, 0, 1 + i);
        return d.toISOString().split('T')[0];
      });
      for (let i = 0; i < dates.length; i++) {
        await testPool.query(`
          INSERT INTO bse_volume_history (scrip_cd, record_date, volume, delivery_qty, delivery_val, turnover, delivery_pct)
          VALUES ('500012', $1, $2, $3, 10000.0, 20000.0, 50.0)
          ON CONFLICT (scrip_cd, record_date) DO UPDATE SET volume = EXCLUDED.volume
        `, [dates[i], (i + 1) * 1000, (i + 1) * 500]);
      }

      const res = await request(app).get('/api/volume/500012?range=max&downsample=20');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(20);
      expect(res.body.history).toHaveLength(20);

      // Verify that newest date (2026-09-11 from beforeAll) and earliest date (2026-01-01) are preserved
      expect(res.body.history[0].time).toBe('2026-09-11');
      expect(res.body.history[19].time).toBe(dates[0]);

      // Verify bar fields are present
      expect(res.body.history[0].bse).toBeDefined();
      expect(res.body.history[0].combined_volume).toBeGreaterThan(0);
    });

    it('returns raw daily bars for range=5y when under threshold', async () => {
      const res = await request(app).get('/api/volume/RELIANCE?range=5y');
      expect(res.status).toBe(200);
      expect(res.body.range).toBe('5y');
      expect(res.body.count).toBe(3);
      expect(res.body.history).toHaveLength(3);
      expect(res.body.history[0].time).toBe('2026-09-11');
      expect(res.body.history[1].time).toBe('2026-09-10');
      expect(res.body.history[2].time).toBe('2026-09-03');
      expect(res.body.history[0].bse).toBeDefined();
      expect(res.body.history[0].nse).toBeDefined();
    });

    it('downsamples to suitable bars via algorithm for range=5y when rows exceed downsample threshold', async () => {
      const res = await request(app).get('/api/volume/500012?range=5y&downsample=20');
      expect(res.status).toBe(200);
      expect(res.body.range).toBe('5y');
      expect(res.body.count).toBe(20);
      expect(res.body.history).toHaveLength(20);
      expect(res.body.history[0].time).toBe('2026-09-11');
      expect(res.body.history[0].bse).toBeDefined();
      expect(res.body.history[0].combined_volume).toBeGreaterThan(0);
    });
  });

  describe('GET /api/quote/:symbol (Enriched with Volume)', () => {
    it('returns combined and per-exchange volume fields on quotes', async () => {
      const res = await request(app).get('/api/quote/RELIANCE');
      expect(res.status).toBe(200);
      expect(res.body.TckrSymb).toBe('RELIANCE');
      expect(res.body.IsDualListed).toBe(true);
      expect(Number(res.body.CombinedVolume)).toBe(500000);
      expect(Number(res.body.BseVolume)).toBe(100000);
      expect(Number(res.body.NseVolume)).toBe(400000);
      expect(Number(res.body.DeliveryQty)).toBe(300000);
      expect(Number(res.body.DeliveryPct)).toBe(60.0);
    });
  });
});
