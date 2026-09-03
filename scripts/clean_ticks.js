require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanTable(tableName, dateColumn) {
  console.log(`Cleaning ${tableName}...`);
  let offset = 0;
  const limit = 50000;
  let totalDeleted = 0;

  while (true) {
    const { rows } = await pool.query(`SELECT ctid, ${dateColumn} FROM ${tableName} LIMIT ${limit} OFFSET ${offset}`);
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
    
    // We only advance offset by the rows we kept, because deleting rows shifts the remaining rows down.
    offset += (rows.length - toDelete.length);
  }
  
  console.log(`Deleted ${totalDeleted} rows from ${tableName}`);
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
