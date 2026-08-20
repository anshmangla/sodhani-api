# RA Earnings & Settlements Dashboard Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an RA see their Razorpay Route earnings (this month/year/total), recent payouts, and a per-call breakdown on their own dashboard, with failed transfers correctly excluded and visibly flagged rather than silently overstating earnings.

**Architecture:** A new `ra_transfers` table is the source of truth, populated by fixing the currently-stubbed `transfer.processed`/`transfer.failed` webhook handlers in `paymentsWebhook.ts`. A new `raTransfersService.ts` owns all reads/writes to that table. A new `GET /api/ra/dashboard/earnings` route (in `raCalls.ts`) exposes aggregated data to a new `EarningsSection.tsx` component rendered inside the existing `ra-web` dashboard page.

**Tech Stack:** Express + `pg` (raw SQL, no ORM) on the backend (`sodhani-api`); React + Vite + Tailwind on the frontend (`ra-web`). Neither repo has an automated test framework installed — this codebase's own convention (see `scripts/seed-sample-data.ts`) is ad-hoc `ts-node` verification scripts against a real dev database, not Jest/Vitest. This plan follows that convention rather than introducing a new one.

**Spec:** `sodhani-api/docs/superpowers/specs/2026-08-20-ra-earnings-settlements-design.md`

## Global Constraints

- Earnings count **transferred-to-Route-account** amounts only (not bank-settlement status) — per spec.
- No historical backfill — the ledger starts accruing from the first `transfer.processed`/`transfer.failed` webhook received after this ships.
- Month/year bucketing uses the `Asia/Kolkata` timezone.
- `amount_paise` stored is the webhook's `entity.amount` verbatim (gross of Razorpay's own Route fee) — see spec's "Assumption: gross vs net amount".
- The failed-transfer signal exposed to the RA is a **count only** — never raw Razorpay error text or per-failure amounts, to avoid leaking internal error codes.
- Follow existing per-file `asyncHandler` and route patterns already used in `raCalls.ts` / `paymentsWebhook.ts` — do not introduce a shared middleware/error-handling abstraction as part of this feature.
- No new test framework or dependency — verification is via `ts-node` scripts (matching `scripts/seed-sample-data.ts`) and manual browser checks.

---

### Task 1: `ra_transfers` migration + docs

**Files:**
- Create: `sodhani-api/db/migrations/0005_ra_transfers.sql`
- Modify: `sodhani-api/README.md:114-116` (add migration to the local-dev setup list)

**Interfaces:**
- Produces: the `ra_transfers` table with columns `id, ra_id, payment_id, call_id, razorpay_transfer_id, amount_paise, status, error_description, processed_at, created_at, updated_at`, a unique index on `razorpay_transfer_id`, and an index on `(ra_id, processed_at DESC)`. All later tasks depend on this exact shape.

- [ ] **Step 1: Write the migration**

Create `sodhani-api/db/migrations/0005_ra_transfers.sql`:

```sql
-- One row per Razorpay Route transfer attempt (success or failure) to an
-- RA's linked account. Fed exclusively by the transfer.processed /
-- transfer.failed webhook handlers in paymentsWebhook.ts — see
-- docs/superpowers/specs/2026-08-20-ra-earnings-settlements-design.md.
CREATE TABLE IF NOT EXISTS ra_transfers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ra_id                 UUID NOT NULL REFERENCES research_analysts(id),
  payment_id            UUID NOT NULL REFERENCES payments(id),
  call_id               UUID NOT NULL REFERENCES research_calls(id),
  razorpay_transfer_id  TEXT NOT NULL,
  amount_paise          INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('processed', 'failed')),
  error_description     TEXT,
  processed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ra_transfers_transfer_id
  ON ra_transfers (razorpay_transfer_id);
CREATE INDEX IF NOT EXISTS idx_ra_transfers_ra_id_processed_at
  ON ra_transfers (ra_id, processed_at DESC);
```

