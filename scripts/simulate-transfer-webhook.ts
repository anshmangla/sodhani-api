import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';

// Sends a correctly-signed transfer.processed or transfer.failed webhook to
// a locally running sodhani-api, for manually verifying the webhook wiring
// end-to-end (signature verification -> handler -> raTransfersService ->
// DB row). Requires `npm run dev` running in another terminal, and a
// payments row whose razorpay_order_id matches the orderId argument
// (see Task 3 Step 3 for how to create one).
//
// Usage:
//   npx ts-node scripts/simulate-transfer-webhook.ts processed <orderId> <transferId> <amountPaise>
//   npx ts-node scripts/simulate-transfer-webhook.ts failed <orderId> <transferId> <amountPaise> "<error description>"

const [, , kind, orderId, transferId, amountPaiseStr, errorDescription] = process.argv;

if (!kind || !orderId || !transferId || !amountPaiseStr || (kind !== 'processed' && kind !== 'failed')) {
  console.error('Usage: ts-node scripts/simulate-transfer-webhook.ts <processed|failed> <orderId> <transferId> <amountPaise> ["<error description>"]');
  process.exit(1);
}

const amount = parseInt(amountPaiseStr, 10);
const now = Math.floor(Date.now() / 1000);

const entity: Record<string, unknown> = {
  id: transferId,
  entity: 'transfer',
  status: kind,
  settlement_status: null,
  source: orderId,
  recipient: 'acc_simulated',
  amount,
  currency: 'INR',
  amount_reversed: 0,
  notes: {},
  fees: 0,
  tax: 0,
  on_hold: false,
  on_hold_until: null,
  recipient_settlement_id: null,
  created_at: now,
  processed_at: kind === 'processed' ? now : null,
  error: kind === 'failed'
    ? { code: 'BAD_REQUEST_TRANSFER_INSUFFICIENT_BALANCE', description: errorDescription || 'Simulated failure', field: null, source: 'transfer', step: 'balance_check', reason: 'insufficient_balance' }
    : { code: null, description: null, field: null, source: null, step: null, reason: null },
};

const payload = {
  entity: 'event',
  account_id: 'acc_simulated',
  event: `transfer.${kind}`,
  contains: ['transfer'],
  payload: { transfer: { entity } },
  created_at: now,
};

const rawBody = JSON.stringify(payload);
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!secret) {
  console.error('RAZORPAY_WEBHOOK_SECRET is not set in .env');
  process.exit(1);
}
const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

const port = process.env.PORT || '4000';

fetch(`http://localhost:${port}/api/payments/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
  body: rawBody,
})
  .then(async (res) => {
    console.log('Response status:', res.status);
    console.log('Response body:', await res.text());
  })
  .catch((err) => {
    console.error('Request failed:', err);
    process.exit(1);
  });
