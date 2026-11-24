import { pool } from '../db/pool';

export type Company = { code: string; name: string };

// Exchange names run dotted initials straight into the next word
// ("J.K.Shah Commerce...", "J.K.CEMENT LTD."). Add the missing space.
export function tidyName(name: string): string {
  return name.replace(/\b((?:[A-Za-z]\.){2,})(?=[A-Za-z]{2})/g, '$1 ');
}

// Punctuation- and space-insensitive key, so "JK Cement", "J.K. Cement" and
// "J.K.CEMENT LTD." all meet.
export function searchKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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
    SELECT "TckrSymb" as code, COALESCE("FinInstrmNm", "TckrSymb") as name
    FROM company_stock
    WHERE "TckrSymb" IS NOT NULL

    UNION ALL

    SELECT cs.fin_instrm_id as code, COALESCE(cs.company_name, cs.fin_instrm_id) as name
    FROM company_sectors cs
    WHERE cs.fin_instrm_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM company_stock c
        WHERE c."TckrSymb" IS NOT NULL
          AND (c."TckrSymb" = cs.fin_instrm_id OR c."FinInstrmId"::text = cs.fin_instrm_id)
      )
  `);

  cachedCompanies = (res.rows as Company[]).map((c) => ({ ...c, name: tidyName(c.name) }));
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
  const queryKey = searchKey(trimmedQuery);

  const results = companies.filter((company) => {
    const nameMatch =
      company.name.toLowerCase().includes(lowerQuery) ||
      (queryKey.length > 0 && searchKey(company.name).includes(queryKey));
    const codeMatch = company.code === trimmedQuery || company.code.startsWith(trimmedQuery);
    return nameMatch || codeMatch;
  });

  return results.slice(0, limit);
}
