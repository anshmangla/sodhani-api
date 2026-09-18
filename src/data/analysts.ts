import { pool } from '../db/pool';

export type AnalystSummary = {
  id: string;
  name: string;
  designation: string | null;
  profile_picture_url: string | null;
};

let cachedAnalysts: AnalystSummary[] | null = null;
let lastCacheTime = 0;

export async function getAnalysts(): Promise<AnalystSummary[]> {
  const now = Date.now();
  // Cache for 10 minutes to avoid hitting the DB on every keystroke
  if (cachedAnalysts && now - lastCacheTime < 10 * 60 * 1000) {
    return cachedAnalysts;
  }

  const res = await pool.query(`
    SELECT id, full_name AS name, designation, profile_picture_url
    FROM research_analysts
    WHERE is_active = true
  `);

  cachedAnalysts = res.rows;
  lastCacheTime = now;
  return cachedAnalysts;
}

export async function searchAnalysts(query: string, limit = 20): Promise<AnalystSummary[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const analysts = await getAnalysts();
  const lowerQuery = trimmedQuery.toLowerCase();

  const results = analysts.filter((analyst) => {
    const nameMatch = analyst.name.toLowerCase().includes(lowerQuery);
    const designationMatch = (analyst.designation ?? '').toLowerCase().includes(lowerQuery);
    return nameMatch || designationMatch;
  });

  return results.slice(0, limit);
}
