import { Pool, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// pg returns NUMERIC (OID 1700) and BIGINT/INT8 (OID 20) columns as strings by
// default, to avoid silent precision loss on values beyond Number's safe
// integer range. This app's NUMERIC columns (prices) and BIGINT columns
// (trade volumes, paise sums) never approach that range, and several response
// builders send these values straight to the frontend expecting JS numbers —
// so parse them as numbers globally rather than requiring every query to
// remember an explicit ::float8/::int cast.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
// DATE (OID 1082) defaults to a JS Date, which re-serializes with a spurious
// time/zone component (e.g. `research_calls.expiry_date`). These columns are
// plain calendar dates with no time component of their own — keep them as the
// `YYYY-MM-DD` string Postgres already hands back before parsing.
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // historical_prices.record_date is TIMESTAMP (no zone) holding UTC wall clock,
  // but CURRENT_DATE / DATE() resolve in the session timezone. Pin the session so
  // every date-boundary comparison agrees with how the scraper writes the rows;
  // a session west of UTC would shift them all by a day.
  options: '-c timezone=UTC',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  idle_in_transaction_session_timeout: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});
