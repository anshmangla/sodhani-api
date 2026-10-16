import { describe, it, expect } from 'vitest';
import { ema, rsi, atr, pivotHighs, pivotLows, computeSnapshot, compact, latestContiguous, detectCorporateActions, Bar, IndexPoint } from '../src/services/taSnapshot';

function dateAt(i: number): string {
  // Consecutive weekdays from 2024-01-01 (a Monday); exact calendar doesn't matter here.
  const d = new Date(Date.UTC(2024, 0, 1));
  let added = 0;
  while (added < i) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function barsFromCloses(closes: number[], volume = 1000): Bar[] {
  return closes.map((c, i) => ({ date: dateAt(i), open: c, high: c + 1, low: c - 1, close: c, volume }));
}

describe('taSnapshot indicator math', () => {
  it('ema is seeded with the SMA and null before that', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4);
  });

  it('rsi is 100 on a strictly rising series and 50 on a flat one', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14)[29]).toBe(100);
    expect(rsi(new Array(30).fill(100), 14)[29]).toBe(50);
    expect(rsi(up, 14)[13]).toBeNull();
  });

  it('atr of a constant 2-point range is 2', () => {
    const bars = barsFromCloses(new Array(30).fill(100));
    expect(atr(bars, 14)[29]).toBeCloseTo(2);
  });

  it('detects 5-bar pivots', () => {
    const v = [1, 2, 5, 2, 1, 0, -3, 0, 1];
    expect(pivotHighs(v)).toEqual([2]);
    expect(pivotLows(v)).toEqual([6]);
  });

  it('returns nulls for short history', () => {
    const s = computeSnapshot(barsFromCloses([10, 11, 12]), []);
    expect(s.history_days).toBe(3);
    expect(s.trend.ema50).toBeNull();
    expect(s.trend.ema_alignment).toBeNull();
    expect(s.momentum.rsi).toBeNull();
    expect(s.volume.rel_volume).toBeNull();
    expect(s.relative_strength.rs_20d).toBeNull();
  });

  it('labels a long steady uptrend as bullish, trending and overbought', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i);
    const s = computeSnapshot(barsFromCloses(closes), []);
    expect(s.trend.ema_alignment).toBe('bullish');
    expect(s.trend.above_ema50).toBe(true);
    expect(s.trend_strength.state).toBe('trending');
    expect(s.momentum.state).toBe('overbought');
    expect(s.momentum.days_in_zone).toBeGreaterThan(200);
    expect(s.levels.pct_from_52w_high).toBeLessThanOrEqual(0);
    expect(s.volume.state).toBe('flat');
  });

  it('computes relative strength against the index over the same dates', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const bars = barsFromCloses(closes);
    const nifty: IndexPoint[] = bars.map((b) => ({ date: b.date, close: 1000 }));
    const s = computeSnapshot(bars, nifty);
    // Flat index: rs equals the stock's own 20-session return.
    expect(s.relative_strength.rs_20d).toBeCloseTo((179 / 159 - 1) * 100, 1);
    // Index history that starts after the window start gives null.
    expect(computeSnapshot(bars, nifty.slice(30)).relative_strength.rs_60d).toBeNull();
  });

  it('flags a volatility squeeze after a quiet stretch', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + (i % 2 ? 5 : -5));
    const bars = barsFromCloses(closes);
    for (let i = 280; i < 300; i++) bars[i] = { ...bars[i], open: 100, high: 100.2, low: 99.8, close: 100 };
    const s = computeSnapshot(bars, []);
    expect(s.volatility.state).toBe('compressed');
    expect(s.volatility.squeeze).toBe(true);
    expect(s.volatility.days_in_squeeze).toBeGreaterThan(5);
  });

  it('compact drops null fields and groups left empty', () => {
    const out = compact(computeSnapshot(barsFromCloses([10, 11, 12, 13, 14, 13, 12]), []));
    expect(out.trend).toBeUndefined();
    expect(out.momentum).toBeUndefined();
    expect(out.relative_strength).toBeUndefined();
    expect(out.levels.high_52w).toBe(15);
    expect('nearest_support' in out.levels).toBe(false);
    expect(out.levels.nearest_resistance).toBe(15);
    expect(out.history_days).toBe(7);
  });

  it('ignores bars before a multi-year hole in the history', () => {
    const old = Array.from({ length: 300 }, (_, i) => ({ date: dateAt(i), open: 50, high: 51, low: 49, close: 50, volume: 1000 }));
    const recent = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 17 + i)).toISOString().slice(0, 10);
      return { date: d, open: 4900, high: 4910, low: 4890, close: 4900, volume: 1000 };
    });
    expect(latestContiguous([...old, ...recent])).toHaveLength(60);
    const out = compact(computeSnapshot([...old, ...recent], []));
    expect(out.history_days).toBe(60);
    expect(out.trend.ema50).toBe(4900); // seeded from 2026 prices only
    expect('ema200' in out.trend).toBe(false);
    expect(out.levels.low_52w).toBe(4890);
  });

  it('keeps short gaps from illiquid trading', () => {
    const bars = barsFromCloses([10, 11, 12]);
    bars[2] = { ...bars[2], date: '2024-03-15' }; // ~10 weeks after bar 1
    expect(latestContiguous(bars)).toHaveLength(3);
  });

  describe('detectCorporateActions', () => {
    const withJump = (factor: number, after: number[]) => {
      const bars = barsFromCloses([...new Array(50).fill(300), ...after]);
      bars[50] = { ...bars[50], open: 300 * factor };
      return bars;
    };

    it('flags a persistent 1:5 split and snaps the factor', () => {
      const ev = detectCorporateActions(withJump(0.2, new Array(15).fill(61)));
      expect(ev).toHaveLength(1);
      expect(ev[0].likely_factor).toBe(0.2);
      expect(ev[0].confirmed_permanent).toBe(true);
    });

    it('flags a fresh jump that is too recent to confirm', () => {
      const ev = detectCorporateActions(withJump(0.5, [150, 151]));
      expect(ev).toHaveLength(1);
      expect(ev[0].confirmed_permanent).toBe(false);
    });

    it('ignores a glitch that reverts', () => {
      expect(detectCorporateActions(withJump(0.2, [60, 300, 301, 300]))).toHaveLength(0);
    });

    it('ignores jumps outside the lookback and normal band moves', () => {
      expect(detectCorporateActions(withJump(0.2, new Array(15).fill(61)), 10)).toHaveLength(0);
      expect(detectCorporateActions(barsFromCloses([100, 80, 85, 90]))).toHaveLength(0);
    });

    it('flags a consolidation (upward jump)', () => {
      const ev = detectCorporateActions(withJump(10, new Array(15).fill(3000)));
      expect(ev[0].likely_factor).toBe(10);
    });
  });

  it('omits EMA200 and 52-week fields when an older jump is still in their window', () => {
    const closes = [...new Array(300).fill(500), ...Array.from({ length: 200 }, (_, i) => 100 + (i % 3))];
    const bars = barsFromCloses(closes);
    const ev = detectCorporateActions(bars);
    expect(ev).toHaveLength(1);
    expect(ev[0].sessions_ago).toBe(199);
    const out = compact(computeSnapshot(bars, [], ev[0].sessions_ago));
    expect('ema200' in out.trend).toBe(false);
    expect('ema_alignment' in out.trend).toBe(false);
    expect(out.trend.ema50).toBeLessThan(110);
    expect(out.levels.high_52w).toBeUndefined();
    expect(out.volatility.atr_percentile).toBeUndefined();
    expect(out.levels.nearest_resistance).toBeLessThan(110); // swing levels from post-jump bars only
    // 260 sessions later only EMA200 is still dropped.
    const out2 = compact(computeSnapshot(bars, [], 260));
    expect('ema200' in out2.trend).toBe(false);
    expect(out2.levels.high_52w).toBeDefined();
  });
});
