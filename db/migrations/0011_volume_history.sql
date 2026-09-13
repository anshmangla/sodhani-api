CREATE TABLE IF NOT EXISTS "bse_volume_history"(
    "scrip_cd" VARCHAR(50) NOT NULL,
    "record_date" DATE NOT NULL,
    "volume" BIGINT NULL,
    "delivery_qty" BIGINT NULL,
    "delivery_val" DECIMAL(24, 4) NULL,
    "turnover" DECIMAL(24, 4) NULL,
    "delivery_pct" DECIMAL(6, 2) NULL,
    "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("scrip_cd", "record_date")
);

CREATE INDEX IF NOT EXISTS "bse_volume_history_idx" ON "bse_volume_history"("scrip_cd", "record_date" DESC);
CREATE INDEX IF NOT EXISTS "bse_volume_history_record_date_idx" ON "bse_volume_history"("record_date" DESC);

CREATE TABLE IF NOT EXISTS "nse_volume_history"(
    "symbol" VARCHAR(50) NOT NULL,
    "series" VARCHAR(10) NOT NULL DEFAULT 'EQ',
    "record_date" DATE NOT NULL,
    "volume" BIGINT NULL,
    "delivery_qty" BIGINT NULL,
    "delivery_pct" DECIMAL(6, 2) NULL,
    "turnover" DECIMAL(24, 4) NULL,
    "no_of_trades" BIGINT NULL,
    "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("symbol", "series", "record_date")
);

CREATE INDEX IF NOT EXISTS "nse_volume_history_idx" ON "nse_volume_history"("symbol", "record_date" DESC);
CREATE INDEX IF NOT EXISTS "nse_volume_history_record_date_idx" ON "nse_volume_history"("record_date" DESC);
