import { Router, Request, Response, NextFunction } from 'express';
import { InvestmentsService } from '../services/investmentsService';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

// ── Overview & Pulse ────────────────────────────────────────────────────────
router.get(
  '/overview',
  asyncHandler((_req: Request, res: Response) => {
    const data = InvestmentsService.getOverview();
    res.json(data);
  })
);

// ── Universal Search ────────────────────────────────────────────────────────
router.get(
  '/search',
  asyncHandler((req: Request, res: Response) => {
    const q = String(req.query.q || '');
    if (!q.trim()) {
      res.json([]);
      return;
    }
    const type = req.query.type ? String(req.query.type) : undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const results = InvestmentsService.search(q, type, limit);
    res.json(results);
  })
);

// ── Mutual Funds ────────────────────────────────────────────────────────────
// Multi-fund comparison & overlap (Must come before /mf/:code)
router.get(
  '/mf/compare',
  asyncHandler((req: Request, res: Response) => {
    const rawCodes = String(req.query.codes || '');
    const range = String(req.query.range || '1y');
    const codes = rawCodes
      .split(',')
      .map((c) => parseInt(c.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);

    if (codes.length === 0) {
      res.status(400).json({ error: 'Please provide at least one valid scheme code' });
      return;
    }

    const comparison = InvestmentsService.compareMutualFunds(codes, range);
    res.json(comparison);
  })
);

// Mutual Fund List with filtering
router.get(
  '/mf',
  asyncHandler((req: Request, res: Response) => {
    const category = req.query.category ? String(req.query.category) : undefined;
    const amc = req.query.amc ? String(req.query.amc) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const plan = req.query.plan ? String(req.query.plan) : undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);

    const data = InvestmentsService.getMutualFunds({
      category,
      amc,
      search,
      plan,
      limit,
      offset,
    });
    res.json(data);
  })
);

// Scheme details
router.get(
  '/mf/:code',
  asyncHandler((req: Request, res: Response) => {
    const code = parseInt(req.params.code, 10);
    if (isNaN(code)) {
      res.status(400).json({ error: 'Invalid scheme code' });
      return;
    }
    const detail = InvestmentsService.getMutualFundDetail(code);
    if (!detail) {
      res.status(404).json({ error: 'Mutual fund scheme not found' });
      return;
    }
    res.json(detail);
  })
);

// NAV History time series with LTTB downsampling
router.get(
  '/mf/:code/history',
  asyncHandler((req: Request, res: Response) => {
    const code = parseInt(req.params.code, 10);
    if (isNaN(code)) {
      res.status(400).json({ error: 'Invalid scheme code' });
      return;
    }
    const range = String(req.query.range || '1y');
    const data = InvestmentsService.getMutualFundHistory(code, range);
    res.json(data);
  })
);

// Portfolio holdings and sector allocation breakdown
router.get(
  '/mf/:code/holdings',
  asyncHandler((req: Request, res: Response) => {
    const code = parseInt(req.params.code, 10);
    if (isNaN(code)) {
      res.status(400).json({ error: 'Invalid scheme code' });
      return;
    }
    const data = InvestmentsService.getMutualFundHoldings(code);
    res.json(data);
  })
);

// Reverse lookup: Which funds hold this stock or bond?
router.get(
  '/stock-holders/:isin',
  asyncHandler((req: Request, res: Response) => {
    const isin = req.params.isin;
    if (!isin) {
      res.status(400).json({ error: 'ISIN or instrument name required' });
      return;
    }
    const data = InvestmentsService.getFundsHoldingStock(isin);
    res.json(data);
  })
);

// ── ETFs ───────────────────────────────────────────────────────────────────
router.get(
  '/etfs',
  asyncHandler((req: Request, res: Response) => {
    const assetClass = req.query.assetClass ? String(req.query.assetClass) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);

    const data = InvestmentsService.getEtfs({ assetClass, search, limit, offset });
    res.json(data);
  })
);

router.get(
  '/etfs/:symbol',
  asyncHandler((req: Request, res: Response) => {
    const symbol = req.params.symbol;
    const data = InvestmentsService.getEtfDetail(symbol);
    if (!data) {
      res.status(404).json({ error: 'ETF not found' });
      return;
    }
    res.json(data);
  })
);

router.get(
  '/etfs/:symbol/prices',
  asyncHandler((req: Request, res: Response) => {
    const symbol = req.params.symbol;
    const range = String(req.query.range || '1y');
    const data = InvestmentsService.getEtfPriceHistory(symbol, range);
    res.json(data);
  })
);

// ── Corporate Bonds ────────────────────────────────────────────────────────
router.get(
  '/bonds',
  asyncHandler((req: Request, res: Response) => {
    const rating = req.query.rating ? String(req.query.rating) : undefined;
    const issuer = req.query.issuer ? String(req.query.issuer) : undefined;
    const minYield = req.query.minYield ? parseFloat(String(req.query.minYield)) : undefined;
    const maxYield = req.query.maxYield ? parseFloat(String(req.query.maxYield)) : undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);

    const data = InvestmentsService.getCorporateBonds({
      rating,
      issuer,
      minYield,
      maxYield,
      limit,
      offset,
    });
    res.json(data);
  })
);

router.get(
  '/bonds/:isin',
  asyncHandler((req: Request, res: Response) => {
    const isin = req.params.isin;
    const data = InvestmentsService.getCorporateBondDetail(isin);
    if (!data) {
      res.status(404).json({ error: 'Bond not found' });
      return;
    }
    res.json(data);
  })
);

router.get(
  '/bonds/:isin/cashflows',
  asyncHandler((req: Request, res: Response) => {
    const isin = req.params.isin;
    const data = InvestmentsService.getBondCashflows(isin);
    res.json(data);
  })
);

router.get(
  '/bonds/:isin/spread',
  asyncHandler((req: Request, res: Response) => {
    const isin = req.params.isin;
    const data = InvestmentsService.getCorporateBondSpread(isin);
    res.json(data);
  })
);

// ── Government Securities ──────────────────────────────────────────────────
router.get(
  '/gsec/yield-curve',
  asyncHandler((_req: Request, res: Response) => {
    const data = InvestmentsService.getGSecYieldCurve();
    res.json(data);
  })
);

// ── Fixed Deposits ─────────────────────────────────────────────────────────
router.get(
  '/fd/rates',
  asyncHandler((_req: Request, res: Response) => {
    const data = InvestmentsService.getFdRates();
    res.json(data);
  })
);

export default router;
