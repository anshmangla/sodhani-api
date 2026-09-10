import { describe, it, expect } from 'vitest';
import { impliedShares, impliedEps } from '../src/services/metricsDerive';

// Real VSSL numbers from stock_metrics: cmp 368 was the last sync price, so
// mkt_cap/pe stored alongside it are only correct at that price.
const VSSL = { cmp: 368, mktCap: 3554.5215, pe: 24.8146 };

describe('impliedShares', () => {
  it('returns the crore share count behind a stored market cap', () => {
    expect(impliedShares(VSSL.mktCap, VSSL.cmp)).toBeCloseTo(9.6590258, 6);
  });

  it('re-prices to the same market cap when multiplied back by the sync price', () => {
    const shares = impliedShares(VSSL.mktCap, VSSL.cmp)!;
    expect(shares * VSSL.cmp).toBeCloseTo(VSSL.mktCap, 4);
  });

  it('returns null when either operand is missing, zero or negative', () => {
    expect(impliedShares(VSSL.mktCap, 0)).toBeNull();
    expect(impliedShares(0, VSSL.cmp)).toBeNull();
    expect(impliedShares(null, VSSL.cmp)).toBeNull();
    expect(impliedShares(VSSL.mktCap, null)).toBeNull();
    expect(impliedShares(-10, VSSL.cmp)).toBeNull();
    expect(impliedShares(VSSL.mktCap, -1)).toBeNull();
  });

  it('returns null for non-finite operands', () => {
    expect(impliedShares(NaN, VSSL.cmp)).toBeNull();
    expect(impliedShares(VSSL.mktCap, NaN)).toBeNull();
    expect(impliedShares(Infinity, VSSL.cmp)).toBeNull();
  });
});

describe('impliedEps', () => {
  it('returns the earnings per share behind a stored P/E', () => {
    expect(impliedEps(VSSL.cmp, VSSL.pe)).toBeCloseTo(14.829979, 5);
  });

  it('re-prices to the same P/E when divided back into the sync price', () => {
    const eps = impliedEps(VSSL.cmp, VSSL.pe)!;
    expect(VSSL.cmp / eps).toBeCloseTo(VSSL.pe, 4);
  });

  it('returns null when either operand is missing, zero or negative', () => {
    expect(impliedEps(VSSL.cmp, 0)).toBeNull();
    expect(impliedEps(0, VSSL.pe)).toBeNull();
    expect(impliedEps(null, VSSL.pe)).toBeNull();
    expect(impliedEps(VSSL.cmp, null)).toBeNull();
    expect(impliedEps(VSSL.cmp, -5)).toBeNull();
    expect(impliedEps(-368, VSSL.pe)).toBeNull();
  });

  it('returns null for non-finite operands', () => {
    expect(impliedEps(NaN, VSSL.pe)).toBeNull();
    expect(impliedEps(VSSL.cmp, NaN)).toBeNull();
  });
});
