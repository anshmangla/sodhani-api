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

// Override default parsing for timestamp without time zone (OID 1114).
// The database natively stores these as naive IST timestamps, but pg defaults
// to interpreting them in the server's local time (e.g. UTC on Azure).
// We explicitly append '+05:30' so they are correctly parsed as IST dates.
types.setTypeParser(1114, (val) => (val === null ? null : new Date(val + '+05:30')));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});
