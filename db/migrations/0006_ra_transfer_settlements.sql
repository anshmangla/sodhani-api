-- Tracks whether a processed Route transfer has actually settled to the RA's
-- bank account, fed by the settlement.processed webhook cross-referenced
-- against Razorpay's Transfers API (transfers.all({ recipient_settlement_id })),
-- since the webhook payload itself only carries the settlement, not which
-- transfers it covers.
ALTER TABLE ra_transfers
  ADD COLUMN IF NOT EXISTS settlement_status TEXT NOT NULL DEFAULT 'pending' CHECK (settlement_status IN ('pending', 'settled')),
  ADD COLUMN IF NOT EXISTS razorpay_settlement_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_settlement_utr TEXT,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
