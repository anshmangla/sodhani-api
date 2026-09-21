import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pool } from '../db/pool';
import { lttb } from '../utils/lttb';
import {
  getCompanyConcern,
  isKnownConcern,
  concernRequiresVariant,
  Variant,
} from '../services/companySplitDataService';
import { impliedShares, impliedEps } from '../services/metricsDerive';

const router = Router();

const VALID_QUERY_REGEX = /^[A-Za-z0-9._\-&]{1,32}$/;

// Single source of truth for "what do we measure today's move against".
//
// Preferred: the official exchange previous close the scraper writes onto the
// current session's own rows (historical_prices.prev_close) - constant within a
// trading day, so MAX() just picks it while ignoring rows that predate the
// column. Falls back to the close of the most recent earlier trading day for
// instruments the live feeds don't cover that session: Yahoo-only instruments,
// and BSE-only scrips that finished flat (BSE's gainers/losers feed omits any
// stock with a 0% move, so those get no tick at all).
//
// Requires `hp_latest` (aggregated over the latest trading day, selecting
// MAX(prev_close) AS true_prev_close) and `hp_prev` to already be in scope.
const PREV_CLOSE_LATERAL = `
     LEFT JOIN LATERAL (
       SELECT COALESCE(hp_latest."true_prev_close", hp_prev."prev_close") AS prev_close
     ) pc ON true`;

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

const outputDir = process.env.STATIC_JSON_DIR || '/opt/sodhaniScrap/output';
const consolidatedDir = process.env.CONSOLIDATED_JSON_DIR || '/opt/sodhaniScrap/output_consolidated';

let cachedFileNames = new Set<string>();
let lastFileScanTime = 0;
const FILE_SCAN_TTL_MS = 60 * 1000;

async function getAvailableStockFiles(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedFileNames.size > 0 && now - lastFileScanTime < FILE_SCAN_TTL_MS) {
    return cachedFileNames;
  }
  const set = new Set<string>();
  for (const dir of [outputDir, consolidatedDir]) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          set.add(file.slice(0, -5).toLowerCase());
        }
      }
    } catch {
      // directory missing or unreadable
    }
  }
  cachedFileNames = set;
  lastFileScanTime = now;
  return set;
}

const hasJsonForStock = async (scripCd: string): Promise<boolean> => {
  if (!scripCd) return false;
  const lowerCd = String(scripCd).toLowerCase();
  const fileSet = await getAvailableStockFiles();
  if (fileSet.has(lowerCd)) return true;

  const stockResult = await pool.query(
    `SELECT "TckrSymb" FROM company_stock WHERE "FinInstrmId"::text = $1 LIMIT 1`,
    [scripCd]
  );

  if (stockResult.rows.length > 0 && stockResult.rows[0].TckrSymb) {
    const tickerLower = String(stockResult.rows[0].TckrSymb).toLowerCase();
    if (fileSet.has(tickerLower)) return true;
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

  // Fetch names from company_stock (match by either BSE code or NSE ticker)
  const result = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm" FROM company_stock WHERE "FinInstrmId"::text = ANY($1) OR "TckrSymb" = ANY($2)`,
    [recentTickers, recentTickers]
  );

  const nameMap = new Map();
  for (const row of result.rows) {
    nameMap.set(row.FinInstrmId.toString(), row.FinInstrmNm);
    if (row.TckrSymb) nameMap.set(row.TckrSymb, row.FinInstrmNm);
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

  // Fetch names from company_stock (match by either BSE code or NSE ticker)
  const result = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm" FROM company_stock WHERE "FinInstrmId"::text = ANY($1) OR "TckrSymb" = ANY($2)`,
    [recentTickers, recentTickers]
  );

  const nameMap = new Map();
  for (const row of result.rows) {
    nameMap.set(row.FinInstrmId.toString(), row.FinInstrmNm);
    if (row.TckrSymb) nameMap.set(row.TckrSymb, row.FinInstrmNm);
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
            pc."prev_close" AS "PrevClosePric",
            (hp_latest."true_close"::float - pc."prev_close"::float) AS "ChangeVal",
            CASE WHEN pc."prev_close"::float > 0
              THEN ((hp_latest."true_close"::float - pc."prev_close"::float) / pc."prev_close"::float) * 100
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
         SUM(volume) as true_volume,
         MAX(prev_close) as true_prev_close
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp.record_date) = (
           SELECT MAX(DATE(record_date))
           FROM historical_prices
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
     ) hp_latest ON true
     LEFT JOIN LATERAL (
       SELECT close_price as prev_close
       FROM historical_prices hp2
       WHERE hp2."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp2.record_date) < (
           SELECT MAX(DATE(record_date))
           FROM historical_prices
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
       ORDER BY
           DATE(hp2.record_date) DESC,
           CASE WHEN EXTRACT(HOUR FROM hp2.record_date) = 0 AND EXTRACT(MINUTE FROM hp2.record_date) = 0 THEN 1 ELSE 0 END DESC,
           hp2.record_date DESC
         LIMIT 1
     ) hp_prev ON true
     ${PREV_CLOSE_LATERAL}
     WHERE UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1
     LIMIT 1`,
    [symbol]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: `No quote found for symbol '${symbol}'` });
    return;
  }
  const quote = result.rows[0];

  // Enrich with latest Bhavcopy combined volume & delivery statistics
  try {
    const resolved = await resolveExchangeCodes(symbol);
    if (resolved && (resolved.bseCode || resolved.nseSymbol)) {
      const volRes = await pool.query(`
        SELECT 
          (COALESCE(b.volume, 0) + COALESCE(n.volume, 0)) AS combined_volume,
          CASE 
            WHEN b.delivery_qty IS NOT NULL OR n.delivery_qty IS NOT NULL 
            THEN (COALESCE(b.delivery_qty, 0) + COALESCE(n.delivery_qty, 0))
            ELSE NULL 
          END AS combined_delivery_qty,
          CASE 
            WHEN (COALESCE(b.volume, 0) + COALESCE(n.volume, 0)) > 0 AND (b.delivery_qty IS NOT NULL OR n.delivery_qty IS NOT NULL)
            THEN ROUND(((COALESCE(b.delivery_qty, 0) + COALESCE(n.delivery_qty, 0))::numeric / (COALESCE(b.volume, 0) + COALESCE(n.volume, 0))::numeric) * 100, 2)
            ELSE NULL 
          END AS combined_delivery_pct,
          b.volume as bse_volume,
          n.volume as nse_volume
        FROM (
          SELECT MAX(record_date) as latest_date
          FROM (
            SELECT MAX(record_date) as record_date FROM bse_volume_history WHERE scrip_cd = $1
            UNION ALL
            SELECT MAX(record_date) as record_date FROM nse_volume_history WHERE symbol = $2
          ) sub
        ) d
        LEFT JOIN bse_volume_history b ON b.scrip_cd = $1 AND b.record_date = d.latest_date
        LEFT JOIN nse_volume_history n ON n.symbol = $2 AND n.record_date = d.latest_date
        LIMIT 1
      `, [resolved.bseCode, resolved.nseSymbol]);

      if (volRes.rows.length > 0 && volRes.rows[0].combined_volume !== null) {
        const v = volRes.rows[0];
        quote.CombinedVolume = Number(v.combined_volume);
        quote.BseVolume = v.bse_volume !== null ? Number(v.bse_volume) : null;
        quote.NseVolume = v.nse_volume !== null ? Number(v.nse_volume) : null;
        quote.DeliveryQty = v.combined_delivery_qty !== null ? Number(v.combined_delivery_qty) : null;
        quote.DeliveryPct = v.combined_delivery_pct !== null ? Number(v.combined_delivery_pct) : null;
        quote.IsDualListed = resolved.isDualListed;
      }
    }
  } catch (e: any) {
    console.warn('Failed to attach volume metrics to quote:', e.message);
  }

  res.json(quote);
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
            pc."prev_close" AS "PrevClosePric",
            (hp_latest."true_close"::float - pc."prev_close"::float) AS "ChangeVal",
            CASE WHEN pc."prev_close"::float > 0
              THEN ((hp_latest."true_close"::float - pc."prev_close"::float) / pc."prev_close"::float) * 100
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
         SUM(volume) as true_volume,
         MAX(prev_close) as true_prev_close
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp.record_date) = (
           SELECT MAX(DATE(record_date))
           FROM historical_prices
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
     ) hp_latest ON true
     LEFT JOIN LATERAL (
       SELECT close_price as prev_close
       FROM historical_prices hp2
       WHERE hp2."FinInstrmId" = cs."FinInstrmId"
         AND DATE(hp2.record_date) < (
           SELECT MAX(DATE(record_date))
           FROM historical_prices
           WHERE "FinInstrmId" = cs."FinInstrmId"
         )
       ORDER BY
           DATE(hp2.record_date) DESC,
           CASE WHEN EXTRACT(HOUR FROM hp2.record_date) = 0 AND EXTRACT(MINUTE FROM hp2.record_date) = 0 THEN 1 ELSE 0 END DESC,
           hp2.record_date DESC
         LIMIT 1
     ) hp_prev ON true
     ${PREV_CLOSE_LATERAL}
     WHERE UPPER(cs."TckrSymb") = ANY($1) OR cs."FinInstrmId"::text = ANY($2)`,
    [upperCodes, codes]
  );

  res.json({ count: result.rows.length, quotes: result.rows });
}));

