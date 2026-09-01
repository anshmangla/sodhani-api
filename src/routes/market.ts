import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { lttb } from '../utils/lttb';

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

const fs = require('fs').promises;
const path = require('path');
const outputDir = process.env.STATIC_JSON_DIR || '/opt/sodhaniScrap/output';
const consolidatedDir = process.env.CONSOLIDATED_JSON_DIR || '/opt/sodhaniScrap/output_consolidated';

const checkFileExists = async (filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const hasJsonForStock = async (scripCd: string): Promise<boolean> => {
  if (await checkFileExists(path.join(outputDir, `${scripCd}.json`))) return true;
  if (await checkFileExists(path.join(consolidatedDir, `${scripCd}.json`))) return true;

  const stockResult = await pool.query(
    `SELECT "TckrSymb" FROM company_stock WHERE "FinInstrmId"::text = $1 LIMIT 1`,
    [scripCd]
  );
  
  if (stockResult.rows.length > 0) {
    const ticker = stockResult.rows[0].TckrSymb;
    if (await checkFileExists(path.join(outputDir, `${ticker}.json`))) return true;
    if (await checkFileExists(path.join(consolidatedDir, `${ticker}.json`))) return true;
  }
  
  return false;
};

// GET /api/recent-results
// Reads the screener_checkpoint.json and returns tickers updated in the last 14 days
router.get('/recent-results', asyncHandler(async (req, res) => {
  const fs = require('fs').promises;
  const checkpointPath = process.env.SCREENER_CHECKPOINT_PATH || '/opt/sodhani-screener/screener_checkpoint.json';
  
  try {
    await fs.access(checkpointPath);
  } catch {
    res.json([]);
    return;
  }

  let checkpoints: Record<string, number>;
  try {
    const fileData = await fs.readFile(checkpointPath, 'utf-8');
    checkpoints = JSON.parse(fileData);
  } catch (err) {
    console.error("Failed to parse screener checkpoint:", err);
    res.status(500).json({ error: "Failed to read screener data" });
    return;
  }

  // Filter for last 14 days
  const twoWeeksAgo = (Date.now() / 1000) - (14 * 24 * 60 * 60);
  
  // Sort descending by timestamp
  const recentTickers = Object.entries(checkpoints)
    .filter(([ticker, timestamp]) => timestamp >= twoWeeksAgo)
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  if (recentTickers.length === 0) {
    res.json([]);
    return;
  }

  // Fetch names from company_stock
  const result = await pool.query(
    `SELECT "TckrSymb", "FinInstrmNm" FROM company_stock WHERE "TckrSymb" = ANY($1)`,
    [recentTickers]
  );

  const nameMap = new Map();
  for (const row of result.rows) {
    nameMap.set(row.TckrSymb, row.FinInstrmNm);
  }

  const output = recentTickers.map(ticker => ({
    code: ticker,
    name: nameMap.get(ticker) || ticker,
    updated_at: checkpoints[ticker] * 1000 // ms timestamp for frontend
  }));

  res.json(output);
}));

// GET /api/recent-ipos
// Reads the ipo_checkpoint.json and returns IPOs from the last 14 days
router.get('/recent-ipos', asyncHandler(async (req, res) => {
  const fs = require('fs').promises;
  const checkpointPath = process.env.IPO_CHECKPOINT_PATH || '/opt/sodhani-screener/ipo_checkpoint.json';
  
  try {
    await fs.access(checkpointPath);
  } catch {
    // File does not exist or inaccessible
    res.json([]);
    return;
  }

  let checkpoints: Record<string, number>;
  try {
    const fileData = await fs.readFile(checkpointPath, 'utf-8');
    checkpoints = JSON.parse(fileData);
  } catch (err) {
    console.error("Failed to parse IPO checkpoint:", err);
    res.status(500).json({ error: "Failed to read IPO data" });
    return;
  }

  // Filter for last 14 days
  const twoWeeksAgo = (Date.now() / 1000) - (14 * 24 * 60 * 60);
  
  const recentTickers = Object.entries(checkpoints)
    .filter(([ticker, timestamp]) => timestamp >= twoWeeksAgo)
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  if (recentTickers.length === 0) {
    res.json([]);
    return;
  }

  // Fetch names from company_stock
  const result = await pool.query(
    `SELECT "TckrSymb", "FinInstrmNm" FROM company_stock WHERE "TckrSymb" = ANY($1)`,
    [recentTickers]
  );

  const nameMap = new Map();
  for (const row of result.rows) {
    nameMap.set(row.TckrSymb, row.FinInstrmNm);
  }

  const output = recentTickers.map(ticker => ({
    code: ticker,
    name: nameMap.get(ticker) || ticker,
    listed_at: checkpoints[ticker] * 1000
  }));

  res.json(output);
}));

// GET /api/top-gainers?limit=10
router.get('/top-gainers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 50);
  const result = await pool.query(
    `SELECT "rank", "scrip_cd", "scripname", "long_name", "ltradert", "change_val", "change_percent", "record_time"
     FROM bse_top_gainers_losers
     WHERE "type" = 'gainer' 
       AND "record_time"::DATE = (SELECT MAX("record_time")::DATE FROM bse_top_gainers_losers)
     ORDER BY "change_percent" DESC
     LIMIT 200`
  );
  
  const validGainers = [];
  for (const row of result.rows) {
    if (validGainers.length >= limit) break;
    if (await hasJsonForStock(row.scrip_cd)) {
      validGainers.push(row);
    }
  }

  res.json({ count: validGainers.length, gainers: validGainers });
}));

