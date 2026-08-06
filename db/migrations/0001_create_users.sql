-- gen_random_uuid() is a pg_catalog builtin on Postgres 13+.
-- On Postgres < 13, run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` first.

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  age            INTEGER,
  email          TEXT,
  phone_number   TEXT UNIQUE,
  auth_provider  TEXT NOT NULL DEFAULT 'otp' CHECK (auth_provider IN ('otp', 'google')),
  token_version  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_present CHECK (phone_number IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
  ON users (lower(email))
  WHERE email IS NOT NULL;