// GET /api/history/:symbol?range=1m&chartType=line
router.get('/history/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  if (!symbol || !VALID_QUERY_REGEX.test(symbol)) {
    res.status(400).json({ error: 'Invalid symbol parameter' });
    return;
  }
  
  const chartType = String(req.query.chartType || 'candlestick').toLowerCase();
  if (!['line', 'candlestick'].includes(chartType)) {
    res.status(400).json({ error: `Unsupported chartType '${chartType}'. Supported values: 'line', 'candlestick'.` });
    return;
  }
  let rawRange = String(req.query.range || req.query.query || '1m').toLowerCase();
  
  // Custom date ranges
  const startDate = req.query.start_date ? String(req.query.start_date).trim() : null;
  const endDate = req.query.end_date ? String(req.query.end_date).trim() : null;

  let timeFilter = '';
  let durationDays = 30; // default for 1m
  let range = rawRange;

  const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  if (startDate || endDate) {
    if (!startDate || !endDate || !ISO_DATE_REGEX.test(startDate) || !ISO_DATE_REGEX.test(endDate)) {
      res.status(400).json({ error: 'start_date and end_date must both be valid ISO dates (YYYY-MM-DD)' });
      return;
    }
    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    if (Number.isNaN(startTs) || Number.isNaN(endTs) || startTs > endTs) {
      res.status(400).json({ error: 'start_date must be less than or equal to end_date' });
      return;
    }
    range = 'custom';
    timeFilter = `AND hp."record_date" >= $3 AND hp."record_date" <= $4`;
    durationDays = (endTs - startTs) / (1000 * 3600 * 24);
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
      // Anchor on the most recent day that has more than one row — i.e. one
      // with real intraday ticks — rather than simply MAX(record_date).
      // Some symbols get a single EOD/mirror row written forward even on a
      // non-trading day (a daily bhavcopy job that doesn't check whether the
      // market actually traded); MAX(record_date) alone would pick that lone
      // placeholder row and shadow the real last session underneath it.
      // Falls back to the latest day with any data for thin/new listings
      // that only ever get one EOD row per day, so they still get their one
      // real point instead of 404ing.
      const anchorDay = `COALESCE(
        (SELECT DATE_TRUNC('day', record_date) FROM historical_prices
         WHERE "FinInstrmId" = cs."FinInstrmId"
           AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
         GROUP BY DATE_TRUNC('day', record_date)
         HAVING COUNT(*) > 1
         ORDER BY DATE_TRUNC('day', record_date) DESC LIMIT 1),
        (SELECT DATE_TRUNC('day', MAX(record_date)) FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId" AND EXTRACT(DOW FROM record_date) NOT IN (0, 6))
      )`;
      // >= / < (not a plain >): a symbol whose only row for its anchor day
      // lands exactly at midnight (EOD-only ingestion) is neither before nor
      // strictly after that same timestamp — it IS that timestamp — so a
      // strict `>` would exclude it entirely and 404 instead of returning
      // that day's data. The upper bound keeps a later, shadowed placeholder
      // day (see above) out of the result once the anchor is the real day.
      timeFilter = `AND hp."record_date" >= ${anchorDay} AND hp."record_date" < ${anchorDay} + INTERVAL '1 day' AND EXTRACT(DOW FROM hp."record_date") NOT IN (0, 6)`;
    } else if (range === '1w') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId" AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)) - INTERVAL '7 days' AND EXTRACT(DOW FROM hp."record_date") NOT IN (0, 6)`;
    } else if (range === '1m') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId" AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)) - INTERVAL '1 month' AND EXTRACT(DOW FROM hp."record_date") NOT IN (0, 6)`;
    } else if (range === '1y') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId" AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)) - INTERVAL '1 year' AND EXTRACT(DOW FROM hp."record_date") NOT IN (0, 6)`;
    } else if (range === '5y') {
      timeFilter = `AND hp."record_date" >= (SELECT MAX("record_date") FROM historical_prices WHERE "FinInstrmId" = cs."FinInstrmId" AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)) - INTERVAL '5 years' AND EXTRACT(DOW FROM hp."record_date") NOT IN (0, 6)`;
    } else if (range === 'max') {
      timeFilter = `AND EXTRACT(DOW FROM hp."record_date") NOT IN (0, 6)`;
    }
  }

  // M-01.3: clamp ceiling to 5,000 rows
  const limit = clampLimit(req.query.limit, 1000, 5000);
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
                hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits",
                hp."prev_close"
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
                  hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits",
                  hp."prev_close"
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

  // Percentage change across the returned window. history is ordered DESC by
  // date (newest first, oldest last), so the earliest bar sits at the end.
  //
  // 1D is the day-change and must use the same base as /api/quote: the official
  // exchange previous close. Measuring it against the earliest bar's open would
  // be wrong twice over - it silently drops the overnight gap, and for NSE rows
  // that "open" is just the 09:18 poll (the 09:15 open is never captured), so
  // the number wouldn't match the quote screen for the same stock.
  //
  // Longer ranges keep the window convention: change from where the window
  // opened to the latest close.
  const latestPrice = Number(history[0].close_price);
  let prevClose: number | null = null;

  if (range === '1d') {
    const fromRow = history[0].prev_close;
    if (fromRow != null) {
      prevClose = Number(fromRow);
    } else {
      // Rows written before prev_close existed, or an instrument the live feeds
      // didn't cover this session - fall back to the previous day's close.
      //
      // Every predicate here is a plain equality/range on ("FinInstrmId",
      // record_date) so the lookup rides historical_prices_idx and stops at the
      // first matching tuple. Wrapping record_date in DATE() instead makes the
      // index unusable and the query then exceeds statement_timeout on
      // instruments with a long history.
      const prevRes = await pool.query(
        `WITH target AS (
           SELECT cs."FinInstrmId" AS fid
           FROM company_stock cs
           WHERE UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1
           LIMIT 1
         ),
         prev_day AS (
           SELECT DATE_TRUNC('day', hp."record_date") AS d
           FROM historical_prices hp, target
           WHERE hp."FinInstrmId" = target.fid
             AND hp."record_date" < DATE_TRUNC('day', $2::timestamp)
           ORDER BY hp."record_date" DESC
           LIMIT 1
         )
         SELECT hp."close_price"
         FROM historical_prices hp, target, prev_day
         WHERE hp."FinInstrmId" = target.fid
           AND hp."record_date" >= prev_day.d
           AND hp."record_date" < prev_day.d + INTERVAL '1 day'
         ORDER BY
             -- Prefer that day's official EOD bar (midnight) over its last
             -- intraday tick, matching how /api/quote resolves a previous close.
             CASE WHEN hp."record_date" = prev_day.d THEN 1 ELSE 0 END DESC,
             hp."record_date" DESC
         LIMIT 1`,
        [symbol, history[0].record_date]
      );
      if (prevRes.rows.length > 0 && prevRes.rows[0].close_price != null) {
        prevClose = Number(prevRes.rows[0].close_price);
      }
    }
  }

  let changePercent: number;
  if (prevClose !== null && prevClose > 0) {
    changePercent = ((latestPrice - prevClose) / prevClose) * 100;
  } else {
    const earliestOpen = Number(history[history.length - 1].open_price);
    changePercent = earliestOpen ? ((latestPrice - earliestOpen) / earliestOpen) * 100 : 0;
  }

  // Fetch pre-computed price extremes for the company
  let extremesRow: any = null;
  try {
    const extremesRes = await pool.query(
      `SELECT cpe.*
       FROM company_price_extremes cpe
       JOIN company_stock cs ON cs."FinInstrmId" = cpe."FinInstrmId"
       WHERE (UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1)
       LIMIT 1`,
      [symbol]
    );
    if (extremesRes.rows.length > 0) {
      extremesRow = extremesRes.rows[0];
    }
  } catch (e: any) {
    console.warn('Failed to query company_price_extremes:', e.message);
  }

  let highPrice: number | null = null;
  let lowPrice: number | null = null;

  if (extremesRow) {
    switch (range) {
      case '1d':
        highPrice = extremesRow.high_1d !== null ? Number(extremesRow.high_1d) : null;
        lowPrice = extremesRow.low_1d !== null ? Number(extremesRow.low_1d) : null;
        break;
      case '1w':
        highPrice = extremesRow.high_1w !== null ? Number(extremesRow.high_1w) : null;
        lowPrice = extremesRow.low_1w !== null ? Number(extremesRow.low_1w) : null;
        break;
      case '1m':
        highPrice = extremesRow.high_1m !== null ? Number(extremesRow.high_1m) : null;
        lowPrice = extremesRow.low_1m !== null ? Number(extremesRow.low_1m) : null;
        break;
      case '1y':
        highPrice = extremesRow.high_1y !== null ? Number(extremesRow.high_1y) : null;
        lowPrice = extremesRow.low_1y !== null ? Number(extremesRow.low_1y) : null;
        break;
      case '5y':
        highPrice = extremesRow.high_5y !== null ? Number(extremesRow.high_5y) : null;
        lowPrice = extremesRow.low_5y !== null ? Number(extremesRow.low_5y) : null;
        break;
      case 'max':
        highPrice = extremesRow.high_all !== null ? Number(extremesRow.high_all) : null;
        lowPrice = extremesRow.low_all !== null ? Number(extremesRow.low_all) : null;
        break;
      default:
        break;
    }
  }

  // Fallback to returned history slice if pre-computed values are missing or for custom range
  if (highPrice === null && history.length > 0) {
    highPrice = Math.max(...history.map((p: any) => Number(p.high_price ?? p.close_price)));
  }
  if (lowPrice === null && history.length > 0) {
    lowPrice = Math.min(...history.map((p: any) => Number(p.low_price ?? p.close_price)));
  }

  res.json({
    symbol: symbol.toUpperCase(), 
    range,
    chartType,
    count: history.length, 
    high_price: highPrice,
    low_price: lowPrice,
    change_percent: changePercent,
    extremes: extremesRow ? {
      "1d": { high: extremesRow.high_1d !== null ? Number(extremesRow.high_1d) : null, low: extremesRow.low_1d !== null ? Number(extremesRow.low_1d) : null },
      "1w": { high: extremesRow.high_1w !== null ? Number(extremesRow.high_1w) : null, low: extremesRow.low_1w !== null ? Number(extremesRow.low_1w) : null },
      "1m": { high: extremesRow.high_1m !== null ? Number(extremesRow.high_1m) : null, low: extremesRow.low_1m !== null ? Number(extremesRow.low_1m) : null },
      "1y": { high: extremesRow.high_1y !== null ? Number(extremesRow.high_1y) : null, low: extremesRow.low_1y !== null ? Number(extremesRow.low_1y) : null },
      "5y": { high: extremesRow.high_5y !== null ? Number(extremesRow.high_5y) : null, low: extremesRow.low_5y !== null ? Number(extremesRow.low_5y) : null },
      "all": { high: extremesRow.high_all !== null ? Number(extremesRow.high_all) : null, low: extremesRow.low_all !== null ? Number(extremesRow.low_all) : null }
    } : null,
    history 
  });
}));

