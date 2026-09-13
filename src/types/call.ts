// Shared vocabulary for `research_calls`. There is no ORM/schema layer in this
// codebase (see db/migrations/0003_research_calls.sql for the source of
// truth) — these `as const` arrays are the single place both route handlers
// and tests import the valid values from, so a new value only needs adding
// once.

export const INSTRUMENT_TYPES = ['EQUITY', 'FUTURES', 'OPTIONS'] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const OPTION_TYPES = ['CE', 'PE'] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

export const HOLDING_PERIODS = ['Intraday', 'Short-term', 'Positional', 'Long-term'] as const;
export type HoldingPeriod = (typeof HOLDING_PERIODS)[number];

export const RECOMMENDATIONS = ['Buy', 'Hold', 'Sell'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

// 'Hold' is equity-only guidance (see the call_hold_is_equity_only CHECK
// constraint) — Futures/Options calls are always directional.
export const ACTIONS_BY_INSTRUMENT: Record<InstrumentType, readonly Recommendation[]> = {
  EQUITY: RECOMMENDATIONS,
  FUTURES: ['Buy', 'Sell'],
  OPTIONS: ['Buy', 'Sell'],
};

export function isInstrumentType(value: unknown): value is InstrumentType {
  return typeof value === 'string' && (INSTRUMENT_TYPES as readonly string[]).includes(value);
}

export function isOptionType(value: unknown): value is OptionType {
  return typeof value === 'string' && (OPTION_TYPES as readonly string[]).includes(value);
}

export function isHoldingPeriod(value: unknown): value is HoldingPeriod {
  return typeof value === 'string' && (HOLDING_PERIODS as readonly string[]).includes(value);
}
