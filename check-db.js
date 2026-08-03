const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkDb() {
  try {
    console.log('Connecting to database...');
    
    // Check total count
    const countRes = await pool.query('SELECT COUNT(*) FROM bse_spurt_volume');
    console.log('\n--- Table Count ---');
    console.log(`Total rows in bse_spurt_volume: ${countRes.rows[0].count}`);

    if (parseInt(countRes.rows[0].count) > 0) {
      // Check the latest 5 rows
      const latestRes = await pool.query('SELECT * FROM bse_spurt_volume ORDER BY record_date DESC NULLS LAST LIMIT 5');
      console.log('\n--- Latest 5 Rows ---');
      console.log(JSON.stringify(latestRes.rows, null, 2));
    } else {
      console.log('\nThe table is completely empty. The scraper might not have populated it yet.');
    }
  } catch (err) {
    console.error('\nError querying database:', err.message);
  } finally {
    await pool.end();
  }
}

checkDb();
