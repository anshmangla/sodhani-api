import { pool } from '../db/pool';

export type CompletePurchaseParams = {
  orderId: string;
  paymentId: string;
  signature: string;
  source: 'client' | 'webhook'; // used only for a console.log tag, no logic branches on it
};

export async function completePurchase(
  params: CompletePurchaseParams
): Promise<{ alreadyProcessed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const paymentResult = await client.query(
      'SELECT * FROM payments WHERE razorpay_order_id = $1 FOR UPDATE',
      [params.orderId]
    );
    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`No payment row found for order ${params.orderId}`);
    }
    const payment = paymentResult.rows[0];

    if (payment.status === 'paid') {
      await client.query('COMMIT');
      return { alreadyProcessed: true };
    }

    await client.query(
      `UPDATE payments SET status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = now() WHERE id = $3`,
      [params.paymentId, params.signature, payment.id]
    );

    const purchaseInsert = await client.query(
      `INSERT INTO purchased_calls (user_id, call_id, payment_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, call_id) DO NOTHING
       RETURNING id`,
      [payment.user_id, payment.call_id, payment.id]
    );

    if ((purchaseInsert.rowCount ?? 0) === 1) {
      await client.query(
        `UPDATE research_analysts SET total_sales = total_sales + 1
         WHERE id = (SELECT ra_id FROM research_calls WHERE id = $1)`,
        [payment.call_id]
      );
    }

    await client.query('COMMIT');
    console.log(`[purchase] completed order=${params.orderId} source=${params.source}`);
    return { alreadyProcessed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
