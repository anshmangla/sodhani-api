const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  const symbol = 'ALANKIT';
  let range = '1m';
  let isEODOnly = ['1m', '1y', 'max'].includes(range);
  let timeFilter = `AND hp."record_date" >= (
      SELECT MAX("record_date")
      FROM historical_prices
      WHERE "FinInstrmId" = cs."FinInstrmId"
    ) - INTERVAL '1 month'`;
  
  let sql = isEODOnly
    ? `SELECT DISTINCT ON (DATE(hp."record_date")) 
              hp."record_date", hp."open_price", hp."high_price", hp."low_price",
              hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
       FROM historical_prices hp
       JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
       WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
         ${timeFilter}
       ORDER BY DATE(hp."record_date") DESC, hp."record_date" DESC`
    : `SELECT hp."record_date", hp."open_price", hp."high_price", hp."low_price",
              hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
       FROM historical_prices hp
       JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
       WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
         ${timeFilter}
       ORDER BY hp."record_date" DESC`;
       
  try {
    const res = await pool.query(sql, [symbol]);
    console.log(res.rows.slice(0, 3));
    console.log('Total count:', res.rows.length);
  } catch(e) { console.error(e); }
  pool.end();
}
run();
