const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runTest() {
  const symbol = '500020';
  const sql = `SELECT cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm", 
            COALESCE(sm."cmp", cs."LastPric") AS "CurrentPrice", 
            hp_latest."true_open" AS "OpenPric",
            hp_latest."true_high" AS "HighPric",
            hp_latest."true_low" AS "LowPric",
            hp_latest."true_close" AS "LastCloseOfDay",
            (COALESCE(sm."cmp", cs."LastPric"::float) - hp_latest."true_open"::float) AS "ChangeVal",
            CASE WHEN hp_latest."true_open"::float > 0 
              THEN ((COALESCE(sm."cmp", cs."LastPric"::float) - hp_latest."true_open"::float) / hp_latest."true_open"::float) * 100
              ELSE 0 
            END AS "ChangePercent"
     FROM company_stock cs
     LEFT JOIN stock_metrics sm ON (sm.symbol = cs."FinInstrmId"::text OR UPPER(sm.symbol) = UPPER(cs."TckrSymb"))
     LEFT JOIN LATERAL (
       SELECT 
         (array_agg(open_price ORDER BY record_date ASC))[1] as true_open,
         MAX(high_price) as true_high,
         MIN(low_price) as true_low,
         (array_agg(close_price ORDER BY record_date DESC))[1] as true_close
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp.record_date) = (
           SELECT MAX(DATE(record_date)) 
           FROM historical_prices 
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
     ) hp_latest ON true
     WHERE UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1
     LIMIT 1`;
     
  try {
    const start = Date.now();
    const res = await pool.query(sql, [symbol]);
    console.log(`Executed in ${Date.now() - start}ms`);
    console.log(JSON.stringify(res.rows[0], null, 2));
  } catch (err) {
    console.error(err.message);
  } finally {
    pool.end();
  }
}
runTest();
