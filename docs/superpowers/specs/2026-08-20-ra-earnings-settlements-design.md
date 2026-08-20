# RA Earnings & Settlements Dashboard Section — Design

Date: 2026-08-20
Status: Approved (pending implementation)

## Problem

Research Analysts (RAs) onboard onto Razorpay Route as linked accounts and
receive a 90% transfer on each paid call sale (`razorpayService.ts:41`), but
have no way to see how much they've earned. Razorpay's own Dashboard access
for a linked account is a manual, per-account toggle (not something this app
controls or that's set by API account creation) — see prior investigation in
this conversation. Rather than depend on that, the RA Dashboard in this app
(`ra-web`) will surface earnings directly, sourced from data this platform
already controls.

`paymentsWebhook.ts` currently receives `transfer.processed`,
`transfer.failed`, and `settlement.processed` events but only logs them —
none are persisted. This means a naive "sum what we think we paid out" query
would silently overstate an RA's earnings whenever a transfer actually fails
(insufficient Razorpay balance, etc.), since nothing currently records that
failure.

## Goals

- Show an RA, on their own dashboard, how much they've earned: this month,
  this year, and all-time.
- Reflect money **transferred to their Razorpay linked account** (not
  necessarily yet settled to their bank — Razorpay's settlement cycle for
  that is separate and out of scope here).
- Show a recent-payouts list and a per-call earnings breakdown.
- Surface a visible alert when a transfer has failed, rather than silently
  excluding it and leaving the RA confused about a lower-than-expected total.
- Do this without depending on the RA having Razorpay Dashboard access
  (which this app cannot grant via API — see prior investigation).

## Non-goals

- Settlement-to-bank tracking/display (the `settlement.processed` webhook
  stays log-only for now; only `transfer.processed`/`transfer.failed` are
  wired up).
- Historical backfill of transfers that occurred before this ships — explicitly
  confirmed out of scope. Earnings start accruing from ship date forward.
- Any change to the actual transfer/split logic in `razorpayService.ts` or
  `payments.ts` — this is read-only reporting on top of the existing flow.
- Retrying failed transfers automatically — the alert's call to action is
  "contact support," not automated retry.

## Data source decision

Three approaches were considered:

- **A — Local `ra_transfers` ledger fed by webhooks (chosen).** Fast reads
  (no external calls at dashboard-load time), correctly excludes failed
  transfers from earnings, supports the payout list and per-call breakdown
  from local data, and gives a durable audit trail.
- **B — Live Razorpay API calls per dashboard load.** Rejected: adds
  external-call latency to every dashboard view and still requires building
  month/year aggregation client-side since Razorpay doesn't provide it.
- **C — Naive `SUM` over `payments.amount_paise * 0.9`.** Rejected: this is
  the status-quo gap — it cannot distinguish a failed transfer from a
  successful one, so it would overstate earnings and cannot support the
  failed-transfer alert.

## Data model

New migration `0005_ra_transfers.sql`:

```sql
CREATE TABLE ra_transfers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ra_id                 UUID NOT NULL REFERENCES research_analysts(id),
  payment_id            UUID NOT NULL REFERENCES payments(id),
  call_id               UUID NOT NULL REFERENCES research_calls(id),
  razorpay_transfer_id  TEXT NOT NULL,
  amount_paise          INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('processed','failed')),
  error_description     TEXT,
  processed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ra_transfers_transfer_id ON ra_transfers (razorpay_transfer_id);
CREATE INDEX idx_ra_transfers_ra_id_processed_at ON ra_transfers (ra_id, processed_at DESC);
```

`call_id` is denormalized from `payments.call_id` onto this row specifically
so the per-call breakdown query needs no extra join.

`amount_paise` stores the transfer's `amount` field verbatim from the
Razorpay webhook payload — see "Assumption: gross vs net amount" below.

## Webhook handling changes

`sodhani-api/src/routes/paymentsWebhook.ts` currently has stub handlers for
`transfer.processed` (line 48) and `transfer.failed` (line 54) that only
log. These become:

**`transfer.processed`:**
1. Read `payload.transfer.entity.source` — this is the Razorpay **order ID**
   (confirmed against Razorpay's own webhook payload documentation), which
   matches `payments.razorpay_order_id` directly, since transfers in this
   codebase are set up via `options.transfers` at order-creation time
   (`razorpayService.ts:42-49`), not via a separate post-capture transfer call.
2. Look up the `payments` row by `razorpay_order_id`; resolve `ra_id` via
   `research_calls.ra_id` (through `payments.call_id`) and `payment_id`.
3. `INSERT ... ON CONFLICT (razorpay_transfer_id) DO UPDATE` into
   `ra_transfers` with `status='processed'`, `amount_paise = entity.amount`,
   `processed_at = to_timestamp(entity.processed_at)`. The upsert makes this
   safe against Razorpay's webhook retry behavior.
4. If no matching `payments` row is found, log and still ack `200` — don't
   throw, consistent with how `completePurchase` failures are already
   handled a few lines below in the same file.

**`transfer.failed`:** same lookup/upsert, `status='failed'`,
`error_description = payload.transfer.entity.error.description`.

`settlement.processed` remains log-only (non-goal, see above).

## API

New route `GET /api/ra/dashboard/earnings` in
`sodhani-api/src/routes/raCalls.ts`, alongside the existing `/dashboard`
route, behind `requireRaAuth`.

Response:

```json
{
  "earnings": {
    "total_paise": 45000,
    "this_month_paise": 9000,
    "this_year_paise": 45000,
    "failed_transfer_count": 1
  },
  "recent_payouts": [
    { "amount_paise": 4500, "processed_at": "2026-08-15T10:00:00Z", "call_id": "...", "company_name": "...", "recommendation": "Buy" }
  ],
  "by_call": [
    { "call_id": "...", "company_name": "...", "recommendation": "Buy", "total_paise": 9000, "count": 2 }
  ]
}
```

- Summary totals: bucketed in `Asia/Kolkata` (this is an Indian platform;
  Razorpay's own settlement cycles are IST-based), via
  `date_trunc('month'|'year', processed_at AT TIME ZONE 'Asia/Kolkata')`
  compared against the same expression for `now()`.
- `recent_payouts`: last 20 `status='processed'` rows ordered by
  `processed_at DESC`, joined to `research_calls` for display fields.
- `by_call`: `GROUP BY call_id` over `status='processed'` rows.
- `failed_transfer_count` only — not per-failure detail (no amounts, no raw
  Razorpay error text) — keeps the API from leaking internal error codes to
  the RA; the UI's call to action is "contact support," not a diagnostic
  dump.
- Must return zeros/empty arrays gracefully for an RA with no
  `ra_transfers` rows yet (e.g. brand new account), not an error.

## Frontend

New component `ra-web/src/components/EarningsSection.tsx`, rendered inside
`DashboardPage.tsx`'s existing `<main>` grid (`DashboardPage.tsx:68-73`),
gated by the same `onboarding_status` check already used there (not
rendered during `under_review`/`rejected`).

- Three stat tiles: **This Month**, **This Year**, **Total** — paise
  formatted as ₹ via `Intl.NumberFormat('en-IN')`.
- Amber warning banner when `failed_transfer_count > 0`: "N payout(s)
  failed to reach your account. Contact support." Not dismissible — persists
  until the underlying count is zero.
- **Recent Payouts** table (date, company/recommendation, amount), with an
  empty state ("No payouts yet").
- **Earnings by Call** table (company/recommendation, count, total), with
  the same empty-state handling.
- Data fetching follows the existing `useEffect` + `ra_token` bearer-header
  pattern already used in `DashboardPage.tsx:10-29` — no new data-fetching
  library, consistent with the rest of the app.

## Assumption: gross vs net transfer amount

`amount_paise` stores `entity.amount` from the webhook — the transfer amount
**before** Razorpay's own Route fee (`entity.fees`/`entity.tax`) is
deducted — matching the 90% cut already computed at order-creation time
(`razorpayService.ts:41`). This assumes Route fees are billed to the
platform account rather than deducted from the linked account's received
amount. If the Razorpay account's fee-bearer configuration says otherwise,
this would slightly overstate earnings. Not blocking implementation on this
— worth confirming against the live Razorpay account configuration
separately.

## Edge cases

- **Out-of-order webhook delivery**: `ON CONFLICT (razorpay_transfer_id) DO
  UPDATE` means a row always reflects the most recently received event for
  that transfer ID. Acceptable since a given transfer ID's status is
  terminal in practice.
- **No matching `payments` row**: log and ack `200`, don't throw (webhooks
  are untrusted-until-signature-verified input; a signature-valid but
  unmatched event shouldn't retry forever).
- **RA with no linked account / no transfers yet**: API returns
  zeros/empty arrays; frontend's existing `onboarding_status` gate prevents
  the call before an account exists, but the API stays defensive regardless
  of caller.
- **No historical backfill**: confirmed acceptable — earnings count starts
  from ship date.

## Testing plan

- Webhook handler tests: `transfer.processed` upserts correctly,
  `transfer.failed` upserts correctly, retry/idempotency via `ON CONFLICT`,
  unmatched order doesn't throw.
- Earnings aggregation SQL: month/year bucketing correctness, especially
  around month/year boundaries in IST vs UTC.
- Manual verification: sign up as a test RA, complete a test purchase,
  simulate the relevant webhook, confirm the dashboard renders correctly.
