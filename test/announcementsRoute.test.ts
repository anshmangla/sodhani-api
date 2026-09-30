import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/app';
import { testPool, closeTestPool } from './helpers';

// RELIANCE (BSE 500325) is dual-listed in exchange_code_mappings.json; NSEONLYCO
// is an NSE-only fixture keyed by symbol, like the real NSE-only companies.
const DUAL_BSE_CODE = '500325';
const DUAL_NSE_SYMBOL = 'RELIANCE';
const NSE_ONLY = 'NSEONLYCO';

async function seed() {
  // bse_announcements / nse_announcements are scraper-owned (created by
  // sodhaniScrap's initDB), so the test DB creates the columns the API reads.
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS bse_announcements (
      newsid VARCHAR(255) PRIMARY KEY, scrip_cd VARCHAR(255), news_dt TIMESTAMP,
      newssub TEXT, headline TEXT, slongname TEXT, announcement_type VARCHAR(255),
      attachmentname TEXT, categoryname VARCHAR(255)
    )`);
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS nse_announcements (
      seq_id VARCHAR(64) PRIMARY KEY, symbol VARCHAR(64) NOT NULL, isin VARCHAR(32),
      company_name TEXT, an_dt TIMESTAMPTZ, category TEXT, description TEXT,
      attachment_url TEXT, attachment_size VARCHAR(32), has_xbrl BOOLEAN
    )`);
  await cleanup();

  await testPool.query(`
    INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric")
    VALUES ('${NSE_ONLY}', '${NSE_ONLY}', 'NSE Only Co', 0)
    ON CONFLICT DO NOTHING`);

  // BSE stores IST wall-clock time in a TIMESTAMP (no zone).
  await testPool.query(`
    INSERT INTO bse_announcements (newsid, scrip_cd, news_dt, newssub, headline, slongname, attachmentname, categoryname)
    VALUES
      ('T-BSE-1', '${DUAL_BSE_CODE}', '2026-09-16 17:39:56', 'Reliance - Allotment', 'BSE headline 1', 'Reliance Industries Ltd', 'abc.pdf', 'Company Update'),
      ('T-BSE-2', '${DUAL_BSE_CODE}', '2026-09-10 09:00:00', 'Reliance - Update',   'BSE headline 2', 'Reliance Industries Ltd', NULL,      'Company Update')`);

  // NSE stores a real instant. 17:42:10 IST = 12:12:10Z, i.e. later than the
  // BSE row at 17:39:56 IST - the merge has to order them by wall-clock IST.
  await testPool.query(`
    INSERT INTO nse_announcements (seq_id, symbol, company_name, an_dt, category, description, attachment_url)
    VALUES
      ('T-NSE-1', '${DUAL_NSE_SYMBOL}', 'Reliance Industries Limited', '2026-09-16T12:12:10Z', 'Conversion',
         'Reliance has informed the Exchange about Conversion', 'https://nsearchives.nseindia.com/corporate/x.pdf'),
      ('T-NSE-2', '${DUAL_NSE_SYMBOL}', 'Reliance Industries Limited', '2026-09-01T04:00:00Z', 'Updates',
         'Reliance has informed the Exchange regarding Update', 'https://nsearchives.nseindia.com/corporate/y.pdf'),
      ('T-NSE-3', '${NSE_ONLY}', 'NSE Only Co', '2026-09-20T05:00:00Z', 'Board Meeting',
         'NSE Only Co board meeting', 'https://nsearchives.nseindia.com/corporate/z.pdf')`);
}

async function cleanup() {
  await testPool.query(`DELETE FROM bse_announcements WHERE newsid LIKE 'T-BSE-%'`);
  await testPool.query(`DELETE FROM nse_announcements WHERE seq_id LIKE 'T-NSE-%'`);
  await testPool.query(`DELETE FROM company_stock WHERE "FinInstrmId" = '${NSE_ONLY}'`);
}

