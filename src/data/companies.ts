import { pool } from '../db/pool';

export type Company = { code: string; name: string };

let cachedCompanies: Company[] | null = null;
let lastCacheTime = 0;

export async function getCompanies(): Promise<Company[]> {
  const now = Date.now();
  // Cache for 10 minutes to avoid hitting the DB on every keystroke
  if (cachedCompanies && now - lastCacheTime < 10 * 60 * 1000) {
    return cachedCompanies;
  }

  const res = await pool.query(`
    SELECT "TckrSymb" as code, "FinInstrmNm" as name 
    FROM company_stock
    WHERE "TckrSymb" IS NOT NULL AND "FinInstrmNm" IS NOT NULL
  `);

  cachedCompanies = res.rows;
  lastCacheTime = now;
  return cachedCompanies;
}

export async function searchCompanies(query: string, limit = 20): Promise<Company[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const companies = await getCompanies();
  const lowerQuery = trimmedQuery.toLowerCase();

  const results = companies.filter((company) => {
    const nameMatch = company.name.toLowerCase().includes(lowerQuery);
    const codeMatch = company.code === trimmedQuery || company.code.startsWith(trimmedQuery);
    return nameMatch || codeMatch;
  });

  return results.slice(0, limit);
}
