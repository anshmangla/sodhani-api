-- Adds Equity / Futures / Options support to research_calls. Idempotent:
-- every statement guards itself so `npm run migrate` is a safe no-op on a
-- database that already has these changes.

ALTER TABLE research_calls
  ADD COLUMN IF NOT EXISTS instrument_type TEXT NOT NULL DEFAULT 'EQUITY',
  ADD COLUMN IF NOT EXISTS entry_price_min NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS entry_price_max NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS strike_price NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS option_type TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Backfill entry_price_min/max from the old free-text buying_range, so
-- existing calls get a usable numeric entry price instead of starting null.
-- A plain single value ("245") becomes min = max; a range ("240-245" or
-- "240 – 245") splits on the dash; anything else (blank, prose, already
-- backfilled) is left alone.
UPDATE research_calls
SET entry_price_min = substring(buying_range from '^\s*(\d+(?:\.\d+)?)\s*$')::numeric,
    entry_price_max = substring(buying_range from '^\s*(\d+(?:\.\d+)?)\s*$')::numeric
WHERE entry_price_min IS NULL
  AND buying_range ~ '^\s*\d+(?:\.\d+)?\s*$';

UPDATE research_calls
SET entry_price_min = substring(buying_range from '^\s*(\d+(?:\.\d+)?)\s*[-–]')::numeric,
    entry_price_max = substring(buying_range from '[-–]\s*(\d+(?:\.\d+)?)\s*$')::numeric
WHERE entry_price_min IS NULL
  AND buying_range ~ '^\s*\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*$';

-- holding_period was free text (e.g. "3-6 months"); the new column is a
-- fixed 4-value set. Discard anything that doesn't already match one of the
-- new values rather than guess a mapping. Written as NOT IN (not a blanket
-- null) so re-running after new, valid-value rows exist is still a no-op.
UPDATE research_calls
SET holding_period = NULL
WHERE holding_period IS NOT NULL
  AND holding_period NOT IN ('Intraday', 'Short-term', 'Positional', 'Long-term');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_instrument_type_valid'
  ) THEN
    ALTER TABLE research_calls
      ADD CONSTRAINT call_instrument_type_valid
      CHECK (instrument_type IN ('EQUITY', 'FUTURES', 'OPTIONS'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_option_type_valid'
  ) THEN
    ALTER TABLE research_calls
      ADD CONSTRAINT call_option_type_valid
      CHECK (option_type IS NULL OR option_type IN ('CE', 'PE'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_holding_period_valid'
  ) THEN
    ALTER TABLE research_calls
      ADD CONSTRAINT call_holding_period_valid
      CHECK (holding_period IS NULL OR holding_period IN ('Intraday', 'Short-term', 'Positional', 'Long-term'));
  END IF;
END $$;

-- Equity: expiry/strike/option_type must all be absent (it's not a derivative).
-- Futures: expiry required, no strike/option_type (a future has no strike).
-- Options: expiry, strike and option_type all required.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_instrument_fields_coherent'
  ) THEN
    ALTER TABLE research_calls
      ADD CONSTRAINT call_instrument_fields_coherent
      CHECK (
        (instrument_type = 'EQUITY' AND expiry_date IS NULL AND strike_price IS NULL AND option_type IS NULL) OR
        (instrument_type = 'FUTURES' AND expiry_date IS NOT NULL AND strike_price IS NULL AND option_type IS NULL) OR
        (instrument_type = 'OPTIONS' AND expiry_date IS NOT NULL AND strike_price IS NOT NULL AND option_type IS NOT NULL)
      );
  END IF;
END $$;

-- Both entry bounds null, or both present with max >= min. Only Equity may
-- express a genuine range (min < max) — Futures/Options entry is a single
-- premium/price, so max must equal min there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_entry_range_valid'
  ) THEN
    ALTER TABLE research_calls
      ADD CONSTRAINT call_entry_range_valid
      CHECK (
        (entry_price_min IS NULL AND entry_price_max IS NULL) OR
        (
          entry_price_min IS NOT NULL AND entry_price_max IS NOT NULL AND
          entry_price_max >= entry_price_min AND
          (instrument_type = 'EQUITY' OR entry_price_max = entry_price_min)
        )
      );
  END IF;
END $$;

-- 'Hold' only makes sense as equity guidance; Futures/Options calls are
-- always a directional Buy/Sell.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_hold_is_equity_only'
  ) THEN
    ALTER TABLE research_calls
      ADD CONSTRAINT call_hold_is_equity_only
      CHECK (recommendation <> 'Hold' OR instrument_type = 'EQUITY');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_research_calls_instrument_type ON research_calls (instrument_type);
