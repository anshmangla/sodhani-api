import { Router, Request, Response, NextFunction } from 'express';
import { verifyWebhookSignature } from '../services/razorpayService';
import { completePurchase } from '../services/purchaseService';

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
