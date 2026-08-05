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
    `SELECT cs."FinInstrmId", cs."TckrSymb", cs."FinInstrmNm", cs."ISIN", cs."SctySrs", cs."Sgmt",
            COALESCE(sm."cmp", cs."LastPric") AS "LastPric", 
            cs."TtlTradgVol", cs."TtlTrfVal", cs."TtlNbOfTxsExctd", 
            COALESCE(sm."updated_at", cs."TradDt") AS "TradDt", 
            COALESCE(sm."updated_at", cs."BizDt") AS "BizDt"
     FROM company_stock cs
     LEFT JOIN stock_metrics sm ON (sm.symbol = cs."FinInstrmId"::text OR UPPER(sm.symbol) = UPPER(cs."TckrSymb"))
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

// GET /api/history/:symbol?limit=30 - daily OHLCV history for a ticker
router.get('/history/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const limit = clampLimit(req.query.limit, 30, 1000);
  const result = await pool.query(
    `SELECT hp."record_date", hp."open_price", hp."high_price", hp."low_price",
            hp."close_price", hp."adj_close", hp."volume", hp."dividends", hp."stock_splits"
     FROM historical_prices hp
     JOIN company_stock cs ON cs."FinInstrmId" = hp."FinInstrmId"
     WHERE UPPER(cs."TckrSymb") = UPPER($1) OR cs."FinInstrmId"::text = $1
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
    whereClause = 'WHERE ci.industry_name = $1 OR ci.leaf_name = $1';
    params.push(industry);
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
