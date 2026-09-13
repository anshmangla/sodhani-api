import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireRaAuth } from '../auth/raMiddleware';
import { searchCompanies } from '../data/companies';
import { getEarningsSummary, getRecentPayouts, getEarningsByCall } from '../services/raTransfersService';
import { parseCallInput } from '../validation/callInput';

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

// GET /api/ra/companies?search=
router.get('/companies', asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';
  const companies = await searchCompanies(search, 20);
  res.status(200).json({ companies });
}));

// POST /api/ra/calls
router.post('/calls', requireRaAuth, asyncHandler(async (req, res) => {
  const parsed = parseCallInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const v = parsed.value;

  const result = await pool.query(
    `INSERT INTO research_calls
      (ra_id, scrip_code, company_name, recommendation, instrument_type, expiry_date,
       strike_price, option_type, current_price_at_publish, volume_at_publish,
       target_price, stop_loss, entry_price_min, entry_price_max, buying_range,
       holding_period, description, is_paid, price_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      req.authRaId,
      v.scripCode,
      v.companyName,
      v.recommendation,
      v.instrumentType,
      v.expiryDate,
      v.strikePrice,
      v.optionType,
      v.currentPriceAtPublish,
      v.volumeAtPublish,
      v.targetPrice,
      v.stopLoss,
      v.entryPriceMin,
      v.entryPriceMax,
      v.buyingRange,
      v.holdingPeriod,
      v.description,
      v.isPaid,
      v.pricePaise,
    ]
  );

  res.status(201).json({ call: result.rows[0] });
}));

// GET /api/ra/calls/mine
router.get('/calls/mine', requireRaAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT rc.*,
            COUNT(pc.id)::int AS purchase_count,
            COALESCE(SUM(p.amount_paise), 0)::bigint AS revenue_paise
     FROM research_calls rc
     LEFT JOIN purchased_calls pc ON pc.call_id = rc.id
     LEFT JOIN payments p ON p.id = pc.payment_id
     WHERE rc.ra_id = $1
     GROUP BY rc.id
     ORDER BY rc.created_at DESC`,
    [req.authRaId]
  );
  res.status(200).json({ calls: result.rows });
}));

// GET /api/ra/dashboard
router.get('/dashboard', requireRaAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM research_calls WHERE ra_id = $1) AS total_calls,
       (SELECT COUNT(*)::int FROM research_calls WHERE ra_id = $1 AND is_paid = true) AS total_paid_calls,
       (SELECT total_sales FROM research_analysts WHERE id = $1) AS total_sales`,
    [req.authRaId]
  );
  res.status(200).json({ dashboard: result.rows[0] });
}));

// GET /api/ra/dashboard/earnings
router.get('/dashboard/earnings', requireRaAuth, asyncHandler(async (req, res) => {
  const raId = req.authRaId as string;
  const [summary, recentPayouts, byCall] = await Promise.all([
    getEarningsSummary(raId),
    getRecentPayouts(raId, 20),
    getEarningsByCall(raId),
  ]);
  res.status(200).json({
    earnings: {
      total_paise: summary.totalPaise,
      this_month_paise: summary.thisMonthPaise,
      this_year_paise: summary.thisYearPaise,
      failed_transfer_count: summary.failedTransferCount,
    },
    recent_payouts: recentPayouts.map((p) => ({
      amount_paise: p.amountPaise,
      processed_at: p.processedAt,
      call_id: p.callId,
      company_name: p.companyName,
      recommendation: p.recommendation,
      settlement_status: p.settlementStatus,
    })),
    by_call: byCall.map((c) => ({
      call_id: c.callId,
      company_name: c.companyName,
      recommendation: c.recommendation,
      total_paise: c.totalPaise,
      count: c.count,
    })),
  });
}));

// POST /api/ra/calls/:id/comments
router.post('/calls/:id/comments', requireRaAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const { body } = req.body ?? {};

  if (typeof body !== 'string' || body.trim().length === 0 || body.trim().length > 2000) {
    res.status(400).json({ error: 'body is required (between 1 and 2000 characters)' });
    return;
  }

  const callResult = await pool.query('SELECT ra_id FROM research_calls WHERE id = $1', [id]);
  if (callResult.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  if (callResult.rows[0].ra_id !== req.authRaId) {
    res.status(403).json({ error: 'Not your call' });
    return;
  }

  const result = await pool.query(
    'INSERT INTO call_comments (call_id, ra_id, body) VALUES ($1, $2, $3) RETURNING *',
    [id, req.authRaId, body.trim()]
  );

  res.status(201).json({ comment: result.rows[0] });
}));

// GET /api/ra/calls/:id/comments
router.get('/calls/:id/comments', requireRaAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  const callResult = await pool.query('SELECT ra_id FROM research_calls WHERE id = $1', [id]);
  if (callResult.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  if (callResult.rows[0].ra_id !== req.authRaId) {
    res.status(403).json({ error: 'Not your call' });
    return;
  }

  const commentsResult = await pool.query(
    'SELECT id, body, created_at FROM call_comments WHERE call_id = $1 ORDER BY created_at ASC',
    [id]
  );

  res.status(200).json({ comments: commentsResult.rows });
}));

// PATCH /api/ra/calls/:id/status
router.patch('/calls/:id/status', requireRaAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const { status } = req.body ?? {};

  if (status !== 'open' && status !== 'closed') {
    res.status(400).json({ error: "status must be 'open' or 'closed'" });
    return;
  }

  const callResult = await pool.query('SELECT ra_id FROM research_calls WHERE id = $1', [id]);
  if (callResult.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  if (callResult.rows[0].ra_id !== req.authRaId) {
    res.status(403).json({ error: 'Not your call' });
    return;
  }

  const result = await pool.query(
    'UPDATE research_calls SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [status, id]
  );

  res.status(200).json({ call: result.rows[0] });
}));

export default router;