- [ ] **Step 2: Apply the migration to your local dev database**

Run: `psql "$DATABASE_URL" -f db/migrations/0005_ra_transfers.sql` (from `sodhani-api/`)
Expected: `CREATE TABLE`, `CREATE INDEX`, `CREATE INDEX` printed, no errors.

- [ ] **Step 3: Verify the table shape**

Run: `psql "$DATABASE_URL" -c "\d ra_transfers"`
Expected: output lists all 10 columns with the types above, plus the two indexes.

- [ ] **Step 4: Update the README's local-dev migration list**

In `sodhani-api/README.md`, find this block (around line 114-116):

```
psql "$DATABASE_URL" -f db/migrations/0001_create_users.sql          # creates the users table
psql "$DATABASE_URL" -f db/migrations/0002_research_analysts.sql     # creates the research_analysts table
psql "$DATABASE_URL" -f db/migrations/0003_research_calls.sql        # creates research_calls, call_comments, payments, purchased_calls
```

Add a new line immediately after it:

```
psql "$DATABASE_URL" -f db/migrations/0005_ra_transfers.sql          # creates ra_transfers (RA payout ledger)
```

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0005_ra_transfers.sql README.md
git commit -m "Add ra_transfers table for tracking RA payout transfers"
```

---

### Task 2: `raTransfersService` write path (`recordTransferProcessed` / `recordTransferFailed`)

**Files:**
- Create: `sodhani-api/src/services/raTransfersService.ts`
- Create: `sodhani-api/scripts/verify-ra-transfers.ts`
- Modify: `sodhani-api/package.json` (add a `verify:ra-transfers` script, mirroring the existing `seed:calls` entry)

**Interfaces:**
- Consumes: `pool` from `../db/pool` (existing).
- Produces (used by Task 3's webhook wiring and Task 4's read functions in the same file):
  ```ts
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
  export async function recordTransferProcessed(event: TransferProcessedEvent): Promise<void>;
  export async function recordTransferFailed(event: TransferFailedEvent): Promise<void>;
  ```
  Both throw `Error('No payment found for order ' + event.orderId)` when `orderId` doesn't match any `payments.razorpay_order_id` — callers (Task 3) catch this and log rather than crash the webhook handler.

- [ ] **Step 1: Write the verification script (fails — service doesn't exist yet)**

Create `sodhani-api/scripts/verify-ra-transfers.ts`:

```ts
import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../src/db/pool';
import { recordTransferProcessed, recordTransferFailed } from '../src/services/raTransfersService';

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
```

- [ ] **Step 2: Run it to confirm it fails (service doesn't exist yet)**

Run: `npx ts-node scripts/verify-ra-transfers.ts` (from `sodhani-api/`)
Expected: fails immediately with a TypeScript/module error — `Cannot find module '../src/services/raTransfersService'`.

- [ ] **Step 3: Implement `raTransfersService.ts` write functions**

Create `sodhani-api/src/services/raTransfersService.ts`:

```ts
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
```

- [ ] **Step 4: Run the verification script again to confirm it passes**

Run: `npx ts-node scripts/verify-ra-transfers.ts` (from `sodhani-api/`)
Expected: every line prints `PASS: ...`, ending with `All assertions passed.` and exit code 0.

- [ ] **Step 5: Add the npm script**

In `sodhani-api/package.json`, in `"scripts"`, add a line after `"seed:calls"`:

```json
"verify:ra-transfers": "ts-node scripts/verify-ra-transfers.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/services/raTransfersService.ts scripts/verify-ra-transfers.ts package.json
git commit -m "Add raTransfersService write path for recording Route transfer outcomes"
```

---

### Task 3: Wire the write path into the webhook handlers

**Files:**
- Modify: `sodhani-api/src/routes/paymentsWebhook.ts:48-60`
- Create: `sodhani-api/scripts/simulate-transfer-webhook.ts`

**Interfaces:**
- Consumes: `recordTransferProcessed`, `recordTransferFailed` from `../services/raTransfersService` (Task 2).

- [ ] **Step 1: Replace the stubbed webhook handlers**

In `sodhani-api/src/routes/paymentsWebhook.ts`, replace lines 48-60:

```ts
  if (event.event === 'transfer.processed') {
    console.log('[payments/webhook] Transfer processed:', event.payload.transfer.entity.id);
    res.status(200).json({ received: true });
    return;
  }

  if (event.event === 'transfer.failed') {
    console.error('[payments/webhook] TRANSFER FAILED:', event.payload.transfer.entity.id);
    // Ideally you would insert this into a failed_transfers audit table or trigger an email.
    // For now, logging it clearly so ops can manually retry or notify the RA.
    res.status(200).json({ received: true });
    return;
  }