// GET /api/top-losers?limit=10
router.get('/top-losers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 50);
  const result = await pool.query(
    `SELECT "rank", "scrip_cd", "scripname", "long_name", "ltradert", "change_val", "change_percent", "record_time"
     FROM bse_top_gainers_losers
     WHERE "type" = 'loser'
       AND "record_time"::DATE = (SELECT MAX("record_time")::DATE FROM bse_top_gainers_losers)
     ORDER BY "change_percent" ASC
     LIMIT 200`
  );

  const validLosers = [];
  for (const row of result.rows) {
    if (validLosers.length >= limit) break;
    if (await hasJsonForStock(row.scrip_cd)) {
      validLosers.push(row);
    }
  }

  res.json({ count: validLosers.length, losers: validLosers });
}));

// GET /api/volume-shockers?limit=20
router.get('/volume-shockers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 100);
  const result = await pool.query(
    `SELECT "scrip_cd", "scripname", "long_name", "trd_vol", "wkavgqty", "volumechangetimes",
            "ltradert", "change_val", "change_percent", "turnover", "nsurl", "record_date"
     FROM bse_spurt_volume
     WHERE "record_date"::DATE = (SELECT MAX("record_date")::DATE FROM bse_spurt_volume)
     ORDER BY "volumechangetimes" DESC NULLS LAST
     LIMIT 200`
  );

  const validShockers = [];
  for (const row of result.rows) {
    if (validShockers.length >= limit) break;
    if (await hasJsonForStock(row.scrip_cd)) {
      validShockers.push(row);
    }
  }

  res.json({ count: validShockers.length, volume_shockers: validShockers });
}));

// GET /api/quote/:symbol - latest snapshot for a ticker (price, volume, etc.)
router.get('/quote/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const result = await pool.query(
    `SELECT cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm",
            hp_latest."true_close" AS "LastPric",
            hp_latest."true_volume" AS "TtlTradgVol",
            (hp_latest."true_volume"::float * hp_latest."true_close"::float) AS "TtlTrfVal",
            hp_latest."true_date" AS "TradDt",
            hp_latest."true_open" AS "OpenPric",
            hp_latest."true_high" AS "HighPric",
            hp_latest."true_low" AS "LowPric",
            hp_latest."true_close" AS "ClosePric",
            (hp_latest."true_close"::float - hp_latest."true_open"::float) AS "ChangeVal",
            CASE WHEN hp_latest."true_open"::float > 0
              THEN ((hp_latest."true_close"::float - hp_latest."true_open"::float) / hp_latest."true_open"::float) * 100
              ELSE 0
            END AS "ChangePercent"
     FROM company_stock cs
     LEFT JOIN LATERAL (
       SELECT
         MAX(record_date) as true_date,
         (array_agg(open_price ORDER BY record_date ASC))[1] as true_open,
         MAX(high_price) as true_high,
         MIN(low_price) as true_low,
         (array_agg(close_price ORDER BY record_date DESC))[1] as true_close,
         SUM(volume) as true_volume
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp.record_date) = (
           SELECT MAX(DATE(record_date))
           FROM historical_prices
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
     ) hp_latest ON true
     WHERE UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1
     LIMIT 1`,
    [symbol]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: `No quote found for symbol '${symbol}'` });
    return;
  }
  res.json(result.rows[0]);
}));

const MAX_BATCH_QUOTE_CODES = 50;

// GET /api/quotes?codes=500325,532540,RELIANCE - same row shape as
// /api/quote/:symbol for each requested ticker/scrip code, batched into one
// round trip. Unknown codes are silently omitted rather than 404ing the
// whole request - callers diff the requested list against `quotes` to see
// what didn't resolve.
router.get('/quotes', asyncHandler(async (req, res) => {
  const raw = String(req.query.codes ?? '');
  const codes = Array.from(
    new Set(
      raw
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    )
  ).slice(0, MAX_BATCH_QUOTE_CODES);

  if (codes.length === 0) {
    res.status(400).json({ error: "Query param 'codes' is required (comma-separated ticker symbols or scrip codes)." });
    return;
  }

  const upperCodes = codes.map((c) => c.toUpperCase());

  const result = await pool.query(
    `SELECT cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm",
            hp_latest."true_close" AS "LastPric",
            hp_latest."true_volume" AS "TtlTradgVol",
            (hp_latest."true_volume"::float * hp_latest."true_close"::float) AS "TtlTrfVal",
            hp_latest."true_date" AS "TradDt",
            hp_latest."true_open" AS "OpenPric",
            hp_latest."true_high" AS "HighPric",
            hp_latest."true_low" AS "LowPric",
            hp_latest."true_close" AS "ClosePric",
            (hp_latest."true_close"::float - hp_latest."true_open"::float) AS "ChangeVal",
            CASE WHEN hp_latest."true_open"::float > 0
              THEN ((hp_latest."true_close"::float - hp_latest."true_open"::float) / hp_latest."true_open"::float) * 100
              ELSE 0
            END AS "ChangePercent"
     FROM company_stock cs
     LEFT JOIN LATERAL (
       SELECT
         MAX(record_date) as true_date,
         (array_agg(open_price ORDER BY record_date ASC))[1] as true_open,
         MAX(high_price) as true_high,
         MIN(low_price) as true_low,
         (array_agg(close_price ORDER BY record_date DESC))[1] as true_close,
         SUM(volume) as true_volume
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp.record_date) = (
           SELECT MAX(DATE(record_date))
           FROM historical_prices
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
     ) hp_latest ON true
     WHERE UPPER(cs."TckrSymb") = ANY($1) OR cs."FinInstrmId"::text = ANY($2)`,
    [upperCodes, codes]
  );

  res.json({ count: result.rows.length, quotes: result.rows });
}));

