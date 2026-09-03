const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function run() {
  try {
    console.log('Cleaning historical_prices...');
    const { rows } = await pool.query('SELECT ctid, record_date FROM historical_prices');
    let toDelete = [];
    for (const row of rows) {
      const d = new Date(row.record_date);
      const h = d.getUTCHours();
      if (h < 9 || h >= 16) toDelete.push(row.ctid);
    }
    for (let i = 0; i < toDelete.length; i += 1000) {
      const chunk = toDelete.slice(i, i + 1000);
      await pool.query(DELETE FROM historical_prices WHERE ctid = ANY(), [chunk]);
    }
    console.log('Deleted', toDelete.length, 'rows from historical_prices');
    
    console.log('Cleaning bse_index_history...');
    const { rows: bseRows } = await pool.query('SELECT ctid, record_time FROM bse_index_history');
    toDelete = [];
    for (const row of bseRows) {
      const d = new Date(row.record_time);
      const h = d.getUTCHours();
      if (h < 9 || h >= 16) toDelete.push(row.ctid);
    }
    for (let i = 0; i < toDelete.length; i += 1000) {
      const chunk = toDelete.slice(i, i + 1000);
      await pool.query(DELETE FROM bse_index_history WHERE ctid = ANY(), [chunk]);
    }
    console.log('Deleted', toDelete.length, 'rows from bse_index_history');
    
    console.log('Cleaning nse_index_history...');
    const { rows: nseRows } = await pool.query('SELECT ctid, record_time FROM nse_index_history');
    toDelete = [];
    for (const row of nseRows) {
      const d = new Date(row.record_time);
      const h = d.getUTCHours();
      if (h < 9 || h >= 16) toDelete.push(row.ctid);
    }
    for (let i = 0; i < toDelete.length; i += 1000) {
      const chunk = toDelete.slice(i, i + 1000);
      await pool.query(DELETE FROM nse_index_history WHERE ctid = ANY(), [chunk]);
    }
    console.log('Deleted', toDelete.length, 'rows from nse_index_history');
  } finally {
    await pool.end();
  }
}
run();