```

with:

```ts
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
```

And add the import at the top of the file, alongside the existing imports:

```ts
import { recordTransferProcessed, recordTransferFailed } from '../services/raTransfersService';
```

- [ ] **Step 2: Write a webhook simulation script**

Create `sodhani-api/scripts/simulate-transfer-webhook.ts`:

```ts
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
```

- [ ] **Step 3: Manually verify against a running server**

In one terminal (from `sodhani-api/`): `npm run dev`

In another terminal, create a throwaway fixture payment to target:

```bash
psql "$DATABASE_URL" -c "
INSERT INTO users (name, phone_number) VALUES ('Webhook Sim Fixture', 'webhook-sim-fixture') RETURNING id;
"
```
Note the returned user id, then (substituting `<user_id>`):
```bash
psql "$DATABASE_URL" -c "
INSERT INTO research_analysts (email, password_hash, full_name) VALUES ('webhook-sim@example.invalid', 'x', 'Webhook Sim RA') RETURNING id;
"
```
Note the returned RA id, then (substituting `<ra_id>`):
```bash
psql "$DATABASE_URL" -c "
INSERT INTO research_calls (ra_id, scrip_code, company_name, recommendation, target_price) VALUES ('<ra_id>', '000001', 'Webhook Sim Co.', 'Buy', 100) RETURNING id;
"
```
Note the returned call id, then (substituting `<call_id>` and `<user_id>`):
```bash
psql "$DATABASE_URL" -c "
INSERT INTO payments (user_id, call_id, razorpay_order_id, amount_paise, status) VALUES ('<user_id>', '<call_id>', 'order_webhook_sim_1', 5000, 'paid');
"
```

Then run:
```bash
npx ts-node scripts/simulate-transfer-webhook.ts processed order_webhook_sim_1 trf_webhook_sim_1 4500
```
Expected: `Response status: 200`, and the dev server's console logs `[payments/webhook] Transfer processed: trf_webhook_sim_1`.

Confirm the row landed: `psql "$DATABASE_URL" -c "SELECT status, amount_paise FROM ra_transfers WHERE razorpay_transfer_id = 'trf_webhook_sim_1'"`
Expected: one row, `status = processed`, `amount_paise = 4500`.

Clean up the fixture data (substituting the ids noted above):
```bash
psql "$DATABASE_URL" -c "
DELETE FROM ra_transfers WHERE razorpay_transfer_id = 'trf_webhook_sim_1';
DELETE FROM payments WHERE razorpay_order_id = 'order_webhook_sim_1';
DELETE FROM research_calls WHERE id = '<call_id>';
DELETE FROM research_analysts WHERE id = '<ra_id>';
DELETE FROM users WHERE id = '<user_id>';
"
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/paymentsWebhook.ts scripts/simulate-transfer-webhook.ts
git commit -m "Wire transfer.processed/transfer.failed webhooks into raTransfersService"
```

---

### Task 4: `raTransfersService` read path (earnings aggregation)

**Files:**
- Modify: `sodhani-api/src/services/raTransfersService.ts`
- Modify: `sodhani-api/scripts/verify-ra-transfers.ts`

**Interfaces:**
- Produces (used by Task 5's route):
  ```ts
  export type EarningsSummary = {
    totalPaise: number;
    thisMonthPaise: number;
    thisYearPaise: number;
    failedTransferCount: number;
  };
  export type PayoutRow = {
    amountPaise: number;
    processedAt: string;
    callId: string;
    companyName: string;
    recommendation: string;
  };
  export type CallEarningsRow = {
    callId: string;
    companyName: string;
    recommendation: string;
    totalPaise: number;
    count: number;
  };
  export async function getEarningsSummary(raId: string): Promise<EarningsSummary>;
  export async function getRecentPayouts(raId: string, limit: number): Promise<PayoutRow[]>;
  export async function getEarningsByCall(raId: string): Promise<CallEarningsRow[]>;
  ```

- [ ] **Step 1: Extend the verification script with read-path assertions (fails — functions don't exist yet)**

In `sodhani-api/scripts/verify-ra-transfers.ts`, change the import line:

```ts
import { recordTransferProcessed, recordTransferFailed } from '../src/services/raTransfersService';
```

to:

```ts
import {
  recordTransferProcessed,
  recordTransferFailed,
  getEarningsSummary,
  getRecentPayouts,
  getEarningsByCall,
} from '../src/services/raTransfersService';
```

Then insert the following block into the `try { ... }` in `main()`, immediately before the `// 4. An orderId with no matching payment throws` comment:

