import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let dbInstance: Database.Database | null = null;

export function resolveDbPath(): string {
  if (process.env.MARKET_DB_PATH && fs.existsSync(process.env.MARKET_DB_PATH)) {
    return process.env.MARKET_DB_PATH;
  }

  const candidatePaths = [
    path.resolve(process.cwd(), 'db', 'market.sqlite'),
    path.resolve(process.cwd(), 'market.sqlite'),
    path.resolve(process.cwd(), '..', 'market.sqlite'),
    '/opt/sodhani-api/db/market.sqlite',
    '/opt/market-data/market.sqlite',
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      if (stat.size > 1000000) { // must be the real populated DB (>1MB)
        return p;
      }
    }
  }

  // Fallback to default
  return path.resolve(process.cwd(), 'db', 'market.sqlite');
}

export function getInvestmentsDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    console.log(`[InvestmentsDB] Opening SQLite database at: ${dbPath}`);
    dbInstance = new Database(dbPath, {
      readonly: true,
      fileMustExist: false,
    });
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('cache_size = -64000'); // 64MB cache
    dbInstance.pragma('query_only = ON');
  }
  return dbInstance;
}

export function queryAll<T = any>(sql: string, params: any[] = []): T[] {
  const db = getInvestmentsDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params) as T[];
}

export function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
  const db = getInvestmentsDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params) as T | undefined;
}
