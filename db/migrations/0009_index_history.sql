DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'nse_index_history') THEN
    CREATE INDEX IF NOT EXISTS idx_nse_history_symbol_time ON nse_index_history ("symbol", "record_time" DESC);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bse_index_history') THEN
    CREATE INDEX IF NOT EXISTS idx_bse_history_sccode_time ON bse_index_history ("sccode", "record_time" DESC);
  END IF;
END $$;