```ts
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
    assert(payouts.every((p) => p.companyName === 'Verify Fixture Co.'), 'payout companyName is joined from research_calls');
    assert(
      payouts.some((p) => p.amountPaise === 4600) && payouts.some((p) => p.amountPaise === 7000),
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

```

- [ ] **Step 2: Run it to confirm the new assertions fail**

Run: `npx ts-node scripts/verify-ra-transfers.ts` (from `sodhani-api/`)
Expected: fails with `getEarningsSummary is not a function` (or a TypeScript compile error naming the missing export).

- [ ] **Step 3: Implement the read functions**

Append to `sodhani-api/src/services/raTransfersService.ts`:

```ts
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
};

export async function getRecentPayouts(raId: string, limit: number): Promise<PayoutRow[]> {
  const result = await pool.query(
    `SELECT rt.amount_paise, rt.processed_at, rt.call_id, rc.company_name, rc.recommendation
     FROM ra_transfers rt
     JOIN research_calls rc ON rc.id = rt.call_id
     WHERE rt.ra_id = $1 AND rt.status = 'processed'
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
  }));
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
```

- [ ] **Step 4: Run the verification script again to confirm everything passes**

Run: `npx ts-node scripts/verify-ra-transfers.ts` (from `sodhani-api/`)
Expected: all `PASS:` lines, `All assertions passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/services/raTransfersService.ts scripts/verify-ra-transfers.ts
git commit -m "Add earnings aggregation read functions to raTransfersService"
```

---

### Task 5: `GET /api/ra/dashboard/earnings` route

**Files:**
- Modify: `sodhani-api/src/routes/raCalls.ts` (add route after the existing `/dashboard` route, currently ending at line 132)
- Modify: `sodhani-api/README.md` (document the new endpoint, near the existing `GET /api/ra/dashboard` doc around line 872-880)

**Interfaces:**
- Consumes: `getEarningsSummary`, `getRecentPayouts`, `getEarningsByCall` from `../services/raTransfersService` (Task 4).
- Produces: `GET /api/ra/dashboard/earnings` response shape consumed by Task 6's frontend:
  ```json
  {
    "earnings": { "total_paise": 0, "this_month_paise": 0, "this_year_paise": 0, "failed_transfer_count": 0 },
    "recent_payouts": [{ "amount_paise": 0, "processed_at": "...", "call_id": "...", "company_name": "...", "recommendation": "Buy" }],
    "by_call": [{ "call_id": "...", "company_name": "...", "recommendation": "Buy", "total_paise": 0, "count": 0 }]
  }
  ```

- [ ] **Step 1: Add the route**

In `sodhani-api/src/routes/raCalls.ts`, add this import alongside the existing ones at the top of the file:

```ts
import { getEarningsSummary, getRecentPayouts, getEarningsByCall } from '../services/raTransfersService';
```

Then add this route immediately after the existing `GET /dashboard` route (after line 132, `}));`):

```ts
// GET /api/ra/dashboard/earnings
router.get('/dashboard/earnings', requireRaAuth, asyncHandler(async (req, res) => {
  const raId = req.authRaId as string;
  const [summary, recentPayouts, byCall] = await Promise.all([
    getEarningsSummary(raId),
    getRecentPayouts(raId, 20),
    getEarningsByCall(raId),
  ]);
  res.status(200).json({
    earnings: {
      total_paise: summary.totalPaise,
      this_month_paise: summary.thisMonthPaise,
      this_year_paise: summary.thisYearPaise,
      failed_transfer_count: summary.failedTransferCount,
    },
    recent_payouts: recentPayouts.map((p) => ({
      amount_paise: p.amountPaise,
      processed_at: p.processedAt,
      call_id: p.callId,
      company_name: p.companyName,
      recommendation: p.recommendation,
    })),
    by_call: byCall.map((c) => ({
      call_id: c.callId,
      company_name: c.companyName,
      recommendation: c.recommendation,
      total_paise: c.totalPaise,
      count: c.count,
    })),
  });
}));
```

- [ ] **Step 2: Verify with curl against a running server and a real RA login**

In one terminal: `npm run dev` (from `sodhani-api/`)

In another terminal, log in as any existing dev RA (see `scripts/seed-research-analysts.ts` for seeded credentials, or sign up a fresh one via `ra-web`) to get a token:
```bash
curl -s -X POST http://localhost:4000/api/ra/login -H "Content-Type: application/json" -d '{"email":"<ra_email>","password":"<ra_password>"}'
```
Copy the `token` from the response, then:
```bash
curl -s http://localhost:4000/api/ra/dashboard/earnings -H "Authorization: Bearer <token>"
```
Expected: `200` with the JSON shape above — zeros/empty arrays are fine if this RA has no `ra_transfers` rows yet.

- [ ] **Step 3: Document the endpoint in the README**

In `sodhani-api/README.md`, immediately after the existing `GET /api/ra/dashboard` section (around line 872-881):

```
#### `GET /api/ra/dashboard`

