const { Pool } = require('pg');
require('dotenv').config({ path: 'E:/Sodhani/sodhani-api/.env' });
const pool = new Pool();
pool.query('SELECT * FROM company_stock WHERE "FinInstrmId" = \'514442\'').then(r => { console.log(r.rows); pool.end(); });
