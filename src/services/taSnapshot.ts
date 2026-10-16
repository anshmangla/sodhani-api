// Deterministic technical-analysis snapshot for one stock as of one session.
//
// Pure math, no DB access: the route loads daily bars (oldest first, already
// cut at the as-of date so nothing after it can leak in) and passes them here.
// Indicator choice and definitions follow "TA Indicator Spec for News-Driven
// Stock Agent": every field is a value plus an interpreted state label, never
// a raw series. Any field without enough history comes back as null.

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null; // null = no real volume for that session
}

export interface IndexPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

type Num = number | null;

const round = (v: Num, dp = 2): Num =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

// EMA seeded with the SMA of the first n values; null until then.
export function ema(values: number[], n: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder smoothing over a series that may start with nulls: seeded with the
// SMA of the first n non-null values, then prev + (x - prev) / n.
export function wilder(values: Num[], n: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += values[i] as number;
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < values.length; i++) {
    prev = prev + ((values[i] as number) - prev) / n;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], n = 14): Num[] {
  const gains: Num[] = [null];
  const losses: Num[] = [null];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = wilder(gains, n);
  const al = wilder(losses, n);
  return closes.map((_, i) => {
    const g = ag[i];
    const l = al[i];
    if (g == null || l == null) return null;
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  });
}

function trueRanges(bars: Bar[]): Num[] {
  return bars.map((b, i) =>
    i === 0
      ? null
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
  );
}

export function atr(bars: Bar[], n = 14): Num[] {
  return wilder(trueRanges(bars), n);
}

export function adx(bars: Bar[], n = 14): Num[] {
  const plusDm: Num[] = [null];
  const minusDm: Num[] = [null];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const tr = wilder(trueRanges(bars), n);
  const pdm = wilder(plusDm, n);
  const mdm = wilder(minusDm, n);
  const dx: Num[] = bars.map((_, i) => {
    const t = tr[i];
    if (t == null || pdm[i] == null || mdm[i] == null) return null;
    if (t === 0) return 0;
    const pdi = (100 * (pdm[i] as number)) / t;
    const mdi = (100 * (mdm[i] as number)) / t;
    return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  });
  return wilder(dx, n);
}

// 5-bar pivot: strictly above (or below) the 2 bars on each side. The last two
// bars can never qualify because their right-hand side doesn't exist yet.
export function pivotHighs(values: number[]): number[] {
  const idx: number[] = [];
  for (let i = 2; i < values.length - 2; i++) {
    const v = values[i];
    if (v > values[i - 1] && v > values[i - 2] && v > values[i + 1] && v > values[i + 2]) idx.push(i);
  }
  return idx;
}

export function pivotLows(values: number[]): number[] {
  const idx: number[] = [];
  for (let i = 2; i < values.length - 2; i++) {
    const v = values[i];
    if (v < values[i - 1] && v < values[i - 2] && v < values[i + 1] && v < values[i + 2]) idx.push(i);
  }
  return idx;
}

// % of the trailing `window` values (including index i) strictly below values[i].
function percentileAt(values: Num[], i: number, window: number): Num {
  const cur = values[i];
  if (cur == null) return null;
  const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v != null);
  if (slice.length < 2) return null;
  return (100 * slice.filter((v) => v < cur).length) / slice.length;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Latest index close on or before `date` (index points sorted ascending).
function indexCloseOnOrBefore(points: IndexPoint[], date: string): Num {
  let lo = 0;
  let hi = points.length - 1;
  let found: Num = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) {
      found = points[mid].close;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// Drops null fields, then any group left empty, so the response only carries
// what could actually be computed. A relative_strength group with no rs_* value
// left is dropped too, rather than returning just its benchmark label.
export function compact(value: any): any {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v == null) continue;
    const c = compact(v);
    if (c !== null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
    out[k] = c;
  }
  const rs = out.relative_strength;
  if (rs && Object.keys(rs).every((k) => k === 'benchmark')) delete out.relative_strength;
  return out;
}

// A gap longer than this between consecutive bars is a hole in the stored
// history (e.g. a failed backfill left some stocks with 2000-2002 data followed
// directly by 2026 data), not a real trading pause. Illiquid scrips go weeks
// without a bar, so the cut-off sits well above that.
export const MAX_GAP_DAYS = 90;

