import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool';

// NOTE: These are throwaway dummy credentials for local development seeding only.
// They are intentionally plaintext here (git-committed) — not production secrets.
const DUMMY_ANALYSTS = [
  {
    username: 'rajesh.kumar',
    password: 'ChangeMe123!',
    fullName: 'Rajesh Kumar',
    designation: 'Senior Research Analyst',
  },
  {
    username: 'priya.sharma',
    password: 'ChangeMe123!',
    fullName: 'Priya Sharma',
    designation: 'Equity Research Analyst',
  },
  {
    username: 'amit.verma',
    password: 'ChangeMe123!',
    fullName: 'Amit Verma',
    designation: 'Research Analyst',
  },
];

async function main() {
  for (const a of DUMMY_ANALYSTS) {
    const passwordHash = await bcrypt.hash(a.password, 10);
    const result = await pool.query(
      `INSERT INTO research_analysts (username, password_hash, full_name, designation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(username)) DO NOTHING
       RETURNING username`,
      [a.username, passwordHash, a.fullName, a.designation]
    );
    if (result.rows.length > 0) {
      console.log(`Created RA: ${a.username}`);
    } else {
      console.log(`RA already exists, skipped: ${a.username}`);
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
