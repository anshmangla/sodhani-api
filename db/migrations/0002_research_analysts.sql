CREATE TABLE IF NOT EXISTS research_analysts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  profile_picture_url  TEXT,
  designation          TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  total_sales          INTEGER NOT NULL DEFAULT 0,
  token_version        INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'research_analysts'
      AND column_name = 'username'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_research_analysts_username_lower
      ON research_analysts (lower(username));
  END IF;
END $$;