// GET /api/history/:symbol?range=1m&chartType=line
router.get('/history/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  
  const chartType = String(req.query.chartType || 'candlestick').toLowerCase();
  if (!['line', 'candlestick'].includes(chartType)) {
    res.status(400).json({ error: `Unsupported chartType '${chartType}'. Supported values: 'line', 'candlestick'.` });
    return;
  }
  let rawRange = String(req.query.range || req.query.query || '1m').toLowerCase();
  
  // Custom date ranges
  const startDate = req.query.start_date ? String(req.query.start_date) : null;
  const endDate = req.query.end_date ? String(req.query.end_date) : null;

  let timeFilter = '';
  let durationDays = 30; // default for 1m
  let range = rawRange;

  if (startDate && endDate) {
    range = 'custom';
    timeFilter = `AND hp."record_date" >= $3 AND hp."record_date" <= $4`;
    durationDays = (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 3600 * 24);
  } else {
    // Determine range and rough duration for bucketing strategy
    if (['d', '1d'].includes(rawRange)) { range = '1d'; durationDays = 1; }
    else if (['w', '1w'].includes(rawRange)) { range = '1w'; durationDays = 7; }
    else if (['m', '1m'].includes(rawRange)) { range = '1m'; durationDays = 30; }
    else if (['y', '1y'].includes(rawRange)) { range = '1y'; durationDays = 365; }
    else if (['5y'].includes(rawRange)) { range = '5y'; durationDays = 365 * 5; }
    else if (['max'].includes(rawRange)) { range = 'max'; durationDays = 99999; }
    else { range = '1m'; durationDays = 30; } // default fallback

    if (range === '1d') {
      // Same shape as the other ranges (sargable >= against an interval) so
      // this can use an index range scan instead of wrapping record_date in
      // DATE() on both sides, which forced a full scan of the symbol's history.
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '1 day'`;
    } else if (range === '1w') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '7 days'`;
    } else if (range === '1m') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '1 month'`;
    } else if (range === '1y') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '1 year'`;
    } else if (range === '5y') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId") - INTERVAL '5 years'`;
    }
  }

  const limit = clampLimit(req.query.limit, 10000, 50000);
  const downsample = 100;
  
  let sql = '';
  let queryParams: any[] = [symbol, limit];
  if (range === 'custom') {
    queryParams.push(startDate, endDate);
  }

  const isLineChart = chartType === 'line';
  // historical_prices gets a new intraday row roughly every 5 minutes during
  // market hours (bseLiveSync), not just one EOD row per day — so 1D is the
  // one range that must NOT collapse same-day rows down to a single bar.
  const isIntraday = range === '1d';

  if (isLineChart) {
    // 2. Algorithmic Downsampling
    // For line/area charts, fetch raw EOD data ordered ASC for LTTB downsampling
    sql = isIntraday
      ? `SELECT hp."record_date", hp."open_price", hp."high_price", hp."low_price",
                hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
         FROM historical_prices hp
         JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
         WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
           ${timeFilter}
         ORDER BY hp."record_date" ASC
         LIMIT $2`
      : `SELECT DISTINCT ON (DATE(hp."record_date"))
              hp."record_date", hp."open_price", hp."high_price", hp."low_price",
              hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
       FROM historical_prices hp
       JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
       WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
         ${timeFilter}
       ORDER BY DATE(hp."record_date") ASC, hp."record_date" DESC
       LIMIT $2`;
  } else {
    // 1. Time-Based Bucketing
    // Candlestick/Bar charts via native PostgreSQL Roll-up
    if (durationDays < 365) {
      // Duration < 1 Year: Raw Daily Data (or every intraday snapshot for 1D)
      sql = isIntraday
        ? `SELECT hp."record_date", hp."open_price", hp."high_price", hp."low_price",
                  hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
           FROM historical_prices hp
           JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
           WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
             ${timeFilter}
           ORDER BY hp."record_date" DESC
           LIMIT $2`
        : `SELECT DISTINCT ON (DATE(hp."record_date"))
                hp."record_date", hp."open_price", hp."high_price", hp."low_price",
                hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
         FROM historical_prices hp
         JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
         WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
           ${timeFilter}
         ORDER BY DATE(hp."record_date") DESC, hp."record_date" DESC
         LIMIT $2`;
    } else if (durationDays <= 365 * 5) {
      // Duration 1 to 5 Years: Weekly Buckets
      sql = `SELECT 
                date_trunc('week', hp."record_date") as record_date,
                (array_agg(hp."open_price" ORDER BY hp."record_date" ASC))[1] as open_price,
                MAX(hp."high_price") as high_price,
                MIN(hp."low_price") as low_price,
                (array_agg(hp."close_price" ORDER BY hp."record_date" DESC))[1] as close_price,
                SUM(hp."volume") as volume
             FROM historical_prices hp
             JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
             WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
               ${timeFilter}
             GROUP BY date_trunc('week', hp."record_date")
             ORDER BY record_date DESC
             LIMIT $2`;
    } else {
      // Duration > 5 Years (or "max"): Monthly Buckets
      sql = `SELECT 
                date_trunc('month', hp."record_date") as record_date,
                (array_agg(hp."open_price" ORDER BY hp."record_date" ASC))[1] as open_price,
                MAX(hp."high_price") as high_price,
                MIN(hp."low_price") as low_price,
                (array_agg(hp."close_price" ORDER BY hp."record_date" DESC))[1] as close_price,
                SUM(hp."volume") as volume
             FROM historical_prices hp
             JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
             WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
               ${timeFilter}
             GROUP BY date_trunc('month', hp."record_date")
             ORDER BY record_date DESC
             LIMIT $2`;
    }
  }

  const result = await pool.query(sql, queryParams);

  if (result.rows.length === 0) {
    res.status(404).json({ error: `No history found for symbol '${symbol}'` });
    return;
  }

  let history = result.rows;

  if (isLineChart) {
    // Data is currently ASC. LTTB executes sequentially.
    if (history.length > downsample) {
      history = lttb(
        history, 
        downsample, 
        (d) => new Date(d.record_date).getTime(),
        (d) => Number(d.close_price)
      );
    }
    // Reverse it back to DESC to match the API contract expected by frontend
    history.reverse();
  }

  // Percentage change across the whole returned window, against the opening
  // price of the earliest bar — same convention as /api/quote's ChangePercent.
  // Note: history is ordered DESC by date (newest first, oldest last), so the
  // earliest bar in the window sits at the end of the array.
  const latestPrice = Number(history[0].close_price);
  const earliestOpen = Number(history[history.length - 1].open_price);
  const changePercent = earliestOpen ? ((latestPrice - earliestOpen) / earliestOpen) * 100 : 0;

  res.json({
    symbol: symbol.toUpperCase(), 
    range,
    chartType,
    count: history.length, 
    change_percent: changePercent,
    history 
  });
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
     WHERE "TckrSymb" ILIKE $1 OR "FinInstrmNm" ILIKE $1 OR "ISIN" ILIKE $1 OR "FinInstrmId"::text = $2
     ORDER BY "TckrSymb" ASC
     LIMIT $3`,
    [`%${search}%`, search, limit]
  );
  res.json({ count: result.rows.length, stocks: result.rows });
}));

// GET /api/announcements/:symbol?limit=20
router.get('/announcements/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const limit = clampLimit(req.query.limit, 20, 100);

  const result = await pool.query(
    `SELECT a.* 
     FROM bse_announcements a
     LEFT JOIN company_stock cs ON a.scrip_cd = cs."FinInstrmId"::text
     WHERE a.scrip_cd = $1 OR UPPER(cs."TckrSymb") = UPPER($1)
     ORDER BY a."news_dt" DESC 
     LIMIT $2`,
    [symbol, limit]
  );

  res.json({ count: result.rows.length, announcements: result.rows });
}));

// GET /api/research-reports?limit=20
router.get('/research-reports', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 100);

  const result = await pool.query(
    `SELECT "id", "company", "fin_instrm_id", "tckr_symb", "action", "target_price", "broker", "report_date", "report_url"
     FROM research_reports
     ORDER BY "report_date" DESC, "id" DESC
     LIMIT $1`,
    [limit]
  );

  res.json({ count: result.rows.length, reports: result.rows });
}));

// GET /api/screener?page=1&limit=25&industry=Pharmaceuticals&sort_by=mkt_cap&order=desc
router.get('/screener', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const industry = req.query.industry ? String(req.query.industry) : null;
  const sortByParam = req.query.sort_by ? String(req.query.sort_by).toLowerCase() : 'mkt_cap';
  const orderParam = req.query.order ? String(req.query.order).toLowerCase() : 'desc';

  // Map sort_by to actual columns to prevent SQL injection
  const sortMap: Record<string, string> = {
    'cmp': 'cmp',
    'pe': 'pe',
    'mkt_cap': 'mkt_cap',
    'div_yld': 'div_yld',
    'np_qtr': 'np_qtr',
    'profit_var': 'profit_var',
    'sales_qtr': 'sales_qtr',
    'sales_var': 'sales_var',
    'roce': 'roce',
  };
  const sortColumn = sortMap[sortByParam] || sortMap['mkt_cap'];
  const sortOrder = orderParam === 'asc' ? 'ASC' : 'DESC';

  let whereClause = '';
  let params: any[] = [];

  if (industry) {
    // Handle nested codes like "IN02/IN0201" by taking the last part
    const parts = industry.split('/');
    const code = parts[parts.length - 1];

    whereClause = 'WHERE ci.leaf_code LIKE $1';
    params.push(`${code}%`);
  }

  // Both stock_metrics and company_sectors can carry more than one row for
  // the same company_stock row (a ticker-keyed row and a numeric-BSE-code-
  // keyed row, independently stale) - a plain join fans that out into
  // duplicate companies in the result. DISTINCT ON picks one deterministic
  // row per company_stock row instead.
  //
  // No UPPER() here: TckrSymb/fin_instrm_id/symbol are already 100% uppercase
  // in this data (verified directly against production), and UPPER() on
  // either side of the join defeats Postgres's ability to use the primary
  // key indexes on company_sectors.fin_instrm_id / stock_metrics.symbol -
  // it falls back to a nested-loop scan comparing every company_stock row
  // against every row of the other table (measured: ~19s for one industry
  // filter, vs ~70ms with plain equality). The WHERE filter lives inside the
  // CTE (not wrapped around it) so it narrows company_sectors before the
  // joins run, rather than after.
  const baseCte = `
    WITH base AS (
      SELECT DISTINCT ON (cs."FinInstrmId")
        cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm",
        ci.sector_name, ci.industry_name, ci.leaf_name, ci.leaf_code,
        sm.cmp, sm.pe, sm.mkt_cap, sm.div_yld, sm.np_qtr, sm.profit_var, sm.sales_qtr, sm.sales_var, sm.roce
      FROM company_stock cs
      JOIN stock_metrics sm ON sm.symbol = cs."FinInstrmId"::text OR sm.symbol = cs."TckrSymb"
      LEFT JOIN company_sectors ci ON ci.fin_instrm_id = cs."FinInstrmId"::text OR ci.fin_instrm_id = cs."TckrSymb"
      ${whereClause}
      ORDER BY cs."FinInstrmId", sm.mkt_cap DESC NULLS LAST
    )
  `;

  // Get total count for pagination
  const countQuery = `
    ${baseCte}
    SELECT COUNT(*) FROM base
  `;
  const countResult = await pool.query(countQuery, params);
  const totalCount = parseInt(countResult.rows[0].count, 10);

  // Get paginated data
  const dataParams = [...params, limit, offset];
  const dataQuery = `
    ${baseCte}
    SELECT
      "FinInstrmId", "TckrSymb", "FinInstrmNm",
      sector_name, industry_name, leaf_name,
      cmp, pe, mkt_cap, div_yld, np_qtr, profit_var, sales_qtr, sales_var, roce
    FROM base
    ORDER BY ${sortColumn} ${sortOrder} NULLS LAST
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  const result = await pool.query(dataQuery, dataParams);

  res.json({
    data: result.rows,
    pagination: {
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit)
    }
  });
}));

