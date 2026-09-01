// Shared source of truth for the concern breakdown of the screener.in scrapes
// in output/ and output_consolidated/ (see scripts/split_company_data.ts,
// which writes these into output_split/, and src/services/companySplitDataService.ts,
// which serves them via GET /api/company/:symbol/:concern).

// Concerns that hold genuinely different data between the standalone
// (`output/`) and consolidated (`output_consolidated/`) screener.in scrapes -
// verified against production data (RELIANCE, 500012): key_metrics, profit_loss
// etc. differ (subsidiary-inclusive vs not), so each is split into two variant
// files instead of merged into one.
export const VARIANT_CONCERNS = [
  'overview',
  'key_metrics',
  'pros_cons',
  'quarterly',
  'profit_loss',
  'balance_sheet',
  'cash_flows',
  'ratios',
  'investors',
] as const;

// Concerns confirmed identical between standalone and consolidated for the
// same company (shareholding pattern isn't computed per standalone/
// consolidated) - written once, no _standalone/_consolidated suffix.
export const SHARED_CONCERNS = ['shareholding'] as const;

// `industry` only ever appears in the standalone (`output/`) scrape.
export const STANDALONE_ONLY_CONCERNS = ['industry'] as const;