// Bars after the most recent hole, so no indicator is computed across it.
export function latestContiguous(bars: Bar[], maxGapDays = MAX_GAP_DAYS): Bar[] {
  const dayMs = 24 * 3600 * 1000;
  for (let i = bars.length - 1; i > 0; i--) {
    const gap = (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / dayMs;
    if (gap > maxGapDays) return bars.slice(i);
  }
  return bars;
}

export function computeSnapshot(allBars: Bar[], nifty: IndexPoint[]) {
  const bars = latestContiguous(allBars);
  const n = bars.length;
  const last = n - 1;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const close = closes[last];

  // Trend direction
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const e50 = ema50[last];
  const e200 = ema200[last];
  let emaAlignment: string | null = null;
  if (e50 != null && e200 != null) {
    if (close > e50 && e50 > e200) emaAlignment = 'bullish';
    else if (close < e50 && e50 < e200) emaAlignment = 'bearish';
    else emaAlignment = 'mixed';
  }
  const e50Prev = last >= 10 ? ema50[last - 10] : null;

  // Trend strength
  const adxNow = adx(bars, 14)[last];
  const adxState = adxNow == null ? null : adxNow < 20 ? 'weak' : adxNow <= 25 ? 'building' : 'trending';

  // Momentum
  const rsiSeries = rsi(closes, 14);
  const rsiNow = rsiSeries[last];
  const zoneOf = (v: Num) => (v == null ? null : v > 70 ? 'overbought' : v < 30 ? 'oversold' : 'neutral');
  const rsiState = zoneOf(rsiNow);
  let daysInZone = 0;
  if (rsiState === 'overbought' || rsiState === 'oversold') {
    for (let i = last; i >= 0 && zoneOf(rsiSeries[i]) === rsiState; i--) daysInZone++;
  }

  let divergence: string | null = null;
  if (rsiNow != null) {
    divergence = 'none';
    const from = Math.max(0, n - 40);
    const ph = pivotHighs(highs.slice(from)).map((i) => i + from).filter((i) => rsiSeries[i] != null);
    const pl = pivotLows(lows.slice(from)).map((i) => i + from).filter((i) => rsiSeries[i] != null);
    if (ph.length >= 2) {
      const [a, b] = ph.slice(-2);
      if (highs[b] > highs[a] && (rsiSeries[b] as number) < (rsiSeries[a] as number)) divergence = 'bearish';
    }
    if (divergence === 'none' && pl.length >= 2) {
      const [a, b] = pl.slice(-2);
      if (lows[b] < lows[a] && (rsiSeries[b] as number) > (rsiSeries[a] as number)) divergence = 'bullish';
    }
  }

  // Volatility level + regime
  const atrSeries = atr(bars, 14);
  const atrPct: Num[] = atrSeries.map((v, i) => (v == null || closes[i] === 0 ? null : (v / closes[i]) * 100));
  const atrPctile = percentileAt(atrPct, last, 252);
  const volState = atrPctile == null ? null : atrPctile < 20 ? 'compressed' : atrPctile <= 80 ? 'normal' : 'expanded';
  let daysInSqueeze = 0;
  if (volState === 'compressed') {
    for (let i = last; i >= 0; i--) {
      const p = percentileAt(atrPct, i, 252);
      if (p == null || p >= 20) break;
      daysInSqueeze++;
    }
  }

  // Volume
  // Averages skip sessions with no volume; a window needs at least 3/4 of its
  // sessions present to count.
  const vols = bars.map((b) => b.volume);
  const avgVol = (from: number, to: number): Num => {
    if (from < 0) return null;
    const xs = vols.slice(from, to).filter((v): v is number => v != null);
    return xs.length >= 0.75 * (to - from) ? avg(xs) : null;
  };
  const prev20 = avgVol(n - 21, n - 1);
  const relVolume = prev20 && vols[last] != null ? (vols[last] as number) / prev20 : null;
  const avg20 = avgVol(n - 20, n);
  const avg60 = avgVol(n - 60, n);
  const volTrend = avg20 != null && avg60 ? avg20 / avg60 : null;
  const volTrendState = volTrend == null ? null : volTrend > 1.2 ? 'rising' : volTrend < 0.8 ? 'falling' : 'flat';

  // Relative strength vs NIFTY 50
  const rs = (period: number): Num => {
    if (n <= period) return null;
    const startDate = bars[last - period].date;
    const endDate = bars[last].date;
    // Index history must actually reach back to the start date.
    if (!nifty.length || nifty[0].date > startDate) return null;
    const i0 = indexCloseOnOrBefore(nifty, startDate);
    const i1 = indexCloseOnOrBefore(nifty, endDate);
    const s0 = closes[last - period];
    if (i0 == null || i1 == null || !i0 || !s0) return null;
    return ((close / s0 - 1) - (i1 / i0 - 1)) * 100;
  };

  // Levels (52 weeks ≈ 252 sessions)
  const from52 = Math.max(0, n - 252);
  const h52 = Math.max(...highs.slice(from52));
  const l52 = Math.min(...lows.slice(from52));
  const supports = pivotLows(lows.slice(from52)).map((i) => lows[i + from52]).filter((v) => v < close);
  const resistances = pivotHighs(highs.slice(from52)).map((i) => highs[i + from52]).filter((v) => v > close);

  return {
    as_of_session: bars[last].date,
    history_days: n,
    market_price: round(close), // closing price on as_of_session
    trend: {
      ema50: round(e50),
      ema200: round(e200),
      above_ema50: e50 == null ? null : close > e50,
      above_ema200: e200 == null ? null : close > e200,
      ema_alignment: emaAlignment,
      ema50_slope: round(e50 != null && e50Prev ? (e50 / e50Prev - 1) * 100 : null),
    },
    trend_strength: {
      adx: round(adxNow),
      state: adxState,
    },
    momentum: {
      rsi: round(rsiNow),
      state: rsiState,
      divergence,
      days_in_zone: rsiNow == null ? null : daysInZone,
    },
    volatility: {
      atr: round(atrSeries[last]),
      atr_pct: round(atrPct[last]),
      atr_percentile: round(atrPctile, 0),
      state: volState,
      squeeze: volState == null ? null : volState === 'compressed',
      days_in_squeeze: volState == null ? null : daysInSqueeze,
    },
    volume: {
      rel_volume: round(relVolume),
      vol_trend_ratio: round(volTrend),
      state: volTrendState,
    },
    relative_strength: {
      benchmark: 'NIFTY 50',
      rs_20d: round(rs(20)),
      rs_60d: round(rs(60)),
    },
    levels: {
      high_52w: round(h52),
      low_52w: round(l52),
      pct_from_52w_high: round(h52 ? (close / h52 - 1) * 100 : null),
      pct_from_52w_low: round(l52 ? (close / l52 - 1) * 100 : null),
      nearest_support: round(supports.length ? Math.max(...supports) : null),
      nearest_resistance: round(resistances.length ? Math.min(...resistances) : null),
    },
  };
}
