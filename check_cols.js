const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Check company_stock columns
  const cs = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'company_stock' ORDER BY ordinal_position");
  console.log("company_stock columns:", cs.rows.map(r => r.column_name));
  
  // Check stock_metrics columns
  const sm = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_metrics' ORDER BY ordinal_position");
  console.log("stock_metrics columns:", sm.rows.map(r => r.column_name));

  // Check a sample row from company_stock for price-related fields
  const sample = await pool.query(`SELECT * FROM company_stock WHERE "FinInstrmId"::text = '500020' LIMIT 1`);
  console.log("company_stock sample:", sample.rows[0]);

  // Check latest historical_prices for this stock
  const hp = await pool.query(`SELECT * FROM historical_prices WHERE "FinInstrmId" = 500020 ORDER BY record_date DESC LIMIT 1`);
  console.log("latest historical_prices:", hp.rows[0]);
  
  pool.end();
}
run();
