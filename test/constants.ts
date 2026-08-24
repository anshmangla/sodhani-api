// Shared constants for the watchlist test suite.
//
// Tests run against a dedicated database (derived from DATABASE_URL by swapping the
// database name) so the developer's real data is never touched. Seeded market data
// lives in company_stock/historical_prices, which are scraper-owned tables — the test
// seeds its own rows instead of depending on real scrape output.

export function testDbUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const url = new URL(
    process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres'
  );
  url.pathname = '/sodhani_api_test';
  return url.toString();
}

export function adminDbUrl(): string {
  const url = new URL(
    process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres'
  );
  url.pathname = '/postgres';
  return url.toString();
}

export const TEST_JWT_SECRET = 'watchlist-test-secret';

// Fixed UUIDs so tests can reference them without round-tripping the DB.
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
export const TEST_USER2_ID = '00000000-0000-0000-0000-000000000002';

export const SEEDED_STOCKS = [
  { finInstrmId: '500325', symbol: 'RELIANCE', name: 'Reliance Industries Ltd', open: 2950, close: 3000 },
  { finInstrmId: '500209', symbol: 'INFY', name: 'Infosys Ltd', open: 1780, close: 1800 },
  // TCS has a company_stock row but no history -> exercises the null-price branch.
  { finInstrmId: '500790', symbol: 'TCS', name: 'Tata Consultancy Services Ltd', open: null, close: null },
];
