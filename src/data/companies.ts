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

  // company_stock only carries NSE-ticker-keyed instruments, so BSE-only
  // companies (numeric scrip code, no TckrSymb - e.g. Sodhani Capital/544560)
  // are invisible to search unless we also pull them from company_sectors,
  // which company_sectors keys by ticker OR by the raw BSE scrip code.
  const res = await pool.query(`
    SELECT "TckrSymb" as code, "FinInstrmNm" as name
    FROM company_stock
    WHERE "TckrSymb" IS NOT NULL AND "FinInstrmNm" IS NOT NULL

    UNION ALL

    SELECT cs.fin_instrm_id as code, cs.company_name as name
    FROM company_sectors cs
    WHERE cs.company_name IS NOT NULL
      AND cs.fin_instrm_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM company_stock c
        WHERE c."TckrSymb" IS NOT NULL AND c."FinInstrmNm" IS NOT NULL
          AND (c."TckrSymb" = cs.fin_instrm_id OR c."FinInstrmId"::text = cs.fin_instrm_id)
      )
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
