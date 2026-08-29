// Pure helpers for GET /api/company/:symbol/peers - no DB access, so they're
// unit-tested directly without the Postgres test harness.

export type PeMetricsRow = {
  mkt_cap: number | null;
  pe: number | null;
};

// Market-cap-weighted average P/E across a set of companies. Mirrors
// sodhani-web's former client-side calculateWeightedPe so the number
// displayed doesn't change behavior for users.
export function computeWeightedPe(rows: PeMetricsRow[]): number | null {
  const constituents = rows.filter(
    (r) => typeof r.mkt_cap === 'number' && r.mkt_cap > 0 && typeof r.pe === 'number' && r.pe > 0
  );

  if (constituents.length < 2) {
    return null;
  }

  const totalMarketCap = constituents.reduce((sum, r) => sum + (r.mkt_cap ?? 0), 0);
  const totalEarnings = constituents.reduce((sum, r) => sum + (r.mkt_cap ?? 0) / (r.pe ?? 1), 0);

  if (totalEarnings <= 0) {
    return null;
  }

  return totalMarketCap / totalEarnings;
}

// Buckets a market-cap rank (1 = largest) into the same three categories
// sodhani-web used to compute client-side.
export function categorizeByRank(rank: number | null): string | null {
  if (rank === null) {
    return null;
  }
  if (rank <= 100) {
    return 'Large Cap';
  }
  if (rank <= 250) {
    return 'Mid Cap';
  }
  return 'Small Cap';
}
