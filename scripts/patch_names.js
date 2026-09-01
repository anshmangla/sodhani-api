const { pool } = require('./dist/db/pool.js');
const fs = require('fs');
const path = require('path');

async function run() {
  const outputDir = '/opt/sodhaniScrap/output';
  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.json'));
  let updated = 0;
  for (const file of files) {
    const finId = file.replace('.json', '');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
      if (data && data.overview && data.overview.company_name) {
        const name = data.overview.company_name;
        const res = await pool.query('UPDATE company_stock SET "FinInstrmNm" = $1 WHERE "FinInstrmId"::text = $2 AND "FinInstrmNm" IS NULL', [name, finId]);
        if (res.rowCount > 0) {
          updated += res.rowCount;
          console.log(`Updated ${finId} to ${name}`);
        }
      }
    } catch (e) {
      // ignore JSON parse errors
    }
  }
  console.log(`Finished. Updated ${updated} rows.`);
  process.exit(0);
}

run().catch(console.error);
