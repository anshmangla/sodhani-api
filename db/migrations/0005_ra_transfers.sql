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
