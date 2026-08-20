ALTER TABLE research_analysts RENAME COLUMN username TO email;
ALTER INDEX uq_research_analysts_username_lower RENAME TO uq_research_analysts_email_lower;

ALTER TABLE research_analysts
  ADD COLUMN razorpay_account_id TEXT,
  ADD COLUMN razorpay_stakeholder_id TEXT,
  ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'pending';