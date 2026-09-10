/**
 * stock_metrics stores mkt_cap and pe computed against the cmp captured by the
 * last metricsSync run, so both go stale the moment the price moves. The share
 * count and EPS sitting behind them don't - re-deriving those lets a client
 * re-price the pair against a live quote instead of showing a sync-time value.
 *
 * metricsSync already computes the share count this way (mktCap / price) before
 * collapsing it into mkt_cap; this recovers that intermediate value.
 */

function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

/** Shares outstanding in crore, implied by a stored market cap (Rs Cr) at its sync price. */
export function impliedShares(mktCap: number | null | undefined, cmp: number | null | undefined): number | null {
  return ratio(mktCap, cmp);
}

/** Earnings per share in Rs, implied by a stored P/E at its sync price. */
export function impliedEps(cmp: number | null | undefined, pe: number | null | undefined): number | null {
  return ratio(cmp, pe);
}
