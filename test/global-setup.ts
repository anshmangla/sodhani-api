import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  testDbUrl,
  adminDbUrl,
  TEST_USER_ID,
  TEST_USER2_ID,
  TEST_RA_ID,
  TEST_RA2_ID,
  SEEDED_STOCKS,
  SEEDED_PEER_COMPANY_STOCKS,
  SEEDED_PEER_STOCK_METRICS,
  SEEDED_COMPANY_SECTORS,
  SEEDED_DUPLICATE_METRICS,
} from './constants';

// One-time setup, run by vitest in a separate process before any test file:
//   1. create the test database if it doesn't exist
//   2. create the scraper-owned market tables (company_stock / historical_prices)
//   3. apply db/migrations/*.sql in lexical order
//   4. seed test users + market data
export default async function globalSetup() {
  const dbName = new URL(testDbUrl()).pathname.slice(1);

  // 1. Create the test DB against the admin/maintenance database.
  const admin = new Pool({ connectionString: adminDbUrl() });
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    dbName,
  ]);
  if (exists.rows.length === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`[setup] created database ${dbName}`);
  }
  await admin.end();

  const db = new Pool({ connectionString: testDbUrl() });

  // 2. Create the scraper-owned market tables the API queries join against.
  //    These are owned by sodhaniScrap and are NOT in db/migrations, so the test
  //    DB needs them created explicitly (only the columns the API actually uses).
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_stock (
      "FinInstrmId" VARCHAR(50) PRIMARY KEY,
      "TckrSymb"    VARCHAR(50),
      "FinInstrmNm" TEXT,
      "LastPric"    NUMERIC
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS historical_prices (
      "FinInstrmId" VARCHAR(50),
      record_date   TIMESTAMP WITHOUT TIME ZONE,
      open_price    NUMERIC,
      high_price    NUMERIC,
      low_price     NUMERIC,
      close_price   NUMERIC,
      volume        BIGINT,
      -- Official exchange previous close, written by the scraper onto the
      -- session's own rows (db/migrations/0011). Day-change is measured
      -- against this, falling back to the prior day's close when it's absent.
      prev_close    NUMERIC
    )`);
  await db.query(`
    ALTER TABLE historical_prices
      ADD COLUMN IF NOT EXISTS high_price NUMERIC,
      ADD COLUMN IF NOT EXISTS low_price  NUMERIC,
      ADD COLUMN IF NOT EXISTS volume     BIGINT
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_hist_fininstrm
     ON historical_prices ("FinInstrmId", record_date)`
  );

  // stock_metrics / company_sectors: also scraper-owned, also absent from
  // db/migrations - same reasoning as company_stock/historical_prices above.
  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_metrics (
      symbol      VARCHAR(50) PRIMARY KEY,
      cmp         NUMERIC,
      pe          NUMERIC,
      mkt_cap     NUMERIC,
      div_yld     NUMERIC,
      np_qtr      NUMERIC,
      profit_var  NUMERIC,
      sales_qtr   NUMERIC,
      sales_var   NUMERIC,
      roce        NUMERIC
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_sectors (
      fin_instrm_id  VARCHAR(50) PRIMARY KEY,
      company_name   VARCHAR(255),
      sector_name    VARCHAR(255),
      industry_name  VARCHAR(255),
      leaf_name      VARCHAR(255),
      sector_code    VARCHAR(50),
      industry_code  VARCHAR(50),
      leaf_code      VARCHAR(50)
    )`);

  // 3. Apply migrations. Must run AFTER the scraper-owned tables above:
  //    0010 adds a foreign key to company_stock and 0011 alters
  //    historical_prices, so neither can be applied to an empty database.
  const migrationsDir = join(__dirname, '..', 'db', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  // 4. Seed users.
  await db.query(
    `INSERT INTO users (id, name, phone_number, token_version)
     VALUES ($1, 'Test User', '+919999999991', 0)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID]
  );
  await db.query(
    `INSERT INTO users (id, name, phone_number, token_version)
     VALUES ($1, 'Test User Two', '+919999999992', 0)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER2_ID]
  );
  await db.query(
    `INSERT INTO research_analysts (id, email, password_hash, full_name, token_version)
     VALUES ($1, 'test-ra@example.com', 'not-a-real-hash', 'Test RA', 0)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_RA_ID]
  );
  await db.query(
    `INSERT INTO research_analysts (id, email, password_hash, full_name, token_version)
     VALUES ($1, 'test-ra-2@example.com', 'not-a-real-hash', 'Test RA Two', 0)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_RA2_ID]
  );

  // 5. Seed market data.
  for (const s of SEEDED_STOCKS) {
    await db.query(
      `INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [s.finInstrmId, s.symbol, s.name, s.close ?? 0]
    );
    if (s.open !== null && s.close !== null) {
      await db.query(
        `INSERT INTO historical_prices ("FinInstrmId", record_date, open_price, close_price, prev_close)
         VALUES ($1, '2026-08-20', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [s.finInstrmId, s.open, s.close, s.prevClose]
      );
    }
    // An earlier bar, so stocks whose session rows carry no prev_close have a
    // prior close to fall back to.
    if (s.prevDayClose !== null) {
      await db.query(
        `INSERT INTO historical_prices ("FinInstrmId", record_date, open_price, close_price, prev_close)
         VALUES ($1, '2026-08-19', $2, $2, NULL)
         ON CONFLICT DO NOTHING`,
        [s.finInstrmId, s.prevDayClose]
      );
    }
  }

  // 6. Seed peer-comparison fixtures (see test/constants.ts for what each
  //    row is for).
  for (const s of SEEDED_PEER_COMPANY_STOCKS) {
    await db.query(
      `INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric")
       VALUES ($1, $2, $3, 0)
       ON CONFLICT DO NOTHING`,
      [s.finInstrmId, s.symbol, s.name]
    );
    const metrics = SEEDED_PEER_STOCK_METRICS[s.finInstrmId];
    if (metrics) {
      await db.query(
        `INSERT INTO stock_metrics (symbol, cmp, pe, mkt_cap, profit_var)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (symbol) DO NOTHING`,
        [s.finInstrmId, metrics.cmp, metrics.pe, metrics.mktCap, metrics.profitVar]
      );
    }
  }
  for (const c of SEEDED_COMPANY_SECTORS) {
    await db.query(
      `INSERT INTO company_sectors
         (fin_instrm_id, company_name, sector_code, sector_name, industry_code, industry_name, leaf_code, leaf_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (fin_instrm_id) DO NOTHING`,
      [c.finInstrmId, c.companyName, c.sectorCode, c.sectorName, c.industryCode, c.industryName, c.leafCode, c.leafName]
    );
  }

  // 7. Seed the join-fix regression fixture: a company_sectors row keyed by
  //    ticker (not FinInstrmId) - the exact shape that let /api/screener's
  //    industry filter silently exclude large-caps like RELIANCE/TCS/
  //    SUNPHARMA before the dual-format join fix.
  await db.query(
    `INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric")
     VALUES ('777001', 'TICKERKEYED', 'Ticker Keyed Co', 0)
     ON CONFLICT DO NOTHING`
  );
  await db.query(
    `INSERT INTO stock_metrics (symbol, cmp, pe, mkt_cap, profit_var)
     VALUES ('777001', 100, 10, 5000, 1.0)
     ON CONFLICT (symbol) DO NOTHING`
  );
  await db.query(
    `INSERT INTO company_sectors
       (fin_instrm_id, company_name, sector_code, sector_name, industry_code, industry_name, leaf_code, leaf_name)
     VALUES ('TICKERKEYED', 'Ticker Keyed Co', 'IN77', 'Test Sector', 'IN7777', 'Test Industry', 'IN777701', 'Test Leaf')
     ON CONFLICT (fin_instrm_id) DO NOTHING`
  );

  // 8. Seed the duplicate-row regression fixture: one company_stock row with
  //    TWO stock_metrics rows (one keyed by BSE code, one by ticker), which is
  //    what /api/metrics used to resolve arbitrarily via a bare LIMIT 1.
  await db.query(
    `INSERT INTO company_stock ("FinInstrmId", "TckrSymb", "FinInstrmNm", "LastPric")
     VALUES ($1, $2, $3, 0)
     ON CONFLICT DO NOTHING`,
    [SEEDED_DUPLICATE_METRICS.finInstrmId, SEEDED_DUPLICATE_METRICS.symbol, SEEDED_DUPLICATE_METRICS.name]
  );
  // Insertion order matters: the stale row goes in FIRST so an unordered
  // `LIMIT 1` seq-scans straight into it. That is the production ordering too
  // (the ticker-keyed row predates the code-keyed one), and without it this
  // fixture silently passes against the bug it is meant to catch.
  for (const [key, m] of [
    [SEEDED_DUPLICATE_METRICS.symbol, SEEDED_DUPLICATE_METRICS.stale],
    [SEEDED_DUPLICATE_METRICS.finInstrmId, SEEDED_DUPLICATE_METRICS.fresh],
  ] as const) {
    await db.query(
      `INSERT INTO stock_metrics (symbol, cmp, pe, mkt_cap, profit_var)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (symbol) DO NOTHING`,
      [key, m.cmp, m.pe, m.mktCap, m.profitVar]
    );
  }

  await db.end();
  console.log('[setup] test database ready');
}
