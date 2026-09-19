-- Pure performance indexes for the new admin dashboard's filters/aggregates.
-- Additive and idempotent, no behavior change. research_calls.ra_id/created_at
-- and ra_transfers(ra_id, processed_at) are already indexed (0003, 0005).

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_calls_status ON research_calls (status);
CREATE INDEX IF NOT EXISTS idx_research_calls_is_paid ON research_calls (is_paid);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ra_transfers_status ON ra_transfers (status);
CREATE INDEX IF NOT EXISTS idx_ra_transfers_settlement_status ON ra_transfers (settlement_status);