// GET /api/technical/:symbol
router.get('/technical/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;

  const result = await pool.query(
    `SELECT ta.ta_data, ta.updated_at
     FROM technical_analysis ta
     JOIN company_stock cs ON ta.fin_instrm_id = cs."FinInstrmId"::text
     WHERE cs."FinInstrmId"::text = $1 OR UPPER(cs."TckrSymb") = UPPER($1)`,
    [symbol]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: `Technical analysis not found for symbol '${symbol}'.` });
    return;
  }

  res.json({
    data: result.rows[0].ta_data,
    updated_at: result.rows[0].updated_at
  });
}));

// Helper for static stock data search with BSE -> NSE fallback
const searchStaticStock = async (dir: string, query: string) => {
  const fs = require('fs').promises;
  const path = require('path');

  const tryReadFile = async (directory: string, filename: string) => {
    try {
      const filePath = path.join(directory, filename);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  };

  const findFileCaseInsensitive = async (directory: string, targetBase: string) => {
    try {
      const files = await fs.readdir(directory);
      const targetLower = targetBase.toLowerCase();
      const match = files.find((f: string) => f.toLowerCase() === targetLower || f.toLowerCase() === targetLower + '.json');
      if (match) {
        return await tryReadFile(directory, match);
      }
    } catch (e) {
      // Ignore directory read errors
    }
    return null;
  };

  // 1. Try exact or case-insensitive for the query
  const candidates = [query, `${query}.json`];
  let data = null;
  for (const filename of candidates) {
    if (data) break;
    data = await tryReadFile(dir, filename);
  }
  if (!data) data = await findFileCaseInsensitive(dir, query);

  // 2. If not found, intelligently check mappings (both NSE->BSE and BSE->NSE)
  if (!data) {
    try {
      const mappingsPath = path.resolve(__dirname, '../../exchange_code_mappings.json');
      const mappingsData = await fs.readFile(mappingsPath, 'utf-8');
      const mappingsJson = JSON.parse(mappingsData);
      const nseToBse = mappingsJson.nse_to_bse || {};
      
      // Compute BSE -> NSE mapping
      const bseToNse: Record<string, string> = {};
      for (const [nse, bse] of Object.entries(nseToBse)) {
        if (typeof bse === 'string') bseToNse[bse] = nse;
      }
      
      const upperQuery = query.toUpperCase();
      const bseCode = nseToBse[upperQuery];
      const nseSymbol = bseToNse[upperQuery];

      // Try BSE code if it was an NSE ticker
      if (bseCode) {
        const bseCandidates = [bseCode, `${bseCode}.json`];
        for (const filename of bseCandidates) {
          if (data) break;
          data = await tryReadFile(dir, filename);
        }
        if (!data) data = await findFileCaseInsensitive(dir, bseCode);
      }

      // Try NSE ticker if it was a BSE code
      if (!data && nseSymbol) {
        const nseCandidates = [nseSymbol, `${nseSymbol}.json`];
        for (const filename of nseCandidates) {
          if (data) break;
          data = await tryReadFile(dir, filename);
        }
        if (!data) data = await findFileCaseInsensitive(dir, nseSymbol);
      }
    } catch (e) {
      console.error("Error reading exchange_code_mappings.json:", e);
    }
  }

  return data;
};

// GET /api/static-stock?query=500325
router.get('/static-stock', asyncHandler(async (req, res) => {
  const query = req.query.query ? String(req.query.query).trim() : '';
  if (!query) {
    res.status(400).json({ error: 'Query parameter "query" (stock name or number) is required' });
    return;
  }

  const outputDir = process.env.STATIC_JSON_DIR || '/opt/sodhaniScrap/output';
  let data = await searchStaticStock(outputDir, query);
  
  let fallbackError = null;
  let fallbackDebug: any = null;
  if (!data) {
    try {
      const dbRes = await pool.query(
        `SELECT "FinInstrmId" FROM company_stock WHERE TRIM(UPPER("TckrSymb")) = TRIM(UPPER($1)) OR TRIM("FinInstrmId"::text) = TRIM($1) LIMIT 1`,
        [query]
      );
      fallbackDebug = { rowsFound: dbRes.rows.length };
      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const rawId = row.FinInstrmId ?? row.fininstrmid ?? Object.values(row)[0];
        fallbackDebug.rawId = rawId;
        if (rawId) {
          const finId = rawId.toString();
          fallbackDebug.finId = finId;
          data = await searchStaticStock(outputDir, finId);
          fallbackDebug.dataFound = !!data;
        }
      }
    } catch (e) {
      console.error("Database fallback failed:", e);
      fallbackError = String(e);
    }
  }

  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `Static JSON not found for '${query}'`, fallbackError, fallbackDebug });
  }
}));