describe('GET /api/announcements/:symbol', () => {
  beforeAll(seed);
  afterAll(async () => {
    await cleanup();
    await closeTestPool();
  });

  it('merges BSE and NSE rows for a dual-listed stock, newest first, each tagged with its source', async () => {
    const res = await request(app).get(`/api/announcements/${DUAL_BSE_CODE}`);
    expect(res.status).toBe(200);
    const ids = res.body.announcements.map((a: { newsid: string }) => a.newsid);
    // 17:42 NSE > 17:39 BSE > 09-10 BSE > 09-01 NSE
    expect(ids).toEqual(['NSE-T-NSE-1', 'T-BSE-1', 'T-BSE-2', 'NSE-T-NSE-2']);
    expect(res.body.count).toBe(4);
    const sources = res.body.announcements.map((a: { source: string }) => a.source);
    expect(sources).toEqual(['NSE', 'BSE', 'BSE', 'NSE']);
  });

  it('shapes NSE rows like BSE rows so existing clients work unchanged', async () => {
    const res = await request(app).get(`/api/announcements/${DUAL_BSE_CODE}?source=nse`);
    const row = res.body.announcements[0];
    expect(row.attachmentname).toBe('https://nsearchives.nseindia.com/corporate/x.pdf');
    expect(row.categoryname).toBe('Conversion');
    expect(row.headline).toBe('Reliance has informed the Exchange about Conversion');
    expect(row.slongname).toBe('Reliance Industries Limited');
    expect(row.scrip_cd).toBe(DUAL_NSE_SYMBOL);
    // Same IST-wall-clock-with-"Z" convention BSE rows serialize with.
    expect(row.news_dt).toBe('2026-09-16T17:42:10.000Z');
    expect(row).not.toHaveProperty('_wall');
  });

  it('resolves an NSE symbol to the BSE feed too', async () => {
    const res = await request(app).get(`/api/announcements/${DUAL_NSE_SYMBOL}`);
    const ids = res.body.announcements.map((a: { newsid: string }) => a.newsid);
    expect(ids).toContain('T-BSE-1');
    expect(ids).toContain('NSE-T-NSE-1');
  });

  it('?source=bse and ?source=nse each return only their own feed', async () => {
    const bse = await request(app).get(`/api/announcements/${DUAL_BSE_CODE}?source=bse`);
    expect(bse.body.announcements.map((a: { source: string }) => a.source)).toEqual(['BSE', 'BSE']);
    const nse = await request(app).get(`/api/announcements/${DUAL_BSE_CODE}?source=nse`);
    expect(nse.body.announcements.map((a: { source: string }) => a.source)).toEqual(['NSE', 'NSE']);
  });

  it('serves an NSE-only stock from the NSE feed', async () => {
    const res = await request(app).get(`/api/announcements/${NSE_ONLY}`);
    expect(res.status).toBe(200);
    expect(res.body.announcements).toHaveLength(1);
    expect(res.body.announcements[0].newsid).toBe('NSE-T-NSE-3');
    expect(res.body.announcements[0].source).toBe('NSE');
  });

  it('applies the limit to the merged list, not per feed', async () => {
    const res = await request(app).get(`/api/announcements/${DUAL_BSE_CODE}?limit=3`);
    expect(res.body.announcements.map((a: { newsid: string }) => a.newsid)).toEqual([
      'NSE-T-NSE-1', 'T-BSE-1', 'T-BSE-2',
    ]);
  });

  it('returns an empty list for an unknown symbol', async () => {
    const res = await request(app).get('/api/announcements/NOSUCHSYMBOL');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, announcements: [] });
  });

  it('falls back to BSE-only when nse_announcements does not exist yet', async () => {
    await testPool.query('ALTER TABLE nse_announcements RENAME TO nse_announcements_off');
    try {
      const res = await request(app).get(`/api/announcements/${DUAL_BSE_CODE}`);
      expect(res.status).toBe(200);
      expect(res.body.announcements.map((a: { source: string }) => a.source)).toEqual(['BSE', 'BSE']);
    } finally {
      await testPool.query('ALTER TABLE nse_announcements_off RENAME TO nse_announcements');
    }
  });
});
