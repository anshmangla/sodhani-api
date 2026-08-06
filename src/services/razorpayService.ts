import Razorpay from 'razorpay';
import crypto from 'crypto';

function getKeyId(): string {
  const v = process.env.RAZORPAY_KEY_ID;
  if (!v) throw new Error('RAZORPAY_KEY_ID is not set');
  return v;
}
function getKeySecret(): string {
  const v = process.env.RAZORPAY_KEY_SECRET;
  if (!v) throw new Error('RAZORPAY_KEY_SECRET is not set');
  return v;
}
function getWebhookSecret(): string {
  const v = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!v) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set');
  return v;
}

export async function createOrder(
  amountPaise: number,
  receipt: string,
  notes: Record<string, string>
): Promise<{ id: string; amount: number; currency: string }> {
  const instance = new Razorpay({ key_id: getKeyId(), key_secret: getKeySecret() });
  const order = await instance.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes,
  });
  return { id: order.id, amount: Number(order.amount), currency: order.currency };
}

export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', getKeySecret())
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeCompare(expected, signature);
}

export function verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', getWebhookSecret())
    .update(rawBody)
    .digest('hex');
  return safeCompare(expected, signature);
}

function safeCompare(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(actual ?? '', 'utf-8');
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}