// GET /api/static-stock-consolidated?query=500325
router.get('/static-stock-consolidated', asyncHandler(async (req, res) => {
  const query = req.query.query ? String(req.query.query).trim() : '';
  if (!query) {
    res.status(400).json({ error: 'Query parameter "query" (stock name or number) is required' });
    return;
  }

  const consolidatedDir = process.env.CONSOLIDATED_JSON_DIR || '/opt/sodhaniScrap/output_consolidated';
  let data = await searchStaticStock(consolidatedDir, query);

  // Ultimate fallback: if not found by name or static mapping, check the live database
  // to map an incoming TckrSymb (like INTLCOMBQ) back to its FinInstrmId (like 505737)
  if (!data) {
    try {
      const dbRes = await pool.query(
        `SELECT "FinInstrmId" FROM company_stock WHERE TRIM(UPPER("TckrSymb")) = TRIM(UPPER($1)) OR TRIM("FinInstrmId"::text) = TRIM($1) LIMIT 1`,
        [query]
      );
      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const rawId = row.FinInstrmId ?? row.fininstrmid ?? Object.values(row)[0];
        if (rawId) {
          const finId = rawId.toString();
          data = await searchStaticStock(consolidatedDir, finId);
        }
      }
    } catch (e) {
      console.error("Database fallback failed:", e);
    }
  }

  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `Consolidated static JSON not found for '${query}'` });
  }
}));

