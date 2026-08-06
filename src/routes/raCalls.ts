import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireRaAuth } from '../auth/raMiddleware';
import { searchCompanies } from '../data/companies';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const VALID_RECOMMENDATIONS = ['Buy', 'Hold', 'Sell'];

// GET /api/ra/companies?search=
router.get('/companies', requireRaAuth, asyncHandler(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const companies = await searchCompanies(search, 20);
  res.status(200).json({ companies });
}));

// POST /api/ra/calls
router.post('/calls', requireRaAuth, asyncHandler(async (req, res) => {
  const {
    scrip_code,
    company_name,
    recommendation,
    target_price,
    stop_loss,
    buying_range,
    holding_period,
    is_paid,
    price_paise,
    current_price_at_publish,
    volume_at_publish,
  } = req.body ?? {};

  if (typeof scrip_code !== 'string' || scrip_code.trim() === '') {
    res.status(400).json({ error: 'scrip_code is required' });
    return;
  }
  if (typeof company_name !== 'string' || company_name.trim() === '') {
    res.status(400).json({ error: 'company_name is required' });
    return;
  }
  if (typeof recommendation !== 'string' || !VALID_RECOMMENDATIONS.includes(recommendation)) {
    res.status(400).json({ error: "recommendation must be one of 'Buy', 'Hold', 'Sell'" });
    return;
  }
  if (typeof target_price !== 'number' || !Number.isFinite(target_price)) {
    res.status(400).json({ error: 'target_price is required and must be a number' });
    return;
  }

  const isPaid = is_paid === true;

  let pricePaise: number | null = null;
  if (isPaid) {
    if (typeof price_paise !== 'number' || !Number.isFinite(price_paise) || price_paise <= 0) {
      res.status(400).json({ error: 'price_paise is required and must be a positive number when is_paid is true' });
      return;
    }
    pricePaise = price_paise;
  } else {
    pricePaise = null;
  }

  const stopLoss = typeof stop_loss === 'number' && Number.isFinite(stop_loss) ? stop_loss : null;
  const currentPriceAtPublish =
    typeof current_price_at_publish === 'number' && Number.isFinite(current_price_at_publish)
      ? current_price_at_publish
      : null;
  const volumeAtPublish =
    typeof volume_at_publish === 'number' && Number.isInteger(volume_at_publish) ? volume_at_publish : null;
  const buyingRange = typeof buying_range === 'string' ? buying_range : null;
  const holdingPeriod = typeof holding_period === 'string' ? holding_period : null;

  const result = await pool.query(
    `INSERT INTO research_calls
      (ra_id, scrip_code, company_name, recommendation, current_price_at_publish,
       volume_at_publish, target_price, stop_loss, buying_range, holding_period,
       is_paid, price_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      req.authRaId,
      scrip_code,
      company_name,
      recommendation,
      currentPriceAtPublish,
      volumeAtPublish,
      target_price,
      stopLoss,
      buyingRange,
      holdingPeriod,
      isPaid,
      pricePaise,
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

// POST /api/ra/calls/:id/comments
router.post('/calls/:id/comments', requireRaAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { body } = req.body ?? {};

  if (typeof body !== 'string' || body.trim() === '') {
    res.status(400).json({ error: 'body is required' });
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
    [id, req.authRaId, body]
  );

  res.status(201).json({ comment: result.rows[0] });
}));

// GET /api/ra/calls/:id/comments
router.get('/calls/:id/comments', requireRaAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

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
