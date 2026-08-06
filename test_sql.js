const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
SELECT DISTINCT ON (DATE(hp."record_date")) 
          hp."record_date", hp."close_price"
   FROM historical_prices hp
   JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
   WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
   ORDER BY DATE(hp."record_date") ASC, hp."record_date" DESC
   LIMIT 3;
`;

pool.query(sql, ['ALANKIT'], (err, res) => {
  if (err) console.error(err);
  else console.log(res.rows);
  pool.end();
});
