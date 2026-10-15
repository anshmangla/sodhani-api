import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { computeSnapshot, Bar, IndexPoint } from '../services/taSnapshot';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const BSE_CODE_REGEX = /^\d{6}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!ISO_DATE_REGEX.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// GET /api/ta/:bseCode?date=YYYY-MM-DD
// Technical-analysis snapshot computed from daily bars up to and including
// `date` (no lookahead). On a holiday/weekend the last session before it is used
// and reported as `as_of_session`.
router.get('/ta/:bseCode', asyncHandler(async (req, res) => {
  const { bseCode } = req.params;
  const date = String(req.query.date ?? '').trim();

  if (!BSE_CODE_REGEX.test(bseCode)) {
    res.status(400).json({ error: 'bseCode must be a 6-digit BSE scrip code' });
    return;
  }
  if (!isRealDate(date)) {
    res.status(400).json({ error: 'date query parameter must be a valid ISO date (YYYY-MM-DD)' });
    return;
  }

  const companyRes = await pool.query(
    `SELECT "FinInstrmId", "FinInstrmNm" FROM company_stock WHERE "FinInstrmId" = $1`,
    [bseCode]
  );
  if (companyRes.rows.length === 0) {
    res.status(404).json({ error: `No company found for BSE code '${bseCode}'` });
    return;
  }

  // Only the midnight EOD rows are daily bars; historical_prices also holds
  // ~5-minute intraday ticks (mixed BSE/NSE) that must not be treated as bars.
  // Volume prefers bse_volume_history (BSE bhavcopy) over the bar's own volume:
  // some stretches of historical_prices carry NSE-sized Yahoo volumes, which
  // would make BSE-vs-NSE level shifts look like volume spikes. A 0 is a
  // placeholder row, not a real session volume, so it's treated as missing.
  const barsRes = await pool.query(
    `SELECT to_char(hp.record_date, 'YYYY-MM-DD') AS date,
            hp.open_price, hp.high_price, hp.low_price, hp.close_price,
            COALESCE(NULLIF(b.volume, 0), NULLIF(hp.volume, 0)) AS volume
     FROM historical_prices hp
     LEFT JOIN bse_volume_history b
       ON b.scrip_cd = hp."FinInstrmId" AND b.record_date = hp.record_date::date
     WHERE hp."FinInstrmId" = $1
       AND hp.record_date < $2::date + INTERVAL '1 day'
       AND hp.record_date = date_trunc('day', hp.record_date)
       AND EXTRACT(DOW FROM hp.record_date) NOT IN (0, 6)
       AND hp.close_price IS NOT NULL
     ORDER BY hp.record_date ASC`,
    [bseCode, date]
  );
  if (barsRes.rows.length === 0) {
    res.status(404).json({ error: `No price history for BSE code '${bseCode}' on or before ${date}` });
    return;
  }

  const bars: Bar[] = barsRes.rows.map((r: any) => {
    const close = Number(r.close_price);
    return {
      date: r.date,
      open: r.open_price != null ? Number(r.open_price) : close,
      high: r.high_price != null ? Number(r.high_price) : close,
      low: r.low_price != null ? Number(r.low_price) : close,
      close,
      volume: r.volume != null ? Number(r.volume) : null,
    };
  });

  const niftyRes = await pool.query(
    `SELECT DISTINCT ON (record_time::date)
            to_char(record_time::date, 'YYYY-MM-DD') AS date, value
     FROM nse_index_history
     WHERE symbol = 'NIFTY 50'
       AND record_time < $1::date + INTERVAL '1 day'
     ORDER BY record_time::date ASC, record_time DESC`,
    [date]
  );
  const nifty: IndexPoint[] = niftyRes.rows.map((r: any) => ({ date: r.date, close: Number(r.value) }));

  const snapshot = computeSnapshot(bars, nifty);

  res.json({
    bse_code: bseCode,
    name: companyRes.rows[0].FinInstrmNm ?? null,
    as_of_date: date,
    ...snapshot,
  });
}));

export default router;
