CREATE INDEX IF NOT EXISTS idx_nse_history_symbol_time ON nse_index_history ("symbol", "record_time" DESC);
CREATE INDEX IF NOT EXISTS idx_bse_history_sccode_time ON bse_index_history ("sccode", "record_time" DESC);