// GET /api/metrics/:symbol
router.get('/metrics/:symbol', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol;
  
  const result = await pool.query(
    `SELECT sm.* 
     FROM stock_metrics sm
     LEFT JOIN company_stock cs ON 
        (sm.symbol = cs."FinInstrmId"::text OR UPPER(sm.symbol) = UPPER(cs."TckrSymb"))
     WHERE UPPER(sm.symbol) = UPPER($1) 
        OR UPPER(cs."TckrSymb") = UPPER($1) 
        OR cs."FinInstrmId"::text = $1
     LIMIT 1`,
    [symbol]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: `Metrics not found for symbol '${symbol}'. They may not have been calculated yet.` });
    return;
  }

  const row = result.rows[0];
  const metrics = {
    "CMP": parseFloat(row.cmp),
    "P/E": parseFloat(row.pe),
    "Mkt Cap": parseFloat(row.mkt_cap),
    "Div Yld": parseFloat(row.div_yld),
    "NP Qtr": parseFloat(row.np_qtr),
    "Profit Var": parseFloat(row.profit_var),
    "Sales Qtr": parseFloat(row.sales_qtr),
    "Sales Var": parseFloat(row.sales_var),
    "ROCE": parseFloat(row.roce),
    "updated_at": row.updated_at
  };

  res.json(metrics);
}));

// ── Indices: shared BSE/NSE plumbing ─────────────────────────────────────────
//
// BSE's bse_index_history separates daily bars from intraday ticks with
// session IS NULL / IS NOT NULL. NSE's nse_index_history never sets session
// (nseIndicesSync.ts writes it as NULL on every row) - there the daily bar
// is written at midnight and intraday ticks at the feed's real timestamp, so
// the discriminator is the time-of-day component of record_time instead.
type IndexSrc = 'BSE' | 'NSE';

const INDEX_SOURCES: Record<IndexSrc, {
  indexTable: string;
  idCol: string;
  nameCol: string;
  historyTable: string;
  historyIdCol: string;
  dailyFilter: string;
  intradayFilter: string;
  constituentsTable: string;
  constituentsIdCol: string;
  constituentsStockCol: string;
}> = {
  BSE: {
    indexTable: 'bse_indices', idCol: 'sccode', nameCol: 'scname',
    historyTable: 'bse_index_history', historyIdCol: 'sccode',
    dailyFilter: `"session" IS NULL`, intradayFilter: `"session" IS NOT NULL`,
    constituentsTable: 'bse_index_constituents', constituentsIdCol: 'sccode', constituentsStockCol: '"FinInstrmId"',
  },
  NSE: {
    indexTable: 'nse_indices', idCol: 'symbol', nameCol: 'name',
    historyTable: 'nse_index_history', historyIdCol: 'symbol',
    dailyFilter: `"record_time"::time = '00:00:00'`, intradayFilter: `"record_time"::time <> '00:00:00'`,
    constituentsTable: 'nse_index_constituents', constituentsIdCol: 'index_symbol', constituentsStockCol: 'stock_symbol',
  },
};

// Parses ?src=; returns null when absent (both exchanges), undefined and
// writes a 400 response when the value is unrecognized (caller must return).
function parseSrcParam(res: Response, raw: unknown): IndexSrc | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).toUpperCase();
  if (v === 'BSE' || v === 'NSE') return v;
  res.status(400).json({ error: `Invalid src '${raw}'. Expected 'bse' or 'nse'.` });
  return undefined;
}

