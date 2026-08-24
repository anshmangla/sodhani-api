import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  testDbUrl,
  adminDbUrl,
  TEST_USER_ID,
  TEST_USER2_ID,
  SEEDED_STOCKS,
} from './constants';

// One-time setup, run by vitest in a separate process before any test file:
//   1. create the test database if it doesn't exist
//   2. apply db/migrations/*.sql in lexical order
//   3. seed test users + market data (company_stock / historical_prices)
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

  // 2. Apply migrations.
  const db = new Pool({ connectionString: testDbUrl() });
  const migrationsDir = join(__dirname, '..', 'db', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  // 3. Seed users.
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

  // 4. Create the scraper-owned market tables the watchlist queries join against.
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
      close_price   NUMERIC
    )`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_hist_fininstrm
     ON historical_prices ("FinInstrmId", record_date)`
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
        `INSERT INTO historical_prices ("FinInstrmId", record_date, open_price, close_price)
         VALUES ($1, '2026-08-20', $2, $3)
         ON CONFLICT DO NOTHING`,
        [s.finInstrmId, s.open, s.close]
      );
    }
  }

  await db.end();
  console.log('[setup] test database ready');
}
