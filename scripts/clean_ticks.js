require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanTable(tableName, dateColumn) {
  console.log(`Cleaning ${tableName}...`);
  let lastDate = '1970-01-01T00:00:00.000Z';
  const limit = 50000;
  let totalDeleted = 0;

  while (true) {
    const { rows } = await pool.query(`
      SELECT ctid, ${dateColumn} 
      FROM ${tableName} 
      WHERE ${dateColumn} > $1 
      ORDER BY ${dateColumn} ASC 
      LIMIT ${limit}
    `, [lastDate]);
    
    if (rows.length === 0) break;

    const toDelete = [];
    for (const row of rows) {
      const d = new Date(row[dateColumn]);
      const h = d.getUTCHours();
      if (h < 9 || h >= 16) toDelete.push(row.ctid);
    }

    if (toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += 1000) {
        const chunk = toDelete.slice(i, i + 1000);
        await pool.query(`DELETE FROM ${tableName} WHERE ctid = ANY($1)`, [chunk]);
      }
      totalDeleted += toDelete.length;
    }
    
    lastDate = new Date(rows[rows.length - 1][dateColumn]).toISOString();
    console.log(`Scanned up to ${lastDate}, deleted ${totalDeleted} so far...`);
  }
  
  console.log(`Finished! Deleted ${totalDeleted} out-of-hours rows from ${tableName}`);
}

async function run() {
  try {
    await cleanTable('historical_prices', 'record_date');
    await cleanTable('bse_index_history', 'record_time');
    await cleanTable('nse_index_history', 'record_time');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
