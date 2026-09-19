-- Admin "deactivate user" needs a real status column — users has none today
-- (unlike research_analysts.is_active). Paired with a requireAuth check in
-- src/auth/middleware.ts so deactivation actually blocks login, not just UI.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
