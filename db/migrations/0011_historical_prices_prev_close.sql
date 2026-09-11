-- Previous close as a first-class column.
--
-- Both live feeds ship the official exchange previous close alongside the last
-- traded price (NSE `previousClose`, BSE `prevdayclose`), so the scraper now
-- writes it onto the row it is already inserting for the current session.
--
-- This replaces syncPreviousCloseNSE/syncPreviousCloseBSE, which back-wrote the
-- value into the PREVIOUS trading day's bar by overwriting its close_price. That
-- silently corrupted history whenever the previous bar was missing (the write
-- landed on whatever older bar happened to be most recent), on corporate-action
-- ex-dates (close_price went raw while adj_close stayed adjusted), and on
-- dual-listed scrips (an NSE close overwriting a BSE-sourced series).
--
-- Nullable with no default: metadata-only in PG 11+, no table rewrite.
ALTER TABLE "historical_prices"
  ADD COLUMN IF NOT EXISTS "prev_close" DECIMAL(14, 6) NULL;
