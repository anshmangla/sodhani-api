import { pool } from '../db/pool';

export type TransferProcessedEvent = {
  transferId: string;
  orderId: string;
  amountPaise: number;
  processedAtEpochSeconds: number;
};

export type TransferFailedEvent = {
  transferId: string;
  orderId: string;
  amountPaise: number;
  errorDescription: string | null;
};

export async function recordTransferProcessed(event: TransferProcessedEvent): Promise<void> {
  const result = await pool.query(
    `WITH pay AS (
       SELECT p.id AS payment_id, p.call_id, rc.ra_id
       FROM payments p
       JOIN research_calls rc ON rc.id = p.call_id
       WHERE p.razorpay_order_id = $1
     )
     INSERT INTO ra_transfers (ra_id, payment_id, call_id, razorpay_transfer_id, amount_paise, status, processed_at)
     SELECT ra_id, payment_id, call_id, $2, $3, 'processed', to_timestamp($4)
     FROM pay
     ON CONFLICT (razorpay_transfer_id) DO UPDATE
       SET status = 'processed',
           amount_paise = EXCLUDED.amount_paise,
           processed_at = EXCLUDED.processed_at,
           error_description = NULL,
           updated_at = now()`,
    [event.orderId, event.transferId, event.amountPaise, event.processedAtEpochSeconds]
  );
  if (result.rowCount === 0) {
    throw new Error(`No payment found for order ${event.orderId}`);
  }
}

export async function recordTransferFailed(event: TransferFailedEvent): Promise<void> {
  const result = await pool.query(
    `WITH pay AS (
       SELECT p.id AS payment_id, p.call_id, rc.ra_id
       FROM payments p
       JOIN research_calls rc ON rc.id = p.call_id
       WHERE p.razorpay_order_id = $1
     )
     INSERT INTO ra_transfers (ra_id, payment_id, call_id, razorpay_transfer_id, amount_paise, status, error_description, processed_at)
     SELECT ra_id, payment_id, call_id, $2, $3, 'failed', $4, NULL
     FROM pay
     ON CONFLICT (razorpay_transfer_id) DO UPDATE
       SET status = 'failed',
           amount_paise = EXCLUDED.amount_paise,
           error_description = EXCLUDED.error_description,
           processed_at = NULL,
           updated_at = now()`,
    [event.orderId, event.transferId, event.amountPaise, event.errorDescription]
  );
  if (result.rowCount === 0) {
    throw new Error(`No payment found for order ${event.orderId}`);
  }
}