// Strips everything but letters/digits before comparing, so "NIFTY 50",
// "NIFTY%2050", "nifty-50" and "NIFTY50" all resolve to the same index.
function normalizeCodeExpr(expr: string): string {
  return `UPPER(REGEXP_REPLACE(${expr}, '[^A-Za-z0-9]', '', 'g'))`;
}

async function resolveIndex(code: string, srcFilter: IndexSrc | null): Promise<{ src: IndexSrc; code: string; name: string } | null> {
  const order: IndexSrc[] = srcFilter ? [srcFilter] : ['BSE', 'NSE'];
  for (const src of order) {
    const cfg = INDEX_SOURCES[src];
    const r = await pool.query(
      `SELECT "${cfg.idCol}" AS code, "${cfg.nameCol}" AS name
       FROM ${cfg.indexTable}
       WHERE ${normalizeCodeExpr(`"${cfg.idCol}"`)} = ${normalizeCodeExpr('$1')}
       LIMIT 1`,
      [code]
    );
    if (r.rows.length > 0) {
      return { src, code: r.rows[0].code, name: r.rows[0].name };
    }
  }
  return null;
}

// GET /api/indices?src=bse|nse - latest entry (daily bar) for every index.
// Rows are tagged src; BSE rows also keep sccode/scname for back-compat.
router.get('/indices', asyncHandler(async (req, res) => {
  const src = parseSrcParam(res, req.query.src);
  if (src === undefined) return;

  const branches: string[] = [];
  if (src === null || src === 'NSE') {
    branches.push(`
      SELECT 'NSE' AS src, n."symbol" AS code, n."name" AS name,
             NULL::varchar AS sccode, NULL::varchar AS scname,
             h."record_time", h."value", h."prev_close",
             h."change_val", h."change_pct",
             h."advances", h."declines", h."unchanged",
             h."updated_at"
      FROM nse_indices n
      JOIN LATERAL (
        SELECT "record_time", "value", "prev_close", "change_val", "change_pct",
               "advances", "declines", "unchanged", "updated_at"
        FROM nse_index_history
        WHERE "symbol" = n."symbol" AND "record_time"::time = '00:00:00'
        ORDER BY "record_time" DESC
        LIMIT 1
      ) h ON TRUE
    `);
  }
  if (src === null || src === 'BSE') {
    branches.push(`
      SELECT 'BSE' AS src, i."sccode" AS code, i."scname" AS name,
             i."sccode" AS sccode, i."scname" AS scname,
             h."record_time", h."value", h."prev_close",
             h."change_val", h."change_pct",
             NULL::int AS advances, NULL::int AS declines, NULL::int AS unchanged,
             h."updated_at"
      FROM bse_indices i
      JOIN LATERAL (
        SELECT "record_time", "value", "prev_close", "change_val", "change_pct", "updated_at"
        FROM bse_index_history
        WHERE "sccode" = i."sccode" AND "session" IS NULL
        ORDER BY "record_time" DESC
        LIMIT 1
      ) h ON TRUE
    `);
  }

  const result = await pool.query(
    `SELECT * FROM (${branches.join(' UNION ALL ')}) combined
     ORDER BY CASE WHEN src = 'NSE' THEN 0 ELSE 1 END, name`
  );
  res.json({ count: result.rows.length, indices: result.rows });
}));

const INDEX_RANGES: Record<string, { interval: string; intraday: boolean }> = {
  '1d': { interval: '24 hours', intraday: true },
  '1w': { interval: '7 days', intraday: false },
  '6m': { interval: '6 months', intraday: false },
  '1y': { interval: '1 year', intraday: false },
};

// GET /api/indices/:code/history?range=1d|1w|6m|1y&src=bse|nse
// :code auto-resolves to a BSE or NSE index (BSE codes are numeric, NSE
// codes all start with "NIFTY", so there is no collision); ?src= disambiguates
// explicitly if ever needed. 1d serves intraday ticks; all other ranges serve
// daily bars.
router.get('/indices/:code/history', asyncHandler(async (req, res) => {
  const { code } = req.params;
  const srcParam = parseSrcParam(res, req.query.src);
  if (srcParam === undefined) return;

  const rawRange = String(req.query.range || '1d').toLowerCase();
  const range = INDEX_RANGES[rawRange] ? rawRange : '1d';
  const cfg = INDEX_RANGES[range];
  const limit = clampLimit(req.query.limit, 5000, 20000);

  const resolved = await resolveIndex(code, srcParam ?? null);
  if (!resolved) {
    res.status(404).json({ error: `Index '${code}' not found` });
    return;
  }
  const { src, code: resolvedCode, name } = resolved;
  const source = INDEX_SOURCES[src];

  const sessionFilter = cfg.intraday ? source.intradayFilter : source.dailyFilter;
  const breadthCols = src === 'NSE'
    ? `"advances", "declines", "unchanged"`
    : `NULL::int AS advances, NULL::int AS declines, NULL::int AS unchanged`;

  const result = await pool.query(
    `SELECT "record_time", "value", "prev_close", "change_val", "change_pct", "session", ${breadthCols}
     FROM ${source.historyTable}
     WHERE "${source.historyIdCol}" = $1
       AND ${sessionFilter}
       AND "record_time" >= (
             SELECT MAX("record_time") FROM ${source.historyTable}
             WHERE "${source.historyIdCol}" = $1 AND ${sessionFilter}
           ) - INTERVAL '${cfg.interval}'
     ORDER BY "record_time" DESC
     LIMIT $2`,
    [resolvedCode, limit]
  );

  const history = result.rows;
  let changePercent = 0;
  if (history.length > 0) {
    const latestValue = Number(history[0].value);
    const earliestValue = Number(history[history.length - 1].value);
    changePercent = earliestValue ? ((latestValue - earliestValue) / earliestValue) * 100 : 0;
  }

  res.json({
    src,
    code: resolvedCode,
    name,
    sccode: src === 'BSE' ? resolvedCode : null,
    scname: src === 'BSE' ? name : null,
    range,
    count: history.length,
    change_percent: changePercent,
    history,
  });
}));