interface ExchangeResolved {
  bseCode: string | null;
  nseSymbol: string | null;
  name: string | null;
  isDualListed: boolean;
}

interface ExchangeMappings {
  bse_only?: string[];
  nse_only?: string[];
  bse_to_nse?: Record<string, string>;
  nse_to_bse?: Record<string, string>;
}

let cachedExchangeMappings: ExchangeMappings | null = null;

async function getExchangeMappings(): Promise<ExchangeMappings> {
  if (cachedExchangeMappings) return cachedExchangeMappings;
  try {
    const mappingsPath = path.resolve(__dirname, '../../exchange_code_mappings.json');
    const data = await fs.readFile(mappingsPath, 'utf8');
    cachedExchangeMappings = JSON.parse(data);
    return cachedExchangeMappings!;
  } catch {
    return {};
  }
}

async function resolveExchangeCodes(rawSymbol: string): Promise<ExchangeResolved | null> {
  const query = rawSymbol.trim().toUpperCase();
  if (!query || !VALID_QUERY_REGEX.test(query)) return null;

  const mappings = await getExchangeMappings();

  // 1. Direct query in company_stock
  const csRes = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm"
     FROM company_stock
     WHERE UPPER("TckrSymb") = $1 OR "FinInstrmId"::text = $1
     LIMIT 1`,
    [query]
  );

  let bseCode: string | null = null;
  let nseSymbol: string | null = null;
  let name: string | null = null;

  if (csRes.rows.length > 0) {
    const row = csRes.rows[0];
    name = row.FinInstrmNm || null;
    const isBseCode = /^\d{6}$/.test(row.FinInstrmId);

    if (isBseCode) {
      const code = String(row.FinInstrmId);
      bseCode = code;
      if (mappings.bse_only?.includes(code)) {
        nseSymbol = null;
      } else {
        nseSymbol = mappings.bse_to_nse?.[code] || null;
        if (!nseSymbol && row.TckrSymb) {
          const candidate = row.TckrSymb.replace(/\.(NS|BO)$/i, '').toUpperCase();
          const nseCheck = await pool.query(`SELECT 1 FROM nse_volume_history WHERE symbol = $1 LIMIT 1`, [candidate]);
          if (nseCheck.rows.length > 0) {
            nseSymbol = candidate;
          }
        }
      }
    } else {
      const sym = String(row.FinInstrmId);
      nseSymbol = sym;
      if (mappings.nse_only?.includes(sym)) {
        bseCode = null;
      } else {
        bseCode = mappings.nse_to_bse?.[sym] || null;
      }
    }
  } else {
    // 2. Fallback via mappings
    if (/^\d{6}$/.test(query)) {
      bseCode = query;
      nseSymbol = mappings.bse_only?.includes(query) ? null : (mappings.bse_to_nse?.[query] || null);
    } else {
      nseSymbol = query;
      bseCode = mappings.nse_only?.includes(query) ? null : (mappings.nse_to_bse?.[query] || null);
    }
  }

  // 3. Fallback check directly in volume history tables if not in company_stock
  if (!bseCode && !nseSymbol) {
    if (/^\d{6}$/.test(query)) {
      const bseCheck = await pool.query(`SELECT 1 FROM bse_volume_history WHERE scrip_cd = $1 LIMIT 1`, [query]);
      if (bseCheck.rows.length > 0) {
        bseCode = query;
        nseSymbol = mappings.bse_only?.includes(query) ? null : (mappings.bse_to_nse?.[query] || null);
      }
    } else {
      const nseCheck = await pool.query(`SELECT 1 FROM nse_volume_history WHERE symbol = $1 LIMIT 1`, [query]);
      if (nseCheck.rows.length > 0) {
        nseSymbol = query;
        bseCode = mappings.nse_only?.includes(query) ? null : (mappings.nse_to_bse?.[query] || null);
      }
    }
  }

  // 4. Resolve name if missing
  if (!name && (bseCode || nseSymbol)) {
    const nameRes = await pool.query(
      `SELECT "FinInstrmNm" FROM company_stock 
       WHERE "FinInstrmId" = $1 OR "FinInstrmId" = $2 OR UPPER("TckrSymb") = $2
       LIMIT 1`,
      [bseCode, nseSymbol]
    );
    if (nameRes.rows.length > 0) {
      name = nameRes.rows[0].FinInstrmNm;
    }
  }

  if (!bseCode && !nseSymbol) {
    return null;
  }

  return {
    bseCode,
    nseSymbol,
    name: name || query,
    isDualListed: Boolean(bseCode && nseSymbol)
  };
}

// GET /api/volume/:symbol?range=1m&chartType=bar
// Fetches daily, weekly, or monthly aggregated volume and delivery history for a company.
// For companies common in both BSE and NSE (dual-listed), returns combined volume and delivery metrics,
// alongside individual exchange breakdowns.
router.get('/volume/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  if (!symbol || !VALID_QUERY_REGEX.test(symbol)) {
    res.status(400).json({ error: 'Invalid symbol parameter' });
    return;
  }

  const resolved = await resolveExchangeCodes(symbol);
  if (!resolved) {
    res.status(404).json({ error: `No company found matching symbol '${symbol}'` });
    return;
  }

  const { bseCode, nseSymbol, name, isDualListed } = resolved;
  const chartType = String(req.query.chartType || 'bar').toLowerCase();
  let rawRange = String(req.query.range || req.query.query || '1m').toLowerCase();

  const startDate = req.query.start_date ? String(req.query.start_date).trim() : null;
  const endDate = req.query.end_date ? String(req.query.end_date).trim() : null;

  let timeFilter = '';
  let durationDays = 30; // default for 1m
  let range = rawRange;

  const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  if (startDate || endDate) {
    if (!startDate || !endDate || !ISO_DATE_REGEX.test(startDate) || !ISO_DATE_REGEX.test(endDate)) {
      res.status(400).json({ error: 'start_date and end_date must both be valid ISO dates (YYYY-MM-DD)' });
      return;
    }
    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    if (Number.isNaN(startTs) || Number.isNaN(endTs) || startTs > endTs) {
      res.status(400).json({ error: 'start_date must be less than or equal to end_date' });
      return;
    }
    range = 'custom';
    durationDays = (endTs - startTs) / (1000 * 3600 * 24);
    timeFilter = `AND record_date >= $3 AND record_date <= $4`;
  } else {
    if (['d', '1d'].includes(rawRange)) { range = '1d'; durationDays = 1; }
    else if (['w', '1w'].includes(rawRange)) { range = '1w'; durationDays = 7; }
    else if (['m', '1m'].includes(rawRange)) { range = '1m'; durationDays = 30; }
    else if (['y', '1y'].includes(rawRange)) { range = '1y'; durationDays = 365; }
    else if (['5y'].includes(rawRange)) { range = '5y'; durationDays = 365 * 5; }
    else if (['max', 'all'].includes(rawRange)) { range = 'max'; durationDays = 99999; }
    else { range = '1m'; durationDays = 30; }

    if (range === '1d') {
      timeFilter = `AND record_date >= (SELECT max_date FROM max_date_cte) AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)`;
    } else if (range === '1w') {
      timeFilter = `AND record_date >= (SELECT max_date FROM max_date_cte) - INTERVAL '7 days' AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)`;
    } else if (range === '1m') {
      timeFilter = `AND record_date >= (SELECT max_date FROM max_date_cte) - INTERVAL '1 month' AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)`;
    } else if (range === '1y') {
      timeFilter = `AND record_date >= (SELECT max_date FROM max_date_cte) - INTERVAL '1 year' AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)`;
    } else if (range === '5y') {
      timeFilter = `AND record_date >= (SELECT max_date FROM max_date_cte) - INTERVAL '5 years' AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)`;
    } else if (['max', 'all'].includes(range)) {
      timeFilter = `AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)`;
    }
  }

  const limit = ['max', '5y'].includes(range)
    ? clampLimit(req.query.limit, 5000, 10000)
    : clampLimit(req.query.limit, 1000, 5000);
  const downsample = req.query.downsample
    ? clampLimit(req.query.downsample, 20, 500)
    : 100;

  const queryParams: any[] = [bseCode, nseSymbol];
  if (range === 'custom') {
    queryParams.push(startDate, endDate);
  }
  queryParams.push(limit);
  const limitPlaceholder = `$${queryParams.length}`;

  let sql = '';

  if (['max', '5y'].includes(range) || durationDays < 365) {
    // 1. Raw Daily Data (for 1d, 1w, 1m, custom < 1 year, 5y, or max downsampled algorithmically)
    sql = `
      WITH max_date_cte AS (
        SELECT MAX(m) as max_date
        FROM (
          SELECT MAX(record_date) as m FROM bse_volume_history WHERE scrip_cd = $1 AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
          UNION ALL
          SELECT MAX(record_date) as m FROM nse_volume_history WHERE symbol = $2 AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
        ) sub
      ),
      dates AS (
        SELECT DISTINCT record_date
        FROM (
          SELECT record_date FROM bse_volume_history WHERE scrip_cd = $1
          UNION
          SELECT record_date FROM nse_volume_history WHERE symbol = $2
        ) d
        WHERE 1=1 ${timeFilter}
        ORDER BY record_date DESC
        LIMIT ${limitPlaceholder}
      )
      SELECT 
        to_char(d.record_date, 'YYYY-MM-DD') as record_date,
        (COALESCE(b.volume, 0) + COALESCE(n.volume, 0)) AS combined_volume,
        CASE 
          WHEN b.delivery_qty IS NOT NULL OR n.delivery_qty IS NOT NULL 
          THEN (COALESCE(b.delivery_qty, 0) + COALESCE(n.delivery_qty, 0))
          ELSE NULL 
        END AS combined_delivery_qty,
        CASE 
          WHEN (COALESCE(b.volume, 0) + COALESCE(n.volume, 0)) > 0 AND (b.delivery_qty IS NOT NULL OR n.delivery_qty IS NOT NULL)
          THEN ROUND(((COALESCE(b.delivery_qty, 0) + COALESCE(n.delivery_qty, 0))::numeric / (COALESCE(b.volume, 0) + COALESCE(n.volume, 0))::numeric) * 100, 2)
          ELSE NULL 
        END AS combined_delivery_pct,
        CASE 
          WHEN b.turnover IS NOT NULL OR n.turnover IS NOT NULL 
          THEN (COALESCE(b.turnover, 0) + COALESCE(n.turnover, 0))
          ELSE NULL 
        END AS combined_turnover,
        b.volume as bse_volume,
        b.delivery_qty as bse_delivery_qty,
        b.delivery_val as bse_delivery_val,
        b.turnover as bse_turnover,
        b.delivery_pct as bse_delivery_pct,
        n.series as nse_series,
        n.volume as nse_volume,
        n.delivery_qty as nse_delivery_qty,
        n.turnover as nse_turnover,
        n.delivery_pct as nse_delivery_pct,
        n.no_of_trades as nse_trades
      FROM dates d
      LEFT JOIN bse_volume_history b ON b.scrip_cd = $1 AND b.record_date = d.record_date
      LEFT JOIN nse_volume_history n ON n.symbol = $2 AND n.record_date = d.record_date
      ORDER BY d.record_date DESC
    `;
  } else if (durationDays <= 365 * 5) {
    // 2. Weekly Buckets (1y to 5y)
    sql = `
      WITH max_date_cte AS (
        SELECT MAX(m) as max_date
        FROM (
          SELECT MAX(record_date) as m FROM bse_volume_history WHERE scrip_cd = $1 AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
          UNION ALL
          SELECT MAX(record_date) as m FROM nse_volume_history WHERE symbol = $2 AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
        ) sub
      ),
      combined_daily AS (
        SELECT 
          d.record_date,
          (COALESCE(b.volume, 0) + COALESCE(n.volume, 0)) AS combined_volume,
          CASE 
            WHEN b.delivery_qty IS NOT NULL OR n.delivery_qty IS NOT NULL 
            THEN (COALESCE(b.delivery_qty, 0) + COALESCE(n.delivery_qty, 0))
            ELSE NULL 
          END AS combined_delivery_qty,
          CASE 
            WHEN b.turnover IS NOT NULL OR n.turnover IS NOT NULL 
            THEN (COALESCE(b.turnover, 0) + COALESCE(n.turnover, 0))
            ELSE NULL 
          END AS combined_turnover,
          b.volume as bse_volume,
          b.delivery_qty as bse_delivery_qty,
          b.delivery_val as bse_delivery_val,
          b.turnover as bse_turnover,
          n.series as nse_series,
          n.volume as nse_volume,
          n.delivery_qty as nse_delivery_qty,
          n.turnover as nse_turnover,
          n.no_of_trades as nse_trades
        FROM (
          SELECT DISTINCT record_date
          FROM (
            SELECT record_date FROM bse_volume_history WHERE scrip_cd = $1
            UNION
            SELECT record_date FROM nse_volume_history WHERE symbol = $2
          ) sub
          WHERE 1=1 ${timeFilter}
        ) d
        LEFT JOIN bse_volume_history b ON b.scrip_cd = $1 AND b.record_date = d.record_date
        LEFT JOIN nse_volume_history n ON n.symbol = $2 AND n.record_date = d.record_date
      )
      SELECT 
        to_char(date_trunc('week', record_date), 'YYYY-MM-DD') as record_date,
        SUM(combined_volume) as combined_volume,
        CASE WHEN COUNT(combined_delivery_qty) > 0 THEN SUM(combined_delivery_qty) ELSE NULL END as combined_delivery_qty,
        CASE 
          WHEN SUM(combined_volume) > 0 AND COUNT(combined_delivery_qty) > 0
          THEN ROUND((SUM(combined_delivery_qty)::numeric / SUM(combined_volume)::numeric) * 100, 2)
          ELSE NULL 
        END as combined_delivery_pct,
        CASE WHEN COUNT(combined_turnover) > 0 THEN SUM(combined_turnover) ELSE NULL END as combined_turnover,
        SUM(bse_volume) as bse_volume,
        CASE WHEN COUNT(bse_delivery_qty) > 0 THEN SUM(bse_delivery_qty) ELSE NULL END as bse_delivery_qty,
        CASE WHEN COUNT(bse_delivery_val) > 0 THEN SUM(bse_delivery_val) ELSE NULL END as bse_delivery_val,
        CASE WHEN COUNT(bse_turnover) > 0 THEN SUM(bse_turnover) ELSE NULL END as bse_turnover,
        CASE 
          WHEN SUM(bse_volume) > 0 AND COUNT(bse_delivery_qty) > 0
          THEN ROUND((SUM(bse_delivery_qty)::numeric / SUM(bse_volume)::numeric) * 100, 2)
          ELSE NULL 
        END as bse_delivery_pct,
        SUM(nse_volume) as nse_volume,
        CASE WHEN COUNT(nse_delivery_qty) > 0 THEN SUM(nse_delivery_qty) ELSE NULL END as nse_delivery_qty,
        CASE WHEN COUNT(nse_turnover) > 0 THEN SUM(nse_turnover) ELSE NULL END as nse_turnover,
        CASE 
          WHEN SUM(nse_volume) > 0 AND COUNT(nse_delivery_qty) > 0
          THEN ROUND((SUM(nse_delivery_qty)::numeric / SUM(nse_volume)::numeric) * 100, 2)
          ELSE NULL 
        END as nse_delivery_pct,
        CASE WHEN COUNT(nse_trades) > 0 THEN SUM(nse_trades) ELSE NULL END as nse_trades
      FROM combined_daily
      GROUP BY date_trunc('week', record_date)
      ORDER BY record_date DESC
      LIMIT ${limitPlaceholder}
    `;
  } else {
    // 3. Monthly Buckets (> 5y / max)
    sql = `
      WITH max_date_cte AS (
        SELECT MAX(m) as max_date
        FROM (
          SELECT MAX(record_date) as m FROM bse_volume_history WHERE scrip_cd = $1 AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
          UNION ALL
          SELECT MAX(record_date) as m FROM nse_volume_history WHERE symbol = $2 AND EXTRACT(DOW FROM record_date) NOT IN (0, 6)
        ) sub
      ),
      combined_daily AS (
        SELECT 
          d.record_date,
          (COALESCE(b.volume, 0) + COALESCE(n.volume, 0)) AS combined_volume,
          CASE 
            WHEN b.delivery_qty IS NOT NULL OR n.delivery_qty IS NOT NULL 
            THEN (COALESCE(b.delivery_qty, 0) + COALESCE(n.delivery_qty, 0))
            ELSE NULL 
          END AS combined_delivery_qty,
          CASE 
            WHEN b.turnover IS NOT NULL OR n.turnover IS NOT NULL 
            THEN (COALESCE(b.turnover, 0) + COALESCE(n.turnover, 0))
            ELSE NULL 
          END AS combined_turnover,
          b.volume as bse_volume,
          b.delivery_qty as bse_delivery_qty,
          b.delivery_val as bse_delivery_val,
          b.turnover as bse_turnover,
          n.series as nse_series,
          n.volume as nse_volume,
          n.delivery_qty as nse_delivery_qty,
          n.turnover as nse_turnover,
          n.no_of_trades as nse_trades
        FROM (
          SELECT DISTINCT record_date
          FROM (
            SELECT record_date FROM bse_volume_history WHERE scrip_cd = $1
            UNION
            SELECT record_date FROM nse_volume_history WHERE symbol = $2
          ) sub
          WHERE 1=1 ${timeFilter}
        ) d
        LEFT JOIN bse_volume_history b ON b.scrip_cd = $1 AND b.record_date = d.record_date
        LEFT JOIN nse_volume_history n ON n.symbol = $2 AND n.record_date = d.record_date
      )
      SELECT 
        date_trunc('month', record_date) as record_date,
        SUM(combined_volume) as combined_volume,
        CASE WHEN COUNT(combined_delivery_qty) > 0 THEN SUM(combined_delivery_qty) ELSE NULL END as combined_delivery_qty,
        CASE 
          WHEN SUM(combined_volume) > 0 AND COUNT(combined_delivery_qty) > 0
          THEN ROUND((SUM(combined_delivery_qty)::numeric / SUM(combined_volume)::numeric) * 100, 2)
          ELSE NULL 
        END as combined_delivery_pct,
        CASE WHEN COUNT(combined_turnover) > 0 THEN SUM(combined_turnover) ELSE NULL END as combined_turnover,
        SUM(bse_volume) as bse_volume,
        CASE WHEN COUNT(bse_delivery_qty) > 0 THEN SUM(bse_delivery_qty) ELSE NULL END as bse_delivery_qty,
        CASE WHEN COUNT(bse_delivery_val) > 0 THEN SUM(bse_delivery_val) ELSE NULL END as bse_delivery_val,
        CASE WHEN COUNT(bse_turnover) > 0 THEN SUM(bse_turnover) ELSE NULL END as bse_turnover,
        CASE 
          WHEN SUM(bse_volume) > 0 AND COUNT(bse_delivery_qty) > 0
          THEN ROUND((SUM(bse_delivery_qty)::numeric / SUM(bse_volume)::numeric) * 100, 2)
          ELSE NULL 
        END as bse_delivery_pct,
        SUM(nse_volume) as nse_volume,
        CASE WHEN COUNT(nse_delivery_qty) > 0 THEN SUM(nse_delivery_qty) ELSE NULL END as nse_delivery_qty,
        CASE WHEN COUNT(nse_turnover) > 0 THEN SUM(nse_turnover) ELSE NULL END as nse_turnover,
        CASE 
          WHEN SUM(nse_volume) > 0 AND COUNT(nse_delivery_qty) > 0
          THEN ROUND((SUM(nse_delivery_qty)::numeric / SUM(nse_volume)::numeric) * 100, 2)
          ELSE NULL 
        END as nse_delivery_pct,
        CASE WHEN COUNT(nse_trades) > 0 THEN SUM(nse_trades) ELSE NULL END as nse_trades
      FROM combined_daily
      GROUP BY date_trunc('month', record_date)
      ORDER BY record_date DESC
      LIMIT ${limitPlaceholder}
    `;
  }

  const result = await pool.query(sql, queryParams);
  if (result.rows.length === 0) {
    res.status(404).json({ error: `No volume history found for symbol '${symbol}'` });
    return;
  }

  let rawHistory = result.rows;

  const shouldDownsample = (chartType === 'line' || ['max', '5y'].includes(range)) && rawHistory.length > downsample;
  if (shouldDownsample) {
    rawHistory.reverse();
    rawHistory = lttb(
      rawHistory,
      downsample,
      (d) => new Date(d.record_date).getTime(),
      (d) => Number(d.combined_volume || 0)
    );
    rawHistory.reverse();
  }

  const volumes = rawHistory.map((r: any) => Number(r.combined_volume || 0));
  const highVolume = volumes.length > 0 ? Math.max(...volumes) : 0;
  const lowVolume = volumes.length > 0 ? Math.min(...volumes) : 0;
  const totalVolume = volumes.reduce((acc: number, v: number) => acc + v, 0);
  const avgVolume = volumes.length > 0 ? Math.round(totalVolume / volumes.length) : 0;

  const latestVol = Number(rawHistory[0]?.combined_volume || 0);
  const earliestVol = Number(rawHistory[rawHistory.length - 1]?.combined_volume || 0);
  const changePercent = earliestVol > 0 ? Number((((latestVol - earliestVol) / earliestVol) * 100).toFixed(2)) : 0;

  const formattedHistory = rawHistory.map((row: any) => {
    const dStr = new Date(row.record_date).toISOString().split('T')[0];
    if (chartType === 'line') {
      return {
        time: dStr,
        record_date: dStr,
        combined_volume: Number(row.combined_volume || 0),
      };
    }
    return {
      time: dStr,
      record_date: dStr,
      combined_volume: Number(row.combined_volume || 0),
      combined_delivery_qty: row.combined_delivery_qty !== null ? Number(row.combined_delivery_qty) : null,
      combined_delivery_pct: row.combined_delivery_pct !== null ? Number(row.combined_delivery_pct) : null,
      combined_turnover: row.combined_turnover !== null ? Number(row.combined_turnover) : null,
      bse: bseCode && row.bse_volume !== null ? {
        scrip_cd: bseCode,
        volume: Number(row.bse_volume),
        delivery_qty: row.bse_delivery_qty !== null ? Number(row.bse_delivery_qty) : null,
        delivery_val: row.bse_delivery_val !== null ? Number(row.bse_delivery_val) : null,
        turnover: row.bse_turnover !== null ? Number(row.bse_turnover) : null,
        delivery_pct: row.bse_delivery_pct !== null ? Number(row.bse_delivery_pct) : null,
      } : null,
      nse: nseSymbol && row.nse_volume !== null ? {
        symbol: nseSymbol,
        series: row.nse_series || 'EQ',
        volume: Number(row.nse_volume),
        delivery_qty: row.nse_delivery_qty !== null ? Number(row.nse_delivery_qty) : null,
        turnover: row.nse_turnover !== null ? Number(row.nse_turnover) : null,
        delivery_pct: row.nse_delivery_pct !== null ? Number(row.nse_delivery_pct) : null,
        no_of_trades: row.nse_trades !== null ? Number(row.nse_trades) : null,
      } : null,
    };
  });

  const latestSnapshot = formattedHistory[0] ? { ...formattedHistory[0] } : null;

  res.json({
    symbol: symbol.toUpperCase(),
    name,
    bse_code: bseCode,
    nse_symbol: nseSymbol,
    exchange_codes: {
      bse: bseCode,
      nse: nseSymbol
    },
    is_dual_listed: isDualListed,
    range,
    chartType,
    count: formattedHistory.length,
    high_volume: highVolume,
    low_volume: lowVolume,
    avg_volume: avgVolume,
    total_volume: totalVolume,
    change_percent: changePercent,
    latest: latestSnapshot,
    history: formattedHistory
  });
}));

// GET /api/stocks?search=reliance&limit=20 - search/list instruments
router.get('/stocks', asyncHandler(async (req, res) => {
  const search = String(req.query.search ?? '').trim();
  const limit = clampLimit(req.query.limit, 20, 100);

  if (!search) {
    const result = await pool.query(
      `SELECT "FinInstrmId", "TckrSymb", COALESCE("FinInstrmNm", "TckrSymb") AS "FinInstrmNm", "ISIN", "SctySrs", "LastPric", "TradDt"
       FROM company_stock
       ORDER BY "TckrSymb" ASC
       LIMIT $1`,
      [limit]
    );
    res.json({ count: result.rows.length, stocks: result.rows });
    return;
  }

  const result = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", COALESCE("FinInstrmNm", "TckrSymb") AS "FinInstrmNm", "ISIN", "SctySrs", "LastPric", "TradDt"
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
  const page = Math.min(Math.max(1, parseInt(req.query.page as string) || 1), 1000);
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
        cs."FinInstrmId", cs."TckrSymb", COALESCE(NULLIF(cs."FinInstrmNm", ''), NULLIF(ci.company_name, '')) AS "FinInstrmNm",
        ci.sector_name, ci.industry_name, ci.leaf_name, ci.leaf_code,
        sm.cmp, sm.pe, sm.mkt_cap, sm.div_yld, sm.np_qtr, sm.profit_var, sm.sales_qtr, sm.sales_var, sm.roce
      FROM company_stock cs
      JOIN stock_metrics sm ON sm.symbol = cs."FinInstrmId"::text OR sm.symbol = cs."TckrSymb"
      LEFT JOIN company_sectors ci ON ci.fin_instrm_id = cs."FinInstrmId"::text OR ci.fin_instrm_id = cs."TckrSymb"
      ${whereClause}
      ORDER BY cs."FinInstrmId", sm.updated_at DESC NULLS LAST
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
  if (!query || !VALID_QUERY_REGEX.test(query)) return null;

  const baseDir = path.resolve(dir);

  const tryReadFile = async (directory: string, filename: string) => {
    try {
      const base = path.resolve(directory);
      const filePath = path.resolve(base, filename);
      if (filePath !== base && !filePath.startsWith(base + path.sep)) {
        return null;
      }
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  };

  const findFileCaseInsensitive = async (directory: string, targetBase: string) => {
    if (!targetBase || !VALID_QUERY_REGEX.test(targetBase)) return null;
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
      if (bseCode && VALID_QUERY_REGEX.test(bseCode)) {
        const bseCandidates = [bseCode, `${bseCode}.json`];
        for (const filename of bseCandidates) {
          if (data) break;
          data = await tryReadFile(dir, filename);
        }
        if (!data) data = await findFileCaseInsensitive(dir, bseCode);
      }

      // Try NSE ticker if it was a BSE code
      if (!data && nseSymbol && VALID_QUERY_REGEX.test(nseSymbol)) {
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
  if (!query || !VALID_QUERY_REGEX.test(query)) {
    res.status(400).json({ error: 'Query parameter "query" must be a valid stock symbol or code' });
    return;
  }

  const outputDir = process.env.STATIC_JSON_DIR || '/opt/sodhaniScrap/output';
  let data = await searchStaticStock(outputDir, query);
  
  if (!data) {
    try {
      const dbRes = await pool.query(
        `SELECT "FinInstrmId", "TckrSymb" FROM company_stock WHERE TRIM(UPPER("TckrSymb")) = TRIM(UPPER($1)) OR TRIM("FinInstrmId"::text) = TRIM($1) LIMIT 1`,
        [query]
      );
      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const rawId = row.FinInstrmId ?? row.fininstrmid ?? Object.values(row)[0];
        if (rawId) {
          const finId = rawId.toString();
          if (VALID_QUERY_REGEX.test(finId)) {
            data = await searchStaticStock(outputDir, finId);
          }
          if (!data && row.TckrSymb && VALID_QUERY_REGEX.test(row.TckrSymb)) {
            data = await searchStaticStock(outputDir, row.TckrSymb);
          }
        }
      }
    } catch (e) {
      console.error("Database fallback failed:", e);
    }
  }

  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `Static JSON not found for '${query}'` });
  }
}));

// GET /api/static-stock-consolidated?query=500325
router.get('/static-stock-consolidated', asyncHandler(async (req, res) => {
  const query = req.query.query ? String(req.query.query).trim() : '';
  if (!query || !VALID_QUERY_REGEX.test(query)) {
    res.status(400).json({ error: 'Query parameter "query" must be a valid stock symbol or code' });
    return;
  }

  const consolidatedDir = process.env.CONSOLIDATED_JSON_DIR || '/opt/sodhaniScrap/output_consolidated';
  let data = await searchStaticStock(consolidatedDir, query);

  // Ultimate fallback: if not found by name or static mapping, check the live database
  // to map an incoming TckrSymb (like INTLCOMBQ) back to its FinInstrmId (like 505737)
  if (!data) {
    try {
      const dbRes = await pool.query(
        `SELECT "FinInstrmId", "TckrSymb" FROM company_stock WHERE TRIM(UPPER("TckrSymb")) = TRIM(UPPER($1)) OR TRIM("FinInstrmId"::text) = TRIM($1) LIMIT 1`,
        [query]
      );
      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const rawId = row.FinInstrmId ?? row.fininstrmid ?? Object.values(row)[0];
        if (rawId) {
          const finId = rawId.toString();
          if (VALID_QUERY_REGEX.test(finId)) {
            data = await searchStaticStock(consolidatedDir, finId);
          }
          if (!data && row.TckrSymb && VALID_QUERY_REGEX.test(row.TckrSymb)) {
            data = await searchStaticStock(consolidatedDir, row.TckrSymb);
          }
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

// GET /api/company/:symbol/:concern?variant=standalone|consolidated
//
// Serves a single concern file out of output_split/ (OUTPUT_SPLIT_DIR, defaults
// to /opt/sodhaniScrap/output_split - see scripts/split_company_data.ts, which
// generates that directory from output/ and output_consolidated/) instead of
// the full static-stock(-consolidated) payload. `variant` selects standalone
// vs consolidated financials for concerns that differ between the two
// screener.in pages; it's required-with-a-default (defaults to 'consolidated')
// and ignored for concerns that don't vary by source (shareholding, industry).
router.get('/company/:symbol/:concern', asyncHandler(async (req, res) => {
  const { symbol, concern } = req.params;

  if (!isKnownConcern(concern)) {
    res.status(400).json({ error: `Unknown concern '${concern}'.` });
    return;
  }

  const rawVariant = req.query.variant;
  let variant: Variant = 'consolidated';
  if (concernRequiresVariant(concern) && rawVariant !== undefined) {
    if (rawVariant !== 'standalone' && rawVariant !== 'consolidated') {
      res.status(400).json({ error: `Invalid variant '${rawVariant}'. Expected 'standalone' or 'consolidated'.` });
      return;
    }
    variant = rawVariant;
  }

  const splitDir = process.env.OUTPUT_SPLIT_DIR || '/opt/sodhaniScrap/output_split';
  const mappingsPath = path.resolve(__dirname, '../../exchange_code_mappings.json');

  let result = getCompanyConcern({ splitDir, mappingsPath, symbolQuery: symbol, concern, variant });

  // Ultimate fallback, same as /api/static-stock-consolidated: map an incoming
  // symbol to its FinInstrmId or TckrSymb via the live database and retry.
  // output_split/ directories are keyed inconsistently - some by numeric BSE
  // code, some by ticker (e.g. IPOs, whose FinInstrmId/TckrSymb start out
  // equal to the ticker before a later BSE sync re-keys FinInstrmId to the
  // numeric code) - so both candidates must be tried, not just FinInstrmId.
  if (result.status === 'company_not_found') {
    try {
      const dbRes = await pool.query(
        `SELECT "FinInstrmId", "TckrSymb" FROM company_stock WHERE TRIM(UPPER("TckrSymb")) = TRIM(UPPER($1)) OR TRIM("FinInstrmId"::text) = TRIM($1) LIMIT 1`,
        [symbol]
      );
      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const rawId = row.FinInstrmId ?? row.fininstrmid;
        const tckrSymb = row.TckrSymb ?? row.tckrsymb;
        if (rawId) {
          result = getCompanyConcern({ splitDir, mappingsPath, symbolQuery: rawId.toString(), concern, variant });
        }
        if (result.status === 'company_not_found' && tckrSymb) {
          result = getCompanyConcern({ splitDir, mappingsPath, symbolQuery: tckrSymb, concern, variant });
        }
      }
    } catch (e) {
      console.error('Database fallback failed:', e);
    }
  }

  if (result.status === 'company_not_found') {
    res.status(404).json({ error: `Company '${symbol}' not found in split output.` });
    return;
  }
  if (result.status === 'concern_not_found') {
    const variantSuffix = concernRequiresVariant(concern) ? ` (${variant})` : '';
    res.status(404).json({ error: `${concern}${variantSuffix} not available for '${symbol}'.` });
    return;
  }

  // For key_metrics, replace screener.in's static "High / Low" (52-week,
  // frozen at last scrape time) with live 52-week and all-time high/low
  // from company_price_extremes, kept current by sodhaniScrap's live sync.
  // Field names match what KeyMetricsGrid.tsx already expects: "High / Low"
  // (parsed via splitHighLow into 52w high/low) plus separate "All-time High"
  // / "All-time Low" strings. Falls back to leaving "High / Low" as scraped
  // and omitting the all-time fields if there's no matching
  // company_price_extremes row (e.g. not backfilled yet).
  if (concern === 'key_metrics') {
    try {
      const csRes = await pool.query(
        `SELECT "FinInstrmId" FROM company_stock WHERE TRIM(UPPER("TckrSymb")) = TRIM(UPPER($1)) OR TRIM("FinInstrmId"::text) = TRIM($1) LIMIT 1`,
        [symbol]
      );
      const finId = csRes.rows[0]?.FinInstrmId?.toString();
      if (finId) {
        const extremesRes = await pool.query(
          `SELECT high_1y, low_1y, high_all, low_all FROM company_price_extremes WHERE "FinInstrmId" = $1`,
          [finId]
        );
        const extremes = extremesRes.rows[0];
        if (extremes && extremes.high_1y != null && extremes.low_1y != null && extremes.high_all != null && extremes.low_all != null) {
          const fmtPrice = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(2));
          const data = result.data as Record<string, unknown>;
          data['High / Low'] = `₹ ${fmtPrice(Number(extremes.high_1y))} / ${fmtPrice(Number(extremes.low_1y))}`;
          data['All-time High'] = `₹${fmtPrice(Number(extremes.high_all))}`;
          data['All-time Low'] = `₹${fmtPrice(Number(extremes.low_all))}`;
        }
      }
    } catch (e) {
      console.error('Failed to enrich key_metrics with price extremes:', e);
    }
  }

  res.json(result.data);
}));

// GET /api/metrics/:symbol
router.get('/metrics/:symbol', asyncHandler(async (req, res) => {
  const symbol = req.params.symbol;
  
  const csResult = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb" FROM company_stock 
     WHERE UPPER("TckrSymb") = UPPER($1 || '.BO') 
        OR UPPER("TckrSymb") = UPPER($1 || '.NS') 
        OR UPPER("TckrSymb") = UPPER($1) 
        OR "FinInstrmId"::text = $1 
     LIMIT 1`, [symbol]
  );
  
  let finId = '';
  let tckrSymb = symbol;
  if (csResult.rows.length > 0) {
     finId = csResult.rows[0].FinInstrmId ? csResult.rows[0].FinInstrmId.toString() : '';
     tckrSymb = csResult.rows[0].TckrSymb ? csResult.rows[0].TckrSymb.replace(/\.(NS|BO)$/i, '') : symbol;
  }

  // stock_metrics can carry two rows for the same company - one keyed by
  // ticker, one by numeric BSE code, written by different metricsSync runs and
  // independently stale - so this WHERE can match both. A bare LIMIT 1 picked
  // whichever Postgres happened to return first, which is how the same stock
  // came to show one P/E here and a different one on the screener list
  // (RELIANCE: 42.91 vs 21.99 at the same moment). ORDER BY updated_at makes the
  // choice deterministic and ensures the freshest row is picked.
  const result = await pool.query(
    `SELECT sm.* 
     FROM stock_metrics sm
     WHERE UPPER(sm.symbol) = UPPER($1) 
        OR sm.symbol = $2
        OR UPPER(sm.symbol) = UPPER($3)
     ORDER BY sm.updated_at DESC NULLS LAST
     LIMIT 1`,
    [symbol, finId, tckrSymb]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: `Metrics not found for symbol '${symbol}'. They may not have been calculated yet.` });
    return;
  }

  const row = result.rows[0];
  const cmp = parseFloat(row.cmp);
  const pe = parseFloat(row.pe);
  const mktCap = parseFloat(row.mkt_cap);
  const metrics = {
    "CMP": cmp,
    "P/E": pe,
    "Mkt Cap": mktCap,
    "Div Yld": parseFloat(row.div_yld),
    "NP Qtr": parseFloat(row.np_qtr),
    "Profit Var": parseFloat(row.profit_var),
    "Sales Qtr": parseFloat(row.sales_qtr),
    "Sales Var": parseFloat(row.sales_var),
    "ROCE": parseFloat(row.roce),
    // Derived so clients can re-price Mkt Cap / P-E against a live quote -
    // the stored pair is only correct at the CMP of the last sync run.
    "Shares": impliedShares(mktCap, cmp),
    "EPS": impliedEps(cmp, pe),
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
       AND (
         ('${range}' = '1d' AND "record_time" > DATE_TRUNC('day', (SELECT MAX("record_time") FROM ${source.historyTable} WHERE "${source.historyIdCol}" = $1 AND ${sessionFilter})))
         OR 
         ('${range}' != '1d' AND "record_time" >= (SELECT MAX("record_time") FROM ${source.historyTable} WHERE "${source.historyIdCol}" = $1 AND ${sessionFilter}) - INTERVAL '${cfg.interval}')
       )
     ORDER BY "record_time" DESC
     LIMIT $2`,
    [resolvedCode, limit]
  );

  const history = result.rows;
  let changePercent = 0;
  if (history.length > 0) {
    const latestValue = Number(history[0].value);
    // 1D is the day-change, so use the previous close the exchange feed already
    // stores on each row. Measuring against the earliest tick in the window made
    // the response contradict history[0].change_pct, which is the exchange's own
    // number for the same move. Longer ranges keep the window convention.
    const prevClose = range === '1d' && history[0].prev_close != null
      ? Number(history[0].prev_close)
      : null;
    if (prevClose !== null && prevClose > 0) {
      changePercent = ((latestValue - prevClose) / prevClose) * 100;
    } else {
      const earliestValue = Number(history[history.length - 1].value);
      changePercent = earliestValue ? ((latestValue - earliestValue) / earliestValue) * 100 : 0;
    }
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
            COALESCE(hp_latest."prev_close", hp_prev."prev_close") AS prev_close,
            CASE WHEN COALESCE(hp_latest."prev_close", hp_prev."prev_close")::float > 0
              THEN ((hp_latest."close_price"::float - COALESCE(hp_latest."prev_close", hp_prev."prev_close")::float)
                    / COALESCE(hp_latest."prev_close", hp_prev."prev_close")::float) * 100
              ELSE 0
            END AS change_percent,
            hp_latest."volume"
     FROM ${source.constituentsTable} c
     JOIN company_stock cs ON cs."FinInstrmId" = c.${source.constituentsStockCol}
     LEFT JOIN LATERAL (
       SELECT open_price, close_price, volume, prev_close, record_date
       FROM historical_prices hp
       WHERE hp."FinInstrmId" = cs."FinInstrmId"
       ORDER BY record_date DESC
       LIMIT 1
     ) hp_latest ON TRUE
     LEFT JOIN LATERAL (
       -- Fallback for constituents the live feeds didn't cover this session.
       -- Plain range predicate on the indexed record_date so this is a backward
       -- index scan that stops at the first row; DATE(record_date) here made the
       -- index unusable and blew the statement timeout under write load.
       -- Ordering by record_date alone (rather than preferring the previous
       -- day's midnight EOD bar) is equivalent in practice: an instrument that
       -- has intraday bars is one the feeds cover, and so has prev_close set
       -- above, leaving this arm to instruments whose only bars are EOD.
       SELECT close_price AS prev_close
       FROM historical_prices hp2
       WHERE hp2."FinInstrmId" = cs."FinInstrmId"
         AND hp2.record_date < DATE_TRUNC('day', hp_latest."record_date")
       ORDER BY hp2.record_date DESC
       LIMIT 1
     ) hp_prev ON TRUE
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

export default router;