Summary stats for the authenticated RA.

**Response** `200`
```json
{ "dashboard": { "total_calls": 12, "total_paid_calls": 5, "total_sales": 47 } }
```

---
```

add a new section:

```
#### `GET /api/ra/dashboard/earnings`

Route transfer earnings for the authenticated RA — money transferred to
their Razorpay linked account (not settlement-to-bank status). Sourced from
the `ra_transfers` table, populated by the `transfer.processed` /
`transfer.failed` webhook handlers in `paymentsWebhook.ts`. No historical
backfill — only reflects transfers received after this feature shipped.

**Response** `200`
```json
{
  "earnings": { "total_paise": 45000, "this_month_paise": 9000, "this_year_paise": 45000, "failed_transfer_count": 1 },
  "recent_payouts": [
    { "amount_paise": 4500, "processed_at": "2026-08-15T10:00:00.000Z", "call_id": "...", "company_name": "Reliance Industries Ltd.", "recommendation": "Buy" }
  ],
  "by_call": [
    { "call_id": "...", "company_name": "Reliance Industries Ltd.", "recommendation": "Buy", "total_paise": 9000, "count": 2 }
  ]
}
```

---
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/raCalls.ts README.md
git commit -m "Add GET /api/ra/dashboard/earnings endpoint"
```

---

### Task 6: Frontend `EarningsSection` component

**Files:**
- Create: `ra-web/src/components/EarningsSection.tsx`
- Modify: `ra-web/src/pages/DashboardPage.tsx:60-76`

**Interfaces:**
- Consumes: `GET /api/ra/dashboard/earnings` (Task 5's exact response shape) and `API_BASE_URL` from `../config`.
- Produces: `export default function EarningsSection(): JSX.Element`, rendered with no props (it fetches its own data using the token in `localStorage`, matching the existing pattern in `DashboardPage.tsx`).

- [ ] **Step 1: Write the component**

Create `ra-web/src/components/EarningsSection.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config';

