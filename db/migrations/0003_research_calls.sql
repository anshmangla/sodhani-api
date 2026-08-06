CREATE TABLE IF NOT EXISTS research_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ra_id           UUID NOT NULL REFERENCES research_analysts(id),
  scrip_code      TEXT NOT NULL,
  company_name    TEXT NOT NULL,
  recommendation  TEXT NOT NULL CHECK (recommendation IN ('Buy','Hold','Sell')),
  current_price_at_publish NUMERIC(14,2),
  volume_at_publish        BIGINT,
  target_price    NUMERIC(14,2) NOT NULL,
  stop_loss       NUMERIC(14,2),
  buying_range    TEXT,
  holding_period  TEXT,
  is_paid         BOOLEAN NOT NULL DEFAULT false,
  price_paise     INTEGER,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paid_call_requires_price CHECK (
    (is_paid = false AND price_paise IS NULL) OR
    (is_paid = true AND price_paise IS NOT NULL AND price_paise > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_research_calls_ra_id ON research_calls (ra_id);
CREATE INDEX IF NOT EXISTS idx_research_calls_created_at ON research_calls (created_at DESC);

CREATE TABLE IF NOT EXISTS call_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     UUID NOT NULL REFERENCES research_calls(id),
  ra_id       UUID NOT NULL REFERENCES research_analysts(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_comments_call_id ON call_comments (call_id, created_at);

-- One row per Razorpay order; the idempotency anchor for the purchase transaction.
CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id),
  call_id              UUID NOT NULL REFERENCES research_calls(id),
  razorpay_order_id    TEXT NOT NULL,
  razorpay_payment_id  TEXT,
  razorpay_signature   TEXT,
  amount_paise         INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_order_id ON payments (razorpay_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_payment_id
  ON payments (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchased_calls (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  call_id      UUID NOT NULL REFERENCES research_calls(id),
  payment_id   UUID NOT NULL REFERENCES payments(id),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Primary idempotency guard: a (user, call) pair can only ever get one access grant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchased_calls_user_call
  ON purchased_calls (user_id, call_id);
