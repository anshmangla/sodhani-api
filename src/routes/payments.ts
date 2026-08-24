import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { createOrder, verifyCheckoutSignature } from '../services/razorpayService';
import { completePurchase } from '../services/purchaseService';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// POST /api/payments/order
router.post('/order', requireAuth, asyncHandler(async (req, res) => {
  const { call_id: callId } = req.body ?? {};

  if (typeof callId !== 'string' || callId.trim() === '') {
    res.status(400).json({ error: 'call_id is required' });
    return;
  }

  const callResult = await pool.query(
    `SELECT rc.id, rc.is_paid, rc.price_paise, ra.is_active AS ra_is_active, ra.razorpay_account_id
     FROM research_calls rc
     JOIN research_analysts ra ON ra.id = rc.ra_id
     WHERE rc.id = $1`,
    [callId]
  );
  if (callResult.rows.length === 0) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const row = callResult.rows[0];

  if (!row.ra_is_active) {
    res.status(400).json({ error: 'This call is no longer available for purchase' });
    return;
  }

  if (!row.is_paid) {
    res.status(400).json({ error: 'This call is not a paid call' });
    return;
  }

  const purchasedResult = await pool.query(
    'SELECT 1 FROM purchased_calls WHERE user_id = $1 AND call_id = $2',
    [req.authUserId, callId]
  );
  if (purchasedResult.rows.length > 0) {
    res.status(200).json({ already_purchased: true });
    return;
  }

  const receipt = `${callId.slice(0, 8)}-${Date.now()}`;
  const amountWithTax = Math.round(row.price_paise * 1.05);
  
  const order = await createOrder(amountWithTax, receipt, {
    user_id: req.authUserId!,
    call_id: callId,
  }, row.razorpay_account_id);

  await pool.query(
    `INSERT INTO payments (user_id, call_id, razorpay_order_id, amount_paise, status)
     VALUES ($1, $2, $3, $4, 'created')
     RETURNING id`,
    [req.authUserId, callId, order.id, amountWithTax]
  );

  res.status(201).json({
    order_id: order.id,
    amount_paise: amountWithTax,
    key_id: process.env.RAZORPAY_KEY_ID,
  });
}));

// POST /api/payments/verify
router.post('/verify', requireAuth, asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    res.status(400).json({
      error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required',
    });
    return;
  }

  const validSignature = verifyCheckoutSignature(
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  );
  if (!validSignature) {
    res.status(400).json({ error: 'Invalid payment signature' });
    return;
  }

  // Signature has been verified above — completePurchase may now be called.
  // No ownership check against req.authUserId here by design: completePurchase
  // grants the purchase to the user_id/call_id stored on the payments row
  // (set at /order time), not to whoever happens to call /verify.
  try {
    const result = await completePurchase({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      source: 'client',
    });
    res.status(200).json({ ok: true, purchased: true, already_processed: result.alreadyProcessed });
  } catch (err) {
    console.error('[payments/verify] completePurchase failed:', err);
    res.status(400).json({ error: 'Unable to verify purchase' });
  }
}));

export default router;
