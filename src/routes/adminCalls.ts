import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { clampLimit } from './calls';
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

// GET /api/admin/calls?ra_id=&status=&instrument_type=&is_paid=&search=&page=&limit=
// Across ALL RAs, unscoped and not paywall-filtered — admin sees every field
// unconditionally, unlike calls.ts's buildPreviewPayload/buildFullPayload
// which exist specifically to enforce the consumer paywall.
router.get('/', asyncHandler(async (req, res) => {
  const { ra_id, status, instrument_type, is_paid, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = clampLimit(req.query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof ra_id === 'string' && isValidUuid(ra_id)) {
    params.push(ra_id);
    conditions.push(`rc.ra_id = $${params.length}`);
  }
  if (status === 'open' || status === 'closed') {
    params.push(status);
    conditions.push(`rc.status = $${params.length}`);
  }
  if (instrument_type === 'EQUITY' || instrument_type === 'FUTURES' || instrument_type === 'OPTIONS') {
    params.push(instrument_type);
    conditions.push(`rc.instrument_type = $${params.length}`);
  }
  if (is_paid === 'true' || is_paid === 'false') {
    params.push(is_paid === 'true');
    conditions.push(`rc.is_paid = $${params.length}`);
  }
  if (typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(rc.company_name ILIKE $${params.length} OR rc.scrip_code ILIKE $${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM research_calls rc ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT rc.*, ra.full_name AS ra_name
     FROM research_calls rc
     JOIN research_analysts ra ON ra.id = rc.ra_id
     ${whereClause}
     ORDER BY rc.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  res.status(200).json({
    data: dataResult.rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}));

// GET /api/admin/calls/:id — detail + revenue, reusing the purchase_count /
// revenue_paise subquery shape from raCalls.ts's GET /calls/mine, without
// the ra_id filter.
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  const result = await pool.query(
    `SELECT rc.*, ra.full_name AS ra_name,
            COUNT(pc.id)::int AS purchase_count,
            COALESCE(SUM(p.amount_paise), 0)::bigint AS revenue_paise
     FROM research_calls rc
     JOIN research_analysts ra ON ra.id = rc.ra_id
     LEFT JOIN purchased_calls pc ON pc.call_id = rc.id
     LEFT JOIN payments p ON p.id = pc.payment_id
     WHERE rc.id = $1
     GROUP BY rc.id, ra.full_name`,
    [id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  res.status(200).json({ call: result.rows[0] });
}));

// PATCH /api/admin/calls/:id — full-object replace, same validation contract
// as POST /api/ra/calls (parseCallInput), not a sparse patch. ra_id is left
// untouched — reassigning a call to a different RA is out of scope.
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  const parsed = parseCallInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const v = parsed.value;

  const result = await pool.query(
    `UPDATE research_calls SET
       scrip_code = $1, company_name = $2, recommendation = $3, instrument_type = $4,
       expiry_date = $5, strike_price = $6, option_type = $7, current_price_at_publish = $8,
       volume_at_publish = $9, target_price = $10, stop_loss = $11, entry_price_min = $12,
       entry_price_max = $13, buying_range = $14, holding_period = $15, description = $16,
       is_paid = $17, price_paise = $18, updated_at = now()
     WHERE id = $19
     RETURNING *`,
    [
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
      id,
    ]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  res.status(200).json({ call: result.rows[0] });
}));

// PATCH /api/admin/calls/:id/status { status } — same logic as
// raCalls.ts's PATCH /calls/:id/status, minus the ownership check.
router.patch('/:id/status', asyncHandler(async (req, res) => {
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

  const result = await pool.query(
    'UPDATE research_calls SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [status, id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  res.status(200).json({ call: result.rows[0] });
}));

// DELETE /api/admin/calls/:id — plain delete; payments/purchased_calls/
// ra_transfers/call_comments all reference research_calls with no cascade,
// so app.ts's existing 23503 handler already turns any call with history
// into a clean 400 rather than orphaning rows. Only genuinely history-free
// calls can be hard-deleted here — use the status PATCH to close others.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  const result = await pool.query('DELETE FROM research_calls WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  res.status(200).json({ ok: true });
}));

export default router;
