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
export const TEST_RA_JWT_SECRET = 'ra-test-secret';

// Fixed UUIDs so tests can reference them without round-tripping the DB.
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
export const TEST_USER2_ID = '00000000-0000-0000-0000-000000000002';
export const TEST_RA_ID = '00000000-0000-0000-0000-000000000101';
export const TEST_RA2_ID = '00000000-0000-0000-0000-000000000102';

export const SEEDED_STOCKS = [
  { finInstrmId: '500325', symbol: 'RELIANCE', name: 'Reliance Industries Ltd', open: 2950, close: 3000 },
  { finInstrmId: '500209', symbol: 'INFY', name: 'Infosys Ltd', open: 1780, close: 1800 },
  // TCS has a company_stock row but no history -> exercises the null-price branch.
  { finInstrmId: '500790', symbol: 'TCS', name: 'Tata Consultancy Services Ltd', open: null, close: null },
];

// Peer-comparison fixtures: company_stock + stock_metrics + company_sectors
// rows exercising the identifier-format bug this feature fixes (some
// company_sectors rows key fin_instrm_id by ticker, some by numeric BSE
// code) plus the leaf -> industry fallback and the no-classification path.
// See docs/superpowers/specs/2026-08-29-peer-comparison-backend-design.md.
export const SEEDED_PEER_COMPANY_STOCKS = [
  { finInstrmId: '500180', symbol: 'HDFCBANK', name: 'HDFC Bank Ltd' },
  { finInstrmId: '532174', symbol: 'ICICIBANK', name: 'ICICI Bank Ltd' },
  { finInstrmId: '532215', symbol: 'AXISBANK', name: 'Axis Bank Ltd' },
  { finInstrmId: '500247', symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank Ltd' },
  // BSE-only listing: no NSE ticker at all.
  { finInstrmId: '888001', symbol: null, name: 'Bse Only Peer Co' },
  // Sparse leaves: each leaf alone has too few companies, but their shared
  // industry has enough -> exercises the leaf -> industry fallback.
  { finInstrmId: '999001', symbol: 'SPARSECO', name: 'Sparse Leaf Co' },
  { finInstrmId: '999002', symbol: 'SPARSEPEERA', name: 'Sparse Peer A' },
  { finInstrmId: '999003', symbol: 'SPARSEPEERB', name: 'Sparse Peer B' },
  { finInstrmId: '999004', symbol: 'SPARSEPEERC', name: 'Sparse Peer C' },
  // Has company_stock + stock_metrics but deliberately NO company_sectors row.
  { finInstrmId: '999999', symbol: 'NOCLASS', name: 'No Classification Co' },
];

export const SEEDED_PEER_STOCK_METRICS: Record<
  string,
  { cmp: number; pe: number; mktCap: number; profitVar: number }
> = {
  '500180': { cmp: 1650, pe: 19, mktCap: 900000, profitVar: 8.2 },
  '532174': { cmp: 1050, pe: 18, mktCap: 700000, profitVar: 6.1 },
  '532215': { cmp: 1100, pe: 17, mktCap: 300000, profitVar: 4.4 },
  '500247': { cmp: 1750, pe: 20, mktCap: 350000, profitVar: 5.0 },
  '888001': { cmp: 250, pe: 15, mktCap: 15000, profitVar: 2.0 },
  '999001': { cmp: 50, pe: 12, mktCap: 500, profitVar: 1.0 },
  '999002': { cmp: 60, pe: 14, mktCap: 600, profitVar: 1.5 },
  '999003': { cmp: 70, pe: 13, mktCap: 700, profitVar: 1.8 },
  '999004': { cmp: 80, pe: 16, mktCap: 800, profitVar: 2.2 },
  '999999': { cmp: 40, pe: 10, mktCap: 400, profitVar: 0.5 },
};

// company_sectors rows: note the mixed fin_instrm_id key format this
// endpoint has to handle - ticker for most rows, numeric BSE code for
// '888001' (the BSE-only listing above, which has no NSE ticker).
export const SEEDED_COMPANY_SECTORS = [
  { finInstrmId: 'HDFCBANK', companyName: 'HDFC Bank Ltd', sectorCode: 'IN02', sectorName: 'Financial Services', industryCode: 'IN0201', industryName: 'Banks', leafCode: 'IN020101', leafName: 'Private Sector Bank' },
  { finInstrmId: 'ICICIBANK', companyName: 'ICICI Bank Ltd', sectorCode: 'IN02', sectorName: 'Financial Services', industryCode: 'IN0201', industryName: 'Banks', leafCode: 'IN020101', leafName: 'Private Sector Bank' },
  { finInstrmId: 'AXISBANK', companyName: 'Axis Bank Ltd', sectorCode: 'IN02', sectorName: 'Financial Services', industryCode: 'IN0201', industryName: 'Banks', leafCode: 'IN020101', leafName: 'Private Sector Bank' },
  { finInstrmId: 'KOTAKBANK', companyName: 'Kotak Mahindra Bank Ltd', sectorCode: 'IN02', sectorName: 'Financial Services', industryCode: 'IN0201', industryName: 'Banks', leafCode: 'IN020101', leafName: 'Private Sector Bank' },
  { finInstrmId: '888001', companyName: 'Bse Only Peer Co', sectorCode: 'IN02', sectorName: 'Financial Services', industryCode: 'IN0201', industryName: 'Banks', leafCode: 'IN020101', leafName: 'Private Sector Bank' },
  { finInstrmId: 'SPARSECO', companyName: 'Sparse Leaf Co', sectorCode: 'IN99', sectorName: 'Test Sector', industryCode: 'IN9901', industryName: 'Test Industry', leafCode: 'IN990101', leafName: 'Sparse Leaf One' },
  { finInstrmId: 'SPARSEPEERA', companyName: 'Sparse Peer A', sectorCode: 'IN99', sectorName: 'Test Sector', industryCode: 'IN9901', industryName: 'Test Industry', leafCode: 'IN990102', leafName: 'Sparse Leaf Two' },
  { finInstrmId: 'SPARSEPEERB', companyName: 'Sparse Peer B', sectorCode: 'IN99', sectorName: 'Test Sector', industryCode: 'IN9901', industryName: 'Test Industry', leafCode: 'IN990102', leafName: 'Sparse Leaf Two' },
  { finInstrmId: 'SPARSEPEERC', companyName: 'Sparse Peer C', sectorCode: 'IN99', sectorName: 'Test Sector', industryCode: 'IN9901', industryName: 'Test Industry', leafCode: 'IN990102', leafName: 'Sparse Leaf Two' },
  // NOCLASS deliberately has no row here.
];