// GET /api/indices/:code/constituents?src=bse|nse
// Member stocks for a BSE or NSE index, joined to company_stock and each
// stock's latest historical_prices row for LTP/day-change. BSE membership
// (bse_index_constituents) is capped at 30 by the upstream heatmap feed for
// indices with more members - callers should not assume completeness for
// broad indices like BSE 500/1000.
router.get('/indices/:code/constituents', asyncHandler(async (req, res) => {
  const { code } = req.params;
  const srcParam = parseSrcParam(res, req.query.src);
  if (srcParam === undefined) return;

  const resolved = await resolveIndex(code, srcParam ?? null);
  if (!resolved) {
    res.status(404).json({ error: `Index '${code}' not found` });
    return;
  }
  const { src, code: resolvedCode, name } = resolved;
  const source = INDEX_SOURCES[src];

  const result = await pool.query(
    `SELECT cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm",
            hp_latest."close_price" AS last_price,
            CASE WHEN hp_latest."open_price"::float > 0
              THEN ((hp_latest."close_price"::float - hp_latest."open_price"::float) / hp_latest."open_price"::float) * 100
              ELSE 0
            END AS change_percent,
            hp_latest."volume"
     FROM ${source.constituentsTable} c
     JOIN company_stock cs ON cs."FinInstrmId" = c.${source.constituentsStockCol}
     LEFT JOIN LATERAL (
       SELECT open_price, close_price, volume
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
       ORDER BY record_date DESC
       LIMIT 1
     ) hp_latest ON TRUE
     WHERE c."${source.constituentsIdCol}" = $1
     ORDER BY change_percent DESC NULLS LAST`,
    [resolvedCode]
  );

  res.json({
    src,
    code: resolvedCode,
    name,
    count: result.rows.length,
    constituents: result.rows,
  });
}));

// GET /api/search-index
// Returns a unified search index for the frontend (Companies and Industries), ranked dynamically by market cap.
router.get('/search-index', asyncHandler(async (req, res) => {
  // Fetch companies
  //
  // No UPPER() here: TckrSymb/fin_instrm_id/symbol are already 100%
  // uppercase in this data (verified directly against production). UPPER()
  // on either side of a join defeats Postgres's ability to use the primary
  // key indexes on company_stock/stock_metrics, forcing a nested-loop scan
  // per company_sectors row against every company_stock/stock_metrics row -
  // measured as catastrophically slow (multi-second) for the /api/screener
  // and /api/company/:symbol/peers endpoints that had the same pattern.
  // DISTINCT ON collapses the still-possible stock_metrics fan-out (a
  // ticker-keyed and a numeric-BSE-code-keyed row for the same company)
  // back to one row per company_sectors entry.
  const companyQuery = `
    SELECT DISTINCT ON (c.fin_instrm_id)
      c.fin_instrm_id as "code",
      c.company_name as "label",
      c.leaf_name as "leaf",
      sm.mkt_cap as "mkt_cap"
    FROM company_sectors c
    LEFT JOIN company_stock cs ON cs."FinInstrmId"::text = c.fin_instrm_id OR cs."TckrSymb" = c.fin_instrm_id
    LEFT JOIN stock_metrics sm ON sm.symbol = cs."FinInstrmId"::text OR sm.symbol = cs."TckrSymb"
    WHERE c.company_name IS NOT NULL
    ORDER BY c.fin_instrm_id, sm.mkt_cap DESC NULLS LAST
  `;
  const companyRows = await pool.query(companyQuery);

  // Fetch industries
  const industryQuery = `
    SELECT 
      industry_code as "code", 
      industry_name as "name", 
      sector_name as "sector",
      COUNT(*) as "count"
    FROM company_sectors
    WHERE industry_code IS NOT NULL AND industry_name IS NOT NULL
    GROUP BY industry_code, industry_name, sector_name
  `;
  const industryRows = await pool.query(industryQuery);

  // Map and sort companies
  const companies = companyRows.rows.map(r => ({
    kind: "Company",
    label: r.label,
    meta: `${r.code} • ${r.leaf || 'Unknown'}`,
    href: `/company/${r.code}`,
    code: r.code,
    mkt_cap: parseFloat(r.mkt_cap || 0)
  })).sort((a, b) => b.mkt_cap - a.mkt_cap).map((c, i) => ({
    kind: c.kind,
    label: c.label,
    meta: c.meta,
    href: c.href,
    code: c.code,
    rank: i
  }));

  // Map industries
  const industries = industryRows.rows.map(r => ({
    kind: "Industry",
    label: r.name,
    meta: `${r.sector} / ${r.name}`,
    href: `/market/${r.code}`,
    code: r.code,
    count: parseInt(r.count, 10),
    rank: -parseInt(r.count, 10)
  }));

  res.json([...companies, ...industries]);
}));

export default router;
