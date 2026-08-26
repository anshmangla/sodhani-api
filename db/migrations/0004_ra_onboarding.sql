-- Idempotent: guards every statement so `npm run migrate` is a safe no-op on a
-- database that already applied these changes via the old manual psql flow.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'research_analysts'
      AND column_name = 'username'
  ) THEN
    ALTER TABLE research_analysts RENAME COLUMN username TO email;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uq_research_analysts_username_lower'
  ) THEN
    ALTER INDEX uq_research_analysts_username_lower RENAME TO uq_research_analysts_email_lower;
  END IF;
END $$;

ALTER TABLE research_analysts
  ADD COLUMN IF NOT EXISTS razorpay_account_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_stakeholder_id TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'pending';