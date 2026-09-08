CREATE TABLE IF NOT EXISTS "company_price_extremes"(
    "FinInstrmId" VARCHAR(50) PRIMARY KEY,
    "high_1d" DECIMAL(14, 4) NULL,
    "low_1d" DECIMAL(14, 4) NULL,
    "high_1w" DECIMAL(14, 4) NULL,
    "low_1w" DECIMAL(14, 4) NULL,
    "high_1m" DECIMAL(14, 4) NULL,
    "low_1m" DECIMAL(14, 4) NULL,
    "high_1y" DECIMAL(14, 4) NULL,
    "low_1y" DECIMAL(14, 4) NULL,
    "high_5y" DECIMAL(14, 4) NULL,
    "low_5y" DECIMAL(14, 4) NULL,
    "high_all" DECIMAL(14, 4) NULL,
    "low_all" DECIMAL(14, 4) NULL,
    "last_trade_date" DATE NULL,
    "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_company_price_extremes_stock"
      FOREIGN KEY("FinInstrmId")
      REFERENCES "company_stock"("FinInstrmId")
      ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "company_price_extremes_idx" ON "company_price_extremes"("FinInstrmId");
