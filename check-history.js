const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkHistory() {
  try {
    console.log('Connecting to database...');
    
    // Check total count
    const countRes = await pool.query('SELECT COUNT(*) FROM historical_prices');
    console.log('\n--- History Table Count ---');
    console.log(`Total rows in historical_prices: ${countRes.rows[0].count}`);

    if (parseInt(countRes.rows[0].count) > 0) {
      // Check the latest dates and how many records were inserted on those dates
      const datesRes = await pool.query(`
        SELECT record_date::date as update_date, COUNT(*) as rows_inserted
        FROM historical_prices
        GROUP BY record_date::date
        ORDER BY update_date DESC
        LIMIT 10
      `);
      console.log('\n--- Data Freshness (Last 10 Update Dates) ---');
      console.table(datesRes.rows);
      
      console.log('\nExplanation:');
      console.log('- If you only see one older date, your scraper only ran once.');
      console.log('- If you see recent, consecutive trading days (with thousands of rows), it is updating regularly.');
    } else {
      console.log('\nThe table is completely empty.');
    }
  } catch (err) {
    console.error('\nError querying database:', err.message);
  } finally {
    await pool.end();
  }
}

checkHistory();
