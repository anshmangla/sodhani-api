import { Router, Request, Response, NextFunction } from 'express';
import { verifyWebhookSignature } from '../services/razorpayService';
import { completePurchase } from '../services/purchaseService';
import { recordTransferProcessed, recordTransferFailed } from '../services/raTransfersService';
import { pool } from '../db/pool';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// POST /api/payments/webhook (mounted at '/', so this route's own path is '/')
router.post('/', asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body as Buffer; // Buffer, thanks to express.raw() in app.ts

  if (typeof signature !== 'string' || !verifyWebhookSignature(rawBody, signature)) {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  const event = JSON.parse(rawBody.toString('utf-8'));

  if (event.event === 'account.activated') {
    const accountId = event.payload.account.entity.id;
    console.log('[payments/webhook] Account activated:', accountId);
    await pool.query(
      `UPDATE research_analysts SET onboarding_status = 'active', updated_at = now() WHERE razorpay_account_id = $1`,
      [accountId]
    );
    res.status(200).json({ received: true });
    return;
  }

  if (event.event === 'account.rejected') {
    const accountId = event.payload.account.entity.id;
    console.log('[payments/webhook] Account rejected:', accountId);
    await pool.query(
      `UPDATE research_analysts SET onboarding_status = 'rejected', updated_at = now() WHERE razorpay_account_id = $1`,
      [accountId]
    );
    res.status(200).json({ received: true });
    return;
  }

  if (event.event === 'transfer.processed') {
    const entity = event.payload.transfer.entity;
    try {
      await recordTransferProcessed({
        transferId: entity.id,
        orderId: entity.source,
        amountPaise: entity.amount,
        processedAtEpochSeconds: entity.processed_at,
      });
      console.log('[payments/webhook] Transfer processed:', entity.id);
    } catch (err) {
      console.error('[payments/webhook] recordTransferProcessed failed:', err);
    }
    res.status(200).json({ received: true });
    return;
  }

  if (event.event === 'transfer.failed') {
    const entity = event.payload.transfer.entity;
    try {
      await recordTransferFailed({
        transferId: entity.id,
        orderId: entity.source,
        amountPaise: entity.amount,
        errorDescription: entity.error?.description ?? null,
      });
      console.error('[payments/webhook] Transfer failed:', entity.id, entity.error?.description);
    } catch (err) {
      console.error('[payments/webhook] recordTransferFailed failed:', err);
    }
    res.status(200).json({ received: true });
    return;
  }

  if (event.event === 'settlement.processed') {
    console.log('[payments/webhook] Settlement processed to bank account for amount:', event.payload.settlement.entity.amount);
    res.status(200).json({ received: true });
    return;
  }

  if (event.event === 'payment.failed') {
    console.warn('[payments/webhook] Payment failed:', event.payload.payment.entity.id, event.payload.payment.entity.error_description);
    res.status(200).json({ received: true });
    return;
  }

  if (event.event !== 'payment.captured') {
    // Acknowledge every other event type without acting on it — per Razorpay's
    // documented retry behavior, any non-2xx response triggers indefinite retries,
    // so unhandled event types must still be ack'd with 200.
    res.status(200).json({ received: true });
    return;
  }

  const entity = event.payload.payment.entity;
  try {
    await completePurchase({
      orderId: entity.order_id,
      paymentId: entity.id,
      signature, // the webhook signature header, stored as this completion's audit trail
      source: 'webhook',
    });
  } catch (err) {
    // Once the signature is verified, this event is authentic — per Razorpay's
    // integration guidance, always ack with 200 even if downstream processing
    // fails, to avoid an indefinite retry storm on a permanent error (e.g. no
    // matching payments row). Log for investigation instead.
    console.error('[payments/webhook] completePurchase failed:', err);
  }
  res.status(200).json({ received: true });
}));

export default router;
