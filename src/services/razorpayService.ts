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

function getRazorpayInstance() {
  return new Razorpay({ key_id: getKeyId(), key_secret: getKeySecret() });
}

export async function createOrder(
  amountPaise: number,
  receipt: string,
  notes: Record<string, string>,
  raAccountId?: string
): Promise<{ id: string; amount: number; currency: string }> {
  const instance = getRazorpayInstance();
  
  const options: any = {
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes,
  };

  // If a research analyst's Razorpay account ID is provided, set up a transfer for 90% of the sale
  if (raAccountId) {
    const sellerAmount = Math.floor(amountPaise * 0.9);
    options.transfers = [
      {
        account: raAccountId,
        amount: sellerAmount,
        currency: 'INR',
      }
    ];
  }

  const order = await instance.orders.create(options);
  return { id: order.id, amount: Number(order.amount), currency: order.currency };
}

export async function createLinkedAccount(data: any): Promise<any> {
  const instance = getRazorpayInstance();
  return await instance.accounts.create(data);
}

export async function createStakeholder(accountId: string, data: any): Promise<any> {
  const instance = getRazorpayInstance();
  // Based on razorpay API for stakeholder creation
  return await instance.stakeholders.create(accountId, data);
}

// The settlement.processed webhook only identifies the settlement, not which
// transfers it covers, so we look those up via the Transfers API.
export async function listTransfersForSettlement(settlementId: string): Promise<any[]> {
  const instance = getRazorpayInstance();
  const result = await instance.transfers.all({ recipient_settlement_id: settlementId });
  return result.items;
}

export async function requestProductConfig(accountId: string, data: any): Promise<any> {
  const instance = getRazorpayInstance();
  return await instance.products.requestProductConfiguration(accountId, data);
}

// Live status check used to self-heal onboarding_status when it's been sitting
// in a non-terminal state — Route KYC-status webhooks have proven unreliable
// to depend on alone (missed/mis-scoped Dashboard config, delivery timing).
export async function fetchProductStatus(accountId: string, productId: string): Promise<{ activationStatus: string }> {
  const instance = getRazorpayInstance();
  const product = await instance.products.fetch(accountId, productId);
  return { activationStatus: product.activation_status };
}

export async function updateProductConfig(accountId: string, productId: string, data: any): Promise<any> {
  const instance = getRazorpayInstance();
  return await instance.products.edit(accountId, productId, data);
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
