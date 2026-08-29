import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { computeWeightedPe, categorizeByRank } from '../services/peerMetrics';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

type PeerLevelRow = {
  symbol: string;
  name: string;
  cmp: number | null;
  pe: number | null;
  mkt_cap: number | null;
  profit_var: number | null;
};

const LEVEL_COLUMNS = ['leaf_code', 'industry_code', 'sector_code'] as const;
type LevelColumn = (typeof LEVEL_COLUMNS)[number];
type PeerLevel = 'leaf' | 'industry' | 'sector' | 'none';

const COLUMN_TO_LEVEL: Record<LevelColumn, PeerLevel> = {
  leaf_code: 'leaf',
  industry_code: 'industry',
  sector_code: 'sector',
};

async function fetchLevelRows(column: LevelColumn, code: string): Promise<PeerLevelRow[]> {
  // stock_metrics can carry two rows for the same company - one keyed by
  // ticker, one by numeric BSE code (with independently stale cmp/pe/mkt_cap
  // values) - so a plain join fans out into duplicate peer rows. DISTINCT ON
  // picks a single, deterministic row per company_stock match instead.
  //
  // No UPPER() here: TckrSymb/fin_instrm_id/symbol are already 100%
  // uppercase in this data (verified directly against production).
  // UPPER() on either side defeats Postgres's ability to use the primary
  // key indexes on company_sectors.fin_instrm_id / stock_metrics.symbol,
  // forcing a nested-loop scan of every company_stock row against every row
  // of the other table - measured ~6.5s for one industry lookup with
  // UPPER(), ~10ms without it.
  const result = await pool.query(
    `SELECT DISTINCT ON (cs."FinInstrmId")
            COALESCE(cs."TckrSymb", cs."FinInstrmId"::text) AS symbol,
            cs."FinInstrmNm" AS name,
            sm.cmp, sm.pe, sm.mkt_cap, sm.profit_var
     FROM company_sectors ci
     JOIN company_stock cs ON
        cs."FinInstrmId"::text = ci.fin_instrm_id OR cs."TckrSymb" = ci.fin_instrm_id
     LEFT JOIN stock_metrics sm ON
        sm.symbol = cs."FinInstrmId"::text OR sm.symbol = cs."TckrSymb"
     WHERE ci.${column} = $1
     ORDER BY cs."FinInstrmId", sm.mkt_cap DESC NULLS LAST`,
    [code]
  );
  return result.rows;
}

// GET /api/company/:symbol/peers
router.get('/company/:symbol/peers', asyncHandler(async (req, res) => {
  const { symbol } = req.params;

  const stockResult = await pool.query(
    `SELECT "FinInstrmId", "TckrSymb", "FinInstrmNm"
     FROM company_stock
     WHERE UPPER("TckrSymb") = UPPER($1) OR "FinInstrmId"::text = $1
     LIMIT 1`,
    [symbol]
  );

  if (stockResult.rows.length === 0) {
    res.status(404).json({ error: `No company found for symbol '${symbol}'` });
    return;
  }

  const stock = stockResult.rows[0] as { FinInstrmId: string; TckrSymb: string | null; FinInstrmNm: string };
  const ownSymbol = (stock.TckrSymb ?? stock.FinInstrmId).toUpperCase();
  const responseSymbol = stock.TckrSymb ?? stock.FinInstrmId;

  const rankResult = await pool.query(
    `WITH ranked AS (
       SELECT symbol, RANK() OVER (ORDER BY mkt_cap DESC NULLS LAST) AS rnk
       FROM stock_metrics
     )
     SELECT rnk FROM ranked
     WHERE symbol = $1 OR symbol = $2
     LIMIT 1`,
    [stock.FinInstrmId, stock.TckrSymb]
  );
  const marketCapCategory = categorizeByRank(rankResult.rows[0]?.rnk ?? null);

  const classResult = await pool.query(
    `SELECT sector_code, sector_name, industry_code, industry_name, leaf_code, leaf_name
     FROM company_sectors
     WHERE fin_instrm_id = $1 OR fin_instrm_id = $2
     LIMIT 1`,
    [stock.FinInstrmId, stock.TckrSymb]
  );

  if (classResult.rows.length === 0) {
    res.json({
      symbol: responseSymbol,
      classification: null,
      peerLevel: 'none',
      peers: [],
      industryPe: null,
      marketCapCategory,
    });
    return;
  }

  const c = classResult.rows[0];
  const classification = {
    sector: { code: c.sector_code, name: c.sector_name },
    industry: { code: c.industry_code, name: c.industry_name },
    leaf: { code: c.leaf_code, name: c.leaf_name },
  };
  const codesByLevel: Record<LevelColumn, string> = {
    leaf_code: c.leaf_code,
    industry_code: c.industry_code,
    sector_code: c.sector_code,
  };

  let peerLevel: PeerLevel = 'none';
  let rows: PeerLevelRow[] = [];

  for (const column of LEVEL_COLUMNS) {
    const levelRows = await fetchLevelRows(column, codesByLevel[column]);
    const withoutSelf = levelRows.filter((r) => r.symbol.toUpperCase() !== ownSymbol);
    peerLevel = COLUMN_TO_LEVEL[column];
    rows = levelRows;
    if (withoutSelf.length >= 3 || column === 'sector_code') {
      break;
    }
  }

  const industryPe = computeWeightedPe(rows);
  const peers = rows
    .filter((r) => r.symbol.toUpperCase() !== ownSymbol)
    .sort((a, b) => (b.mkt_cap ?? 0) - (a.mkt_cap ?? 0))
    .slice(0, 10)
    .map((r) => ({ symbol: r.symbol, name: r.name, cmp: r.cmp, changePct: r.profit_var }));

  if (peers.length === 0) {
    peerLevel = 'none';
  }

  res.json({
    symbol: responseSymbol,
    classification,
    peerLevel,
    peers,
    industryPe,
    marketCapCategory,
  });
}));

export default router;
