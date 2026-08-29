import { describe, it, expect } from 'vitest';
import { computeWeightedPe, categorizeByRank } from '../src/services/peerMetrics';

describe('computeWeightedPe', () => {
  it('returns the market-cap-weighted average PE for two or more qualifying rows', () => {
    // totalMarketCap = 1500, totalEarnings = 1000/10 + 500/20 = 125 -> 1500/125 = 12
    const rows = [
      { mkt_cap: 1000, pe: 10 },
      { mkt_cap: 500, pe: 20 },
    ];
    expect(computeWeightedPe(rows)).toBeCloseTo(12, 5);
  });

  it('ignores rows with non-positive or missing mkt_cap/pe', () => {
    const rows = [
      { mkt_cap: 1000, pe: 10 },
      { mkt_cap: 500, pe: 20 },
      { mkt_cap: null, pe: 15 },
      { mkt_cap: 300, pe: 0 },
      { mkt_cap: -50, pe: 8 },
    ];
    expect(computeWeightedPe(rows)).toBeCloseTo(12, 5);
  });

  it('returns null with fewer than two qualifying rows', () => {
    expect(computeWeightedPe([{ mkt_cap: 1000, pe: 10 }])).toBeNull();
    expect(computeWeightedPe([])).toBeNull();
  });
});

describe('categorizeByRank', () => {
  it('returns null for a null rank', () => {
    expect(categorizeByRank(null)).toBeNull();
  });

  it('buckets rank 1-100 as Large Cap', () => {
    expect(categorizeByRank(1)).toBe('Large Cap');
    expect(categorizeByRank(100)).toBe('Large Cap');
  });

  it('buckets rank 101-250 as Mid Cap', () => {
    expect(categorizeByRank(101)).toBe('Mid Cap');
    expect(categorizeByRank(250)).toBe('Mid Cap');
  });

  it('buckets rank 251+ as Small Cap', () => {
    expect(categorizeByRank(251)).toBe('Small Cap');
    expect(categorizeByRank(10000)).toBe('Small Cap');
  });
});
