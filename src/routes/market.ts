import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}

// GET /api/top-gainers?limit=10
router.get('/top-gainers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 50);
  const result = await pool.query(
    `SELECT "rank", "scrip_cd", "scripname", "long_name", "ltradert", "change_val", "change_percent", "record_time"
     FROM bse_top_gainers_losers
     WHERE "type" = 'gainer'
     ORDER BY "rank" ASC
     LIMIT $1`,
    [limit]
  );
  res.json({ count: result.rows.length, gainers: result.rows });
}));

// GET /api/top-losers?limit=10
router.get('/top-losers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 50);
  const result = await pool.query(
    `SELECT "rank", "scrip_cd", "scripname", "long_name", "ltradert", "change_val", "change_percent", "record_time"
     FROM bse_top_gainers_losers
     WHERE "type" = 'loser'
     ORDER BY "rank" ASC
     LIMIT $1`,
    [limit]
  );
  res.json({ count: result.rows.length, losers: result.rows });
}));

// GET /api/volume-shockers?limit=20
router.get('/volume-shockers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 100);
  const result = await pool.query(
    `SELECT "scrip_cd", "scripname", "long_name", "trd_vol", "wkavgqty", "volumechangetimes",
            "ltradert", "change_val", "change_percent", "turnover", "nsurl", "record_date"
     FROM bse_spurt_volume
     WHERE "record_date" = (SELECT MAX("record_date") FROM bse_spurt_volume)
     ORDER BY "volumechangetimes" DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  res.json({ count: result.rows.length, volume_shockers: result.rows });
}));

// GET /api/quote/:symbol - latest snapshot for a ticker (price, volume, etc.)
router.get('/quote/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const result = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm", "ISIN", "SctySrs", "Sgmt",
            "LastPric", "TtlTradgVol", "TtlTrfVal", "TtlNbOfTxsExctd", "TradDt", "BizDt"
     FROM company_stock
     WHERE UPPER("TckrSymb") = UPPER($1)
     LIMIT 1`,
    [symbol]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: `No quote found for symbol '${symbol}'` });
    return;
  }
  res.json(result.rows[0]);
}));

// GET /api/history/:symbol?limit=30 - daily OHLCV history for a ticker
router.get('/history/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const limit = clampLimit(req.query.limit, 30, 1000);
  const result = await pool.query(
    `SELECT hp."record_date", hp."open_price", hp."high_price", hp."low_price",
            hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
     FROM historical_prices hp
     JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
     WHERE UPPER(cs."TckrSymb") = UPPER($1)
     ORDER BY hp."record_date" DESC
     LIMIT $2`,
    [symbol, limit]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: `No history found for symbol '${symbol}'` });
    return;
  }
  res.json({ symbol: symbol.toUpperCase(), count: result.rows.length, history: result.rows });
}));

// GET /api/stocks?search=reliance&limit=20 - search/list instruments
router.get('/stocks', asyncHandler(async (req, res) => {
  const search = String(req.query.search ?? '').trim();
  const limit = clampLimit(req.query.limit, 20, 100);

  if (!search) {
    const result = await pool.query(
      `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm", "ISIN", "SctySrs", "LastPric", "TradDt"
       FROM company_stock
       ORDER BY "TckrSymb" ASC
       LIMIT $1`,
      [limit]
    );
    res.json({ count: result.rows.length, stocks: result.rows });
    return;
  }

  const result = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm", "ISIN", "SctySrs", "LastPric", "TradDt"
     FROM company_stock
     WHERE "TckrSymb" ILIKE $1 OR "FinInstrmNm" ILIKE $1
     ORDER BY "TckrSymb" ASC
     LIMIT $2`,
    [`%${search}%`, limit]
  );
  res.json({ count: result.rows.length, stocks: result.rows });
}));

// GET /api/announcements?limit=20&scrip_cd=500325
router.get('/announcements', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 100);
  const scripCd = req.query.scrip_cd ? String(req.query.scrip_cd) : null;

  const result = scripCd
    ? await pool.query(
        `SELECT * FROM bse_announcements WHERE "scrip_cd" = $1 ORDER BY "news_dt" DESC LIMIT $2`,
        [scripCd, limit]
      )
    : await pool.query(
        `SELECT * FROM bse_announcements ORDER BY "news_dt" DESC LIMIT $1`,
        [limit]
      );

  res.json({ count: result.rows.length, announcements: result.rows });
}));

export default router;
