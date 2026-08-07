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

// GET /api/top-gainers?limit=10
router.get('/top-gainers', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 50);
  const result = await pool.query(
    `SELECT "rank", "scrip_cd", "scripname", "long_name", "ltradert", "change_val", "change_percent", "record_time"
     FROM bse_top_gainers_losers
     WHERE "type" = 'gainer'
     ORDER BY "change_percent" DESC
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
     ORDER BY "change_percent" ASC
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
     WHERE "record_date"::DATE = (SELECT MAX("record_date")::DATE FROM bse_spurt_volume)
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
      timeFilter = `AND DATE(hp."record_date") = (
        SELECT MAX(DATE("record_date"))
        FROM historical_prices
        WHERE "FinInstrmId" = cs."FinInstrmId"
      )`;
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
  
  if (isLineChart) {
    // 2. Algorithmic Downsampling
    // For line/area charts, fetch raw EOD data ordered ASC for LTTB downsampling
    sql = `SELECT DISTINCT ON (DATE(hp."record_date")) 
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
      // Duration < 1 Year: Raw Daily Data
      sql = `SELECT DISTINCT ON (DATE(hp."record_date")) 
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

  // Calculate percentage change
  // Note: history is ordered DESC by date (newest first, oldest last)
  const latestPrice = Number(history[0].close_price);
  const oldestPrice = Number(history[history.length - 1].close_price);
  const changePercent = oldestPrice ? ((latestPrice - oldestPrice) / oldestPrice) * 100 : 0;
  
  for (let i = 0; i < history.length; i++) {
    const current = Number(history[i].close_price);
    const prev = i < history.length - 1 ? Number(history[i+1].close_price) : current;
    history[i].change_percent = prev ? ((current - prev) / prev) * 100 : 0;
  }

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
    'cmp': 'sm.cmp',
    'pe': 'sm.pe',
    'mkt_cap': 'sm.mkt_cap',
    'div_yld': 'sm.div_yld',
    'np_qtr': 'sm.np_qtr',
    'profit_var': 'sm.profit_var',
    'sales_qtr': 'sm.sales_qtr',
    'sales_var': 'sm.sales_var',
    'roce': 'sm.roce',
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

  // Get total count for pagination
  const countQuery = `
    SELECT COUNT(*) 
    FROM stock_metrics sm
    JOIN company_stock cs ON 
       (sm.symbol = cs."FinInstrmId"::text OR UPPER(sm.symbol) = UPPER(cs."TckrSymb"))
    LEFT JOIN company_sectors ci ON cs."FinInstrmId"::text = ci.fin_instrm_id
    ${whereClause}
  `;
  const countResult = await pool.query(countQuery, params);
  const totalCount = parseInt(countResult.rows[0].count, 10);

  // Get paginated data
  const dataParams = [...params, limit, offset];
  const dataQuery = `
    SELECT 
      cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm",
      ci.sector_name, ci.industry_name, ci.leaf_name,
      sm.cmp, sm.pe, sm.mkt_cap, sm.div_yld, sm.np_qtr, sm.profit_var, sm.sales_qtr, sm.sales_var, sm.roce
    FROM stock_metrics sm
    JOIN company_stock cs ON 
       (sm.symbol = cs."FinInstrmId"::text OR UPPER(sm.symbol) = UPPER(cs."TckrSymb"))
    LEFT JOIN company_sectors ci ON cs."FinInstrmId"::text = ci.fin_instrm_id
    ${whereClause}
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

  // 2. If not found, check exchange_code_mappings.json for BSE to NSE mapping
  if (!data) {
    try {
      const mappingsPath = path.resolve(__dirname, '../../exchange_code_mappings.json');
      const mappingsData = await fs.readFile(mappingsPath, 'utf-8');
      const mappingsJson = JSON.parse(mappingsData);
      const bseToNse = mappingsJson.bse_to_nse || {};
      
      const nseSymbol = bseToNse[query];
      if (nseSymbol) {
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
  const data = await searchStaticStock(outputDir, query);

  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `Static JSON not found for '${query}'` });
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
  const data = await searchStaticStock(consolidatedDir, query);

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

export default router;
