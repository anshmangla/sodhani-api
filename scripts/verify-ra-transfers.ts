import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../src/db/pool';
import {
  recordTransferProcessed,
  recordTransferFailed,
  getEarningsSummary,
  getRecentPayouts,
  getEarningsByCall,
} from '../src/services/raTransfersService';

// Ad-hoc verification script for raTransfersService, following this repo's
// existing convention (see scripts/seed-sample-data.ts) of exercising real
// SQL against a real dev database rather than a mocked test framework.
// Inserts throwaway fixture rows, asserts behavior, always cleans up.

const ORDER_1 = 'order_verify_ra_transfers_1';
const ORDER_2 = 'order_verify_ra_transfers_2';
const ORDER_3 = 'order_verify_ra_transfers_3'; // used starting Task 4, for the month/year-boundary assertion
const EMAIL = 'verify-ra-transfers@example.invalid';
const PHONE = 'verify-ra-transfers-fixture';

let failures = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function main() {
  const userResult = await pool.query(
    `INSERT INTO users (name, phone_number) VALUES ('Verify Fixture', $1) RETURNING id`,
    [PHONE]
  );
  const userId = userResult.rows[0].id;

  const raResult = await pool.query(
    `INSERT INTO research_analysts (email, password_hash, full_name)
     VALUES ($1, 'x', 'Verify Fixture RA') RETURNING id`,
    [EMAIL]
  );
  const raId = raResult.rows[0].id;

  const callResult = await pool.query(
    `INSERT INTO research_calls (ra_id, scrip_code, company_name, recommendation, target_price)
     VALUES ($1, '000000', 'Verify Fixture Co.', 'Buy', 100) RETURNING id`,
    [raId]
  );
  const callId = callResult.rows[0].id;

  const payment1 = await pool.query(
    `INSERT INTO payments (user_id, call_id, razorpay_order_id, amount_paise, status)
     VALUES ($1, $2, $3, 5000, 'paid') RETURNING id`,
    [userId, callId, ORDER_1]
  );
  const paymentId1 = payment1.rows[0].id;

  const payment2 = await pool.query(
    `INSERT INTO payments (user_id, call_id, razorpay_order_id, amount_paise, status)
     VALUES ($1, $2, $3, 5000, 'paid') RETURNING id`,
    [userId, callId, ORDER_2]
  );
  const paymentId2 = payment2.rows[0].id;

  const payment3 = await pool.query(
    `INSERT INTO payments (user_id, call_id, razorpay_order_id, amount_paise, status)
     VALUES ($1, $2, $3, 5000, 'paid') RETURNING id`,
    [userId, callId, ORDER_3]
  );
  const paymentId3 = payment3.rows[0].id;

  try {
    // 1. recordTransferProcessed writes a row matched to the right RA/payment/call.
    await recordTransferProcessed({
      transferId: 'trf_verify_1',
      orderId: ORDER_1,
      amountPaise: 4500,
      processedAtEpochSeconds: Math.floor(Date.now() / 1000),
    });
    let row = (await pool.query(`SELECT * FROM ra_transfers WHERE razorpay_transfer_id = 'trf_verify_1'`)).rows[0];
    assert(!!row, 'recordTransferProcessed inserted a row');
    assert(row?.status === 'processed', 'row status is processed');
    assert(row?.amount_paise === 4500, 'row amount_paise is 4500');
    assert(row?.ra_id === raId, 'row ra_id matches fixture RA');
    assert(row?.payment_id === paymentId1, 'row payment_id matches fixture payment');
    assert(row?.call_id === callId, 'row call_id matches fixture call');

    // 2. Re-processing the same transfer_id upserts in place (idempotent), not a duplicate row.
    await recordTransferProcessed({
      transferId: 'trf_verify_1',
      orderId: ORDER_1,
      amountPaise: 4600,
      processedAtEpochSeconds: Math.floor(Date.now() / 1000),
    });
    const rows = (await pool.query(`SELECT * FROM ra_transfers WHERE razorpay_transfer_id = 'trf_verify_1'`)).rows;
    assert(rows.length === 1, 'retrying transfer.processed does not create a duplicate row');
    assert(rows[0].amount_paise === 4600, 'retried row reflects the latest amount');

    // 3. recordTransferFailed writes a failed row with no processed_at.
    await recordTransferFailed({
      transferId: 'trf_verify_2',
      orderId: ORDER_2,
      amountPaise: 3000,
      errorDescription: 'Insufficient balance',
    });
    row = (await pool.query(`SELECT * FROM ra_transfers WHERE razorpay_transfer_id = 'trf_verify_2'`)).rows[0];
    assert(row?.status === 'failed', 'failed row has status failed');
    assert(row?.error_description === 'Insufficient balance', 'failed row stores the error description');
    assert(row?.processed_at === null, 'failed row has no processed_at');

    // 4. A transfer processed well outside this month/year counts toward the
    // lifetime total but must NOT leak into this_month/this_year — this is the
    // one assertion that would catch a month/year filter that's accidentally
    // always-true (e.g. a bad date_trunc comparison), which a same-day-only
    // fixture could never catch.
    const fourHundredDaysAgo = Math.floor(Date.now() / 1000) - 400 * 24 * 3600;
    await recordTransferProcessed({
      transferId: 'trf_verify_old',
      orderId: ORDER_3,
      amountPaise: 7000,
      processedAtEpochSeconds: fourHundredDaysAgo,
    });

    const summary = await getEarningsSummary(raId);
    assert(summary.totalPaise === 4600 + 7000, `getEarningsSummary.totalPaise includes the old transfer (got ${summary.totalPaise})`);
    assert(summary.thisMonthPaise === 4600, `getEarningsSummary.thisMonthPaise excludes the old transfer (got ${summary.thisMonthPaise})`);
    assert(summary.thisYearPaise === 4600, `getEarningsSummary.thisYearPaise excludes the old transfer (got ${summary.thisYearPaise})`);
    assert(summary.failedTransferCount === 1, `getEarningsSummary.failedTransferCount is 1 (got ${summary.failedTransferCount})`);

    // 5. getRecentPayouts returns both processed transfers (not the failed one), with call details joined.
    const payouts = await getRecentPayouts(raId, 20);
    assert(payouts.length === 2, `getRecentPayouts returns exactly 2 rows (got ${payouts.length})`);
    assert(payouts.every((p: any) => p.companyName === 'Verify Fixture Co.'), 'payout companyName is joined from research_calls');
    assert(
      payouts.some((p: any) => p.amountPaise === 4600) && payouts.some((p: any) => p.amountPaise === 7000),
      'payouts include both the recent (4600) and old (7000) processed transfers'
    );

    // 6. getEarningsByCall groups both processed transfers under the fixture call (same call_id for all 3 fixture payments).
    const byCall = await getEarningsByCall(raId);
    assert(byCall.length === 1, `getEarningsByCall returns exactly 1 row (got ${byCall.length})`);
    assert(byCall[0]?.totalPaise === 4600 + 7000, `by-call totalPaise is 11600 (got ${byCall[0]?.totalPaise})`);
    assert(byCall[0]?.count === 2, `by-call count is 2 (got ${byCall[0]?.count})`);

    // 6b. A brand-new RA with no transfers gets zeros/empty arrays, not an error.
    const emptyRaResult = await pool.query(
      `INSERT INTO research_analysts (email, password_hash, full_name)
       VALUES ('verify-ra-transfers-empty@example.invalid', 'x', 'Empty Fixture RA') RETURNING id`
    );
    const emptyRaId = emptyRaResult.rows[0].id;
    try {
      const emptySummary = await getEarningsSummary(emptyRaId);
      assert(emptySummary.totalPaise === 0, 'empty RA totalPaise is 0');
      assert(emptySummary.failedTransferCount === 0, 'empty RA failedTransferCount is 0');
      const emptyPayouts = await getRecentPayouts(emptyRaId, 20);
      assert(emptyPayouts.length === 0, 'empty RA getRecentPayouts returns []');
      const emptyByCall = await getEarningsByCall(emptyRaId);
      assert(emptyByCall.length === 0, 'empty RA getEarningsByCall returns []');
    } finally {
      await pool.query('DELETE FROM research_analysts WHERE id = $1', [emptyRaId]);
    }

    // 7. An orderId with no matching payment throws, rather than silently no-op-ing.
    // (Numbered 7 here because Task 4 inserts read-path assertions 4-6 above this point.)
    let threw = false;
    try {
      await recordTransferProcessed({
        transferId: 'trf_verify_orphan',
        orderId: 'order_does_not_exist_xyz',
        amountPaise: 1000,
        processedAtEpochSeconds: Math.floor(Date.now() / 1000),
      });
    } catch {
      threw = true;
    }
    assert(threw, 'recordTransferProcessed throws for an unmatched order id');
  } finally {
    await pool.query(`DELETE FROM ra_transfers WHERE payment_id IN ($1, $2, $3)`, [paymentId1, paymentId2, paymentId3]);
    await pool.query(`DELETE FROM payments WHERE id IN ($1, $2, $3)`, [paymentId1, paymentId2, paymentId3]);
    await pool.query(`DELETE FROM research_calls WHERE id = $1`, [callId]);
    await pool.query(`DELETE FROM research_analysts WHERE id = $1`, [raId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  await pool.end();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll assertions passed.');
}

main().catch((err) => {
  console.error('Verification script crashed:', err);
  process.exit(1);
});
