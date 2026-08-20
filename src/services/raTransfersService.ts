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

export type EarningsSummary = {
  totalPaise: number;
  thisMonthPaise: number;
  thisYearPaise: number;
  failedTransferCount: number;
};

export async function getEarningsSummary(raId: string): Promise<EarningsSummary> {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(amount_paise) FILTER (WHERE status = 'processed'), 0) AS total_paise,
       COALESCE(SUM(amount_paise) FILTER (
         WHERE status = 'processed'
           AND date_trunc('month', processed_at AT TIME ZONE 'Asia/Kolkata')
             = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
       ), 0) AS this_month_paise,
       COALESCE(SUM(amount_paise) FILTER (
         WHERE status = 'processed'
           AND date_trunc('year', processed_at AT TIME ZONE 'Asia/Kolkata')
             = date_trunc('year', now() AT TIME ZONE 'Asia/Kolkata')
       ), 0) AS this_year_paise,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed_transfer_count
     FROM ra_transfers
     WHERE ra_id = $1`,
    [raId]
  );
  const row = result.rows[0];
  return {
    totalPaise: Number(row.total_paise),
    thisMonthPaise: Number(row.this_month_paise),
    thisYearPaise: Number(row.this_year_paise),
    failedTransferCount: Number(row.failed_transfer_count),
  };
}

export type PayoutRow = {
  amountPaise: number;
  processedAt: string;
  callId: string;
  companyName: string;
  recommendation: string;
  settlementStatus: 'pending' | 'settled';
};

export async function getRecentPayouts(raId: string, limit: number): Promise<PayoutRow[]> {
  const result = await pool.query(
    `SELECT rt.amount_paise, rt.processed_at, rt.call_id, rc.company_name, rc.recommendation, rt.settlement_status
     FROM ra_transfers rt
     JOIN research_calls rc ON rc.id = rt.call_id
     WHERE rt.ra_id = $1 AND rt.status = 'processed' AND rt.processed_at IS NOT NULL
     ORDER BY rt.processed_at DESC
     LIMIT $2`,
    [raId, limit]
  );
  return result.rows.map((row) => ({
    amountPaise: Number(row.amount_paise),
    processedAt: row.processed_at.toISOString(),
    callId: row.call_id,
    companyName: row.company_name,
    recommendation: row.recommendation,
    settlementStatus: row.settlement_status,
  }));
}

// Marks every ra_transfers row behind this settlement as settled. Transfer
// IDs come from the Transfers API (see listTransfersForSettlement) since the
// settlement.processed webhook payload doesn't list them itself. A transfer
// ID with no matching row (e.g. not ours, or the transfer.processed webhook
// hasn't landed yet) is silently skipped rather than treated as an error.
export async function recordTransfersSettled(
  transferIds: string[],
  settlementId: string,
  settledAtEpochSeconds: number,
  utr: string | null
): Promise<void> {
  if (transferIds.length === 0) return;
  await pool.query(
    `UPDATE ra_transfers
     SET settlement_status = 'settled',
         razorpay_settlement_id = $2,
         razorpay_settlement_utr = $3,
         settled_at = to_timestamp($4),
         updated_at = now()
     WHERE razorpay_transfer_id = ANY($1) AND status = 'processed'`,
    [transferIds, settlementId, utr, settledAtEpochSeconds]
  );
}

export type CallEarningsRow = {
  callId: string;
  companyName: string;
  recommendation: string;
  totalPaise: number;
  count: number;
};

export async function getEarningsByCall(raId: string): Promise<CallEarningsRow[]> {
  const result = await pool.query(
    `SELECT rt.call_id, rc.company_name, rc.recommendation, SUM(rt.amount_paise) AS total_paise, COUNT(*) AS count
     FROM ra_transfers rt
     JOIN research_calls rc ON rc.id = rt.call_id
     WHERE rt.ra_id = $1 AND rt.status = 'processed'
     GROUP BY rt.call_id, rc.company_name, rc.recommendation
     ORDER BY total_paise DESC`,
    [raId]
  );
  return result.rows.map((row) => ({
    callId: row.call_id,
    companyName: row.company_name,
    recommendation: row.recommendation,
    totalPaise: Number(row.total_paise),
    count: Number(row.count),
  }));
}
