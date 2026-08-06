import * as fs from 'fs/promises';
import path from 'path';

export type Company = { code: string; name: string };

let cachedCompanies: Company[] | null = null;

export async function getCompanies(): Promise<Company[]> {
  if (cachedCompanies) {
    return cachedCompanies;
  }

  const csvPath = path.resolve(__dirname, '../../companies.csv');
  const data = await fs.readFile(csvPath, 'utf-8');
  const lines = data.split('\n');

  const companies: Company[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row = line.split(',');
    const code = (row[1] ?? '').trim();
    const name = (row[2] ?? '').trim();
    if (!code || !name) continue;

    companies.push({ code, name });
  }

  cachedCompanies = companies;
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
