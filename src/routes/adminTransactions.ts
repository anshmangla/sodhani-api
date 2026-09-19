import { Router, Request, Response, NextFunction } from 'express';
import { clampLimit } from './calls';
import {
  getPlatformRevenueSummary,
  getRevenueOverTime,
  getRevenueByRa,
  getPaymentsList,
  getPayoutsList,
} from '../services/adminTransactionsService';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

// GET /api/admin/transactions/summary
router.get('/summary', asyncHandler(async (_req, res) => {
  const summary = await getPlatformRevenueSummary();
  res.status(200).json({
    total_paise: summary.totalPaise,
    this_month_paise: summary.thisMonthPaise,
    this_year_paise: summary.thisYearPaise,
    failed_payment_count: summary.failedPaymentCount,
  });
}));

// GET /api/admin/transactions/revenue-over-time?days=
router.get('/revenue-over-time', asyncHandler(async (req, res) => {
  const days = clampLimit(req.query.days, 30, 365);
  const rows = await getRevenueOverTime(days);
  res.status(200).json({ data: rows.map((r) => ({ day: r.day, amount_paise: r.amountPaise })) });
}));

// GET /api/admin/transactions/by-ra?limit=
router.get('/by-ra', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 100);
  const rows = await getRevenueByRa(limit);
  res.status(200).json({
    data: rows.map((r) => ({ ra_id: r.raId, ra_name: r.raName, total_paise: r.totalPaise, count: r.count })),
  });
}));

// GET /api/admin/transactions/payments?status=&user_id=&ra_id=&call_id=&from=&to=&page=&limit=
router.get('/payments', asyncHandler(async (req, res) => {
  const { status, user_id, ra_id, call_id, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);

  const filters: Parameters<typeof getPaymentsList>[0] = {};
  if (status === 'created' || status === 'paid' || status === 'failed') filters.status = status;
  if (typeof user_id === 'string' && isValidUuid(user_id)) filters.userId = user_id;
  if (typeof ra_id === 'string' && isValidUuid(ra_id)) filters.raId = ra_id;
  if (typeof call_id === 'string' && isValidUuid(call_id)) filters.callId = call_id;
  if (typeof from === 'string' && from.trim()) filters.from = from.trim();
  if (typeof to === 'string' && to.trim()) filters.to = to.trim();

  const { rows, total } = await getPaymentsList(filters, page, limit);
  res.status(200).json({
    data: rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

// GET /api/admin/transactions/payouts?ra_id=&status=&settlement_status=&page=&limit=
router.get('/payouts', asyncHandler(async (req, res) => {
  const { ra_id, status, settlement_status } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);

  const filters: Parameters<typeof getPayoutsList>[0] = {};
  if (typeof ra_id === 'string' && isValidUuid(ra_id)) filters.raId = ra_id;
  if (status === 'processed' || status === 'failed') filters.status = status;
  if (settlement_status === 'pending' || settlement_status === 'settled') filters.settlementStatus = settlement_status;

  const { rows, total } = await getPayoutsList(filters, page, limit);
  res.status(200).json({
    data: rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

export default router;
