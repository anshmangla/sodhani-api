const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function runTest(symbol, range, chartType = 'candlestick') {
  console.log(`\nTesting range=${range}, chartType=${chartType}`);
  
  let rawRange = range.toLowerCase();
  
  let timeFilter = '';
  let durationDays = 30;
  
  if (['d', '1d'].includes(rawRange)) { range = '1d'; durationDays = 1; }
  else if (['w', '1w'].includes(rawRange)) { range = '1w'; durationDays = 7; }
  else if (['m', '1m'].includes(rawRange)) { range = '1m'; durationDays = 30; }
  else if (['y', '1y'].includes(rawRange)) { range = '1y'; durationDays = 365; }
  else if (['5y'].includes(rawRange)) { range = '5y'; durationDays = 365 * 5; }
  else if (['max'].includes(rawRange)) { range = 'max'; durationDays = 99999; }
  else { range = '1m'; durationDays = 30; }

  if (range === '1d') {
    timeFilter = `AND DATE(hp."record_date") = (SELECT MAX(DATE("record_date")) FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId")`;
  } else if (range === '1w') {
    timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '7 days'`;
  } else if (range === '1m') {
    timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '1 month'`;
  } else if (range === '1y') {
    timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '1 year'`;
  } else if (range === '5y') {
    timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '5 years'`;
  }

  const limit = 10000;
  const isLineChart = chartType === 'line' || chartType === 'area';
  
  let sql = '';
  if (isLineChart) {
    sql = `SELECT DISTINCT ON (DATE(hp."record_date")) 
              hp."record_date", hp."open_price", hp."high_price", hp."low_price",
              hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
       FROM historical_prices hp
       JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
       WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
         ${timeFilter}
       ORDER BY DATE(hp."record_date") ASC, hp."record_date" DESC
       LIMIT $2`;
  } else {
    if (durationDays < 365) {
      sql = `SELECT DISTINCT ON (DATE(hp."record_date")) 
                hp."record_date", hp."open_price", hp."high_price", hp."low_price",
                hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
         FROM historical_prices hp
         JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
         WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
           ${timeFilter}
         ORDER BY DATE(hp."record_date") DESC, hp."record_date" DESC
         LIMIT $2`;
    } else if (durationDays <= 365 * 5) {
      sql = `SELECT 
                date_trunc('week', hp."record_date") as record_date,
                (array_agg(hp."open_price" ORDER BY hp."record_date" ASC))[1] as open_price,
                MAX(hp."high_price") as high_price,
                MIN(hp."low_price") as low_price,
                (array_agg(hp."close_price" ORDER BY hp."record_date" DESC))[1] as close_price,
                SUM(hp."volume") as volume
             FROM historical_prices hp
             JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
             WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
               ${timeFilter}
             GROUP BY date_trunc('week', hp."record_date")
             ORDER BY record_date DESC
             LIMIT $2`;
    } else {
      sql = `SELECT 
                date_trunc('month', hp."record_date") as record_date,
                (array_agg(hp."open_price" ORDER BY hp."record_date" ASC))[1] as open_price,
                MAX(hp."high_price") as high_price,
                MIN(hp."low_price") as low_price,
                (array_agg(hp."close_price" ORDER BY hp."record_date" DESC))[1] as close_price,
                SUM(hp."volume") as volume
             FROM historical_prices hp
             JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
             WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
               ${timeFilter}
             GROUP BY date_trunc('month', hp."record_date")
             ORDER BY record_date DESC
             LIMIT $2`;
    }
  }

  try {
    const start = Date.now();
    const res = await pool.query(sql, [symbol, limit]);
    const duration = Date.now() - start;
    console.log(`Success! Found ${res.rows.length} rows in ${duration}ms`);
    if (res.rows.length > 0) {
      console.log(`First record date:`, res.rows[0].record_date);
    }
  } catch (err) {
    console.error(`Error querying database:`, err.message);
  }
}

async function run() {
  await runTest('ALANKIT', '1m', 'candlestick');
  await runTest('ALANKIT', '1y', 'candlestick');
  await runTest('ALANKIT', '5y', 'candlestick');
  await runTest('ALANKIT', 'max', 'candlestick');
  await runTest('ALANKIT', 'max', 'line');
  pool.end();
}
run();