type Earnings = {
  total_paise: number;
  this_month_paise: number;
  this_year_paise: number;
  failed_transfer_count: number;
};

type Payout = {
  amount_paise: number;
  processed_at: string;
  call_id: string;
  company_name: string;
  recommendation: string;
};

type CallEarnings = {
  call_id: string;
  company_name: string;
  recommendation: string;
  total_paise: number;
  count: number;
};

type EarningsResponse = {
  earnings: Earnings;
  recent_payouts: Payout[];
  by_call: CallEarnings[];
};

const formatRupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);

export default function EarningsSection() {
  const [data, setData] = useState<EarningsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchEarnings = async () => {
      const token = localStorage.getItem('ra_token');
      if (!token) return;
      try {
        const res = await fetch(`${API_BASE_URL}/api/ra/dashboard/earnings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to load earnings');
        setData(await res.json());
      } catch (err) {
        setError('Could not load your earnings right now.');
      } finally {
        setLoading(false);
      }
    };
    fetchEarnings();
  }, []);

  if (loading) return <div className="bg-white p-6 shadow rounded">Loading earnings...</div>;
  if (error || !data) return <div className="bg-white p-6 shadow rounded text-red-600">{error || 'No earnings data.'}</div>;

  return (
    <div className="col-span-1 md:col-span-2 space-y-6">
      {data.earnings.failed_transfer_count > 0 && (
        <div className="bg-amber-50 border border-amber-300 text-amber-800 p-4 rounded">
          {data.earnings.failed_transfer_count} payout{data.earnings.failed_transfer_count > 1 ? 's' : ''} failed to reach your account. Contact support.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 shadow rounded">
          <h3 className="text-sm text-gray-500 mb-1">This Month</h3>
          <p className="text-2xl font-bold">{formatRupees(data.earnings.this_month_paise)}</p>
        </div>
        <div className="bg-white p-6 shadow rounded">
          <h3 className="text-sm text-gray-500 mb-1">This Year</h3>
          <p className="text-2xl font-bold">{formatRupees(data.earnings.this_year_paise)}</p>
        </div>
        <div className="bg-white p-6 shadow rounded">
          <h3 className="text-sm text-gray-500 mb-1">Total</h3>
          <p className="text-2xl font-bold">{formatRupees(data.earnings.total_paise)}</p>
        </div>
      </div>

      <div className="bg-white p-6 shadow rounded">
        <h3 className="text-lg font-semibold mb-4">Recent Payouts</h3>
        {data.recent_payouts.length === 0 ? (
          <p className="text-gray-500 text-sm">No payouts yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2">Date</th>
                <th className="pb-2">Call</th>
                <th className="pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_payouts.map((p, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2">{new Date(p.processed_at).toLocaleDateString('en-IN')}</td>
                  <td className="py-2">{p.company_name} ({p.recommendation})</td>
                  <td className="py-2 text-right">{formatRupees(p.amount_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white p-6 shadow rounded">
        <h3 className="text-lg font-semibold mb-4">Earnings by Call</h3>
        {data.by_call.length === 0 ? (
          <p className="text-gray-500 text-sm">No paid calls yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2">Call</th>
                <th className="pb-2 text-right">Sales</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.by_call.map((c) => (
                <tr key={c.call_id} className="border-b last:border-0">
                  <td className="py-2">{c.company_name} ({c.recommendation})</td>
                  <td className="py-2 text-right">{c.count}</td>
                  <td className="py-2 text-right">{formatRupees(c.total_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate into `DashboardPage.tsx`**

In `ra-web/src/pages/DashboardPage.tsx`, add the import at the top:

```tsx
import EarningsSection from '../components/EarningsSection';
```

Replace the `<main>` block (lines 68-73):

```tsx
      <main className="grid gap-6 grid-cols-1 md:grid-cols-2">
        <div className="bg-white p-6 shadow rounded">
          <h2 className="text-xl font-semibold mb-4">Welcome</h2>
          <p>Your account is fully active and you can now accept payments via Razorpay.</p>
        </div>
      </main>
```

with:

```tsx
      <main className="grid gap-6 grid-cols-1 md:grid-cols-2">
        <div className="bg-white p-6 shadow rounded">
          <h2 className="text-xl font-semibold mb-4">Welcome</h2>
          <p>Your account is fully active and you can now accept payments via Razorpay.</p>
        </div>
        <EarningsSection />
      </main>
```

- [ ] **Step 3: Typecheck**

Run: `npm run build` (from `ra-web/`)
Expected: `tsc -b` and `vite build` both complete with no errors.

- [ ] **Step 4: Manual browser verification**

Run: `npm run dev` (from `ra-web/`, in one terminal) and `npm run dev` (from `sodhani-api/`, in another).

In a browser: log in as an RA with `onboarding_status` past `under_review`/`rejected` (e.g. an `active` seeded RA — see `scripts/seed-research-analysts.ts`), navigate to `/dashboard`.
Expected: the Earnings section renders with ₹0 tiles and "No payouts yet." / "No paid calls yet." for an RA with no `ra_transfers` rows.

Then, using Task 3's `simulate-transfer-webhook.ts` against a real payment for that RA, produce a `processed` transfer and reload the page.
Expected: the stat tiles update, the payout appears in "Recent Payouts" and "Earnings by Call". Then simulate a `failed` transfer for a second payment and reload.
Expected: the amber failed-transfer banner appears, and the failed amount is excluded from all three totals.

- [ ] **Step 5: Commit**

```bash
git add src/components/EarningsSection.tsx src/pages/DashboardPage.tsx
git commit -m "Add Earnings & Settlements section to RA dashboard"
```

---

### Task 7: Final end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Re-run the backend verification script**

Run: `npx ts-node scripts/verify-ra-transfers.ts` (from `sodhani-api/`)
Expected: all assertions pass.

- [ ] **Step 2: Re-run the frontend build**

Run: `npm run build` (from `ra-web/`)
Expected: no errors.

- [ ] **Step 3: Full manual flow**

With both dev servers running, exercise the real purchase flow once end-to-end if a Razorpay test-mode account is available: sign up a fresh RA, complete onboarding (linked account + stakeholder + product config against Razorpay test mode), have a test buyer purchase one of that RA's paid calls, and confirm Razorpay's real `transfer.processed` webhook (not the simulation script) lands and the dashboard reflects it correctly. If a Razorpay test-mode account/webhook tunnel (e.g. ngrok) isn't available in this environment, `simulate-transfer-webhook.ts` from Task 3 plus the manual browser check from Task 6 is the accepted substitute — note explicitly in your final report which of the two was actually performed, rather than implying full production-webhook coverage.

- [ ] **Step 4: Opus review pass**

Dispatch a review of the full diff (all 6 preceding tasks) using an Opus-backed agent before considering this feature done, per the user's request to have Opus verify the implementation. Focus areas to ask it to check: SQL correctness (upsert idempotency, IST bucketing, join correctness), the webhook payload field assumptions (`entity.source` = order id, `entity.processed_at` may be `null`), and that no raw Razorpay error text reaches the frontend.
