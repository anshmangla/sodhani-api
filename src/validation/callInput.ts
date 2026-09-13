import {
  ACTIONS_BY_INSTRUMENT,
  HOLDING_PERIODS,
  INSTRUMENT_TYPES,
  InstrumentType,
  isHoldingPeriod,
  isInstrumentType,
  isOptionType,
  OptionType,
  Recommendation,
} from '../types/call';

const SCRIP_CODE_REGEX = /^[A-Za-z0-9._\-&]{1,32}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export type ParsedCallInput = {
  scripCode: string;
  companyName: string;
  instrumentType: InstrumentType;
  recommendation: Recommendation;
  expiryDate: string | null;
  strikePrice: number | null;
  optionType: OptionType | null;
  entryPriceMin: number;
  entryPriceMax: number;
  targetPrice: number;
  stopLoss: number | null;
  buyingRange: string;
  holdingPeriod: string | null;
  description: string | null;
  isPaid: boolean;
  pricePaise: number | null;
  currentPriceAtPublish: number | null;
  volumeAtPublish: number | null;
};

export type ParseCallInputResult =
  | { ok: true; value: ParsedCallInput }
  | { ok: false; error: string };

function err(error: string): ParseCallInputResult {
  return { ok: false, error };
}

// `YYYY-MM-DD`, a real calendar date (rejects e.g. 2024-02-30), not earlier
// than "today" in IST — matching the exchange's trading day, not the
// server's/client's own local timezone.
function isValidFutureExpiry(raw: string): boolean {
  if (!DATE_REGEX.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return false;
  }
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayIst = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, '0')}-${String(
    nowIst.getUTCDate()
  ).padStart(2, '0')}`;
  return raw >= todayIst;
}

function formatPrice(n: number): string {
  // Trim to at most 2 decimals without forcing trailing zeros, matching the
  // free-text style RAs typed by hand before ("240-245", not "240.00-245.00").
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * Validates and normalizes a `POST /api/ra/calls` body into DB-ready values,
 * enforcing the Equity/Futures/Options field-coherence rules that
 * `db/migrations/0012_research_calls_instruments.sql`'s CHECK constraints
 * also enforce at the DB layer (defense in depth, and a much friendlier
 * error message than a raw constraint-violation from Postgres).
 */
export function parseCallInput(body: unknown): ParseCallInputResult {
  const b = (body ?? {}) as Record<string, unknown>;

  const { scrip_code, company_name, instrument_type, recommendation } = b;

  if (typeof scrip_code !== 'string' || !SCRIP_CODE_REGEX.test(scrip_code.trim())) {
    return err('Valid scrip_code is required (alphanumeric, up to 32 characters)');
  }
  if (typeof company_name !== 'string' || company_name.trim().length === 0 || company_name.length > 255) {
    return err('company_name is required (up to 255 characters)');
  }
  if (!isInstrumentType(instrument_type)) {
    return err(`instrument_type must be one of ${INSTRUMENT_TYPES.join(', ')}`);
  }

  const validActions = ACTIONS_BY_INSTRUMENT[instrument_type];
  if (typeof recommendation !== 'string' || !validActions.includes(recommendation as Recommendation)) {
    return err(`recommendation must be one of ${validActions.join(', ')} for ${instrument_type}`);
  }

  // Expiry / strike / option type — required or forbidden depending on
  // instrument_type, mirroring call_instrument_fields_coherent.
  const { expiry_date, strike_price, option_type } = b;
  let expiryDate: string | null = null;
  let strikePrice: number | null = null;
  let optionType: OptionType | null = null;

  if (instrument_type === 'EQUITY') {
    if (expiry_date != null || strike_price != null || option_type != null) {
      return err('Equity calls cannot have an expiry, strike price, or option type');
    }
  } else {
    if (typeof expiry_date !== 'string' || !isValidFutureExpiry(expiry_date)) {
      return err('expiry_date is required for Futures/Options and must be YYYY-MM-DD, not in the past');
    }
    expiryDate = expiry_date;

    if (instrument_type === 'FUTURES') {
      if (strike_price != null || option_type != null) {
        return err('Futures calls cannot have a strike price or option type');
      }
    } else {
      // OPTIONS
      if (typeof strike_price !== 'number' || !Number.isFinite(strike_price) || strike_price <= 0 || strike_price > 10000000) {
        return err('strike_price is required for Options and must be a positive number');
      }
      if (!isOptionType(option_type)) {
        return err('option_type is required for Options and must be CE or PE');
      }
      strikePrice = strike_price;
      optionType = option_type;
    }
  }

  // Entry price — single value or (Equity-only) a min/max range.
  const { entry_price_min, entry_price_max } = b;
  if (typeof entry_price_min !== 'number' || !Number.isFinite(entry_price_min) || entry_price_min <= 0 || entry_price_min > 10000000) {
    return err('entry_price_min is required and must be a positive number');
  }
  let entryPriceMax = entry_price_min;
  if (entry_price_max != null) {
    if (typeof entry_price_max !== 'number' || !Number.isFinite(entry_price_max) || entry_price_max <= 0 || entry_price_max > 10000000) {
      return err('entry_price_max must be a positive number when provided');
    }
    if (entry_price_max < entry_price_min) {
      return err('entry_price_max cannot be less than entry_price_min');
    }
    if (entry_price_max > entry_price_min && instrument_type !== 'EQUITY') {
      return err('Only Equity calls can have an entry price range');
    }
    entryPriceMax = entry_price_max;
  }
  const buyingRange =
    entryPriceMax === entry_price_min
      ? formatPrice(entry_price_min)
      : `${formatPrice(entry_price_min)}-${formatPrice(entryPriceMax)}`;

  const { target_price, stop_loss } = b;
  if (typeof target_price !== 'number' || !Number.isFinite(target_price) || target_price <= 0 || target_price > 10000000) {
    return err('target_price is required and must be a positive number');
  }
  const stopLoss =
    typeof stop_loss === 'number' && Number.isFinite(stop_loss) && stop_loss > 0 && stop_loss <= 10000000 ? stop_loss : null;

  const { holding_period, description } = b;
  if (holding_period != null && !isHoldingPeriod(holding_period)) {
    return err(`holding_period must be one of ${HOLDING_PERIODS.join(', ')}`);
  }
  const holdingPeriod = holding_period ?? null;

  let descriptionValue: string | null = null;
  if (description != null) {
    if (typeof description !== 'string' || description.length > 2000) {
      return err('description must be a string of up to 2000 characters');
    }
    const trimmed = description.trim();
    descriptionValue = trimmed.length > 0 ? trimmed : null;
  }

  const { is_paid, price_paise, current_price_at_publish, volume_at_publish } = b;
  const isPaid = is_paid === true;
  let pricePaise: number | null = null;
  if (isPaid) {
    if (typeof price_paise !== 'number' || !Number.isInteger(price_paise) || price_paise < 100 || price_paise > 10000000) {
      return err('price_paise is required and must be an integer between 100 and 10000000 when is_paid is true');
    }
    pricePaise = price_paise;
  }

  const currentPriceAtPublish =
    typeof current_price_at_publish === 'number' && Number.isFinite(current_price_at_publish) && current_price_at_publish > 0
      ? current_price_at_publish
      : null;
  const volumeAtPublish =
    typeof volume_at_publish === 'number' && Number.isInteger(volume_at_publish) && volume_at_publish >= 0
      ? volume_at_publish
      : null;

  return {
    ok: true,
    value: {
      scripCode: scrip_code.trim(),
      companyName: company_name.trim(),
      instrumentType: instrument_type,
      recommendation: recommendation as Recommendation,
      expiryDate,
      strikePrice,
      optionType,
      entryPriceMin: entry_price_min,
      entryPriceMax,
      targetPrice: target_price,
      stopLoss,
      buyingRange,
      holdingPeriod,
      description: descriptionValue,
      isPaid,
      pricePaise,
      currentPriceAtPublish,
      volumeAtPublish,
    },
  };
}
