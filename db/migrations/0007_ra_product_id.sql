-- Needed to self-heal onboarding_status by live-checking Razorpay's Product
-- Configuration API (products.fetch), since Route KYC-status webhooks have
-- proven unreliable to depend on alone (missed/mis-scoped config, delivery
-- timing) — see GET /api/ra/me in raAuth.ts.
ALTER TABLE research_analysts ADD COLUMN IF NOT EXISTS razorpay_product_id TEXT;
