const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT COUNT(*) FROM historical_prices;", (err, res) => {
  if (err) console.error(err);
  else console.log(res.rows);
  pool.end();
});
