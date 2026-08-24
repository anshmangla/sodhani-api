import dotenv from 'dotenv';
dotenv.config();

import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { Pool } from 'pg';

// Applies db/migrations/*.sql in lexical order, recording each in schema_migrations.
//
// The table shape matches the one already present in the shared Postgres DB (used by
// other sodhani services), so this runner coexists with them. Every migration in this
// repo is idempotent (CREATE ... IF NOT EXISTS), so running this against a DB that
// already has some or all tables (e.g. the existing VM) is safe: already-present tables
// are no-ops, and only genuinely new ones are created.
//
// Usage:
//   npm run migrate   # apply any pending migrations (safe to re-run)

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function applied(): Promise<Set<string>> {
  const result = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((r) => r.filename));
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function main(): Promise<void> {
  await ensureTable();
  const done = await applied();
  const files = migrationFiles();

  if (files.length === 0) {
    console.log('No migration files found in', MIGRATIONS_DIR);
    await pool.end();
    return;
  }

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    if (done.has(file)) {
      skippedCount++;
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
    console.log(`applied   ${file}`);
    appliedCount++;
  }

  console.log(`\nDone. ${appliedCount} applied, ${skippedCount} already applied.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message ?? err);
  await pool.end().catch(() => {});
  process.exit(1);
});
