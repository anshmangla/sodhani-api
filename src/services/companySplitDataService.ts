import * as fs from 'fs';
import * as path from 'path';
import {
  VARIANT_CONCERNS,
  SHARED_CONCERNS,
  STANDALONE_ONLY_CONCERNS,
} from '../data/staticStockConcerns';

export type Variant = 'standalone' | 'consolidated';

const VARIANT_CONCERN_SET = new Set<string>(VARIANT_CONCERNS);
const NON_VARIANT_CONCERN_SET = new Set<string>([...SHARED_CONCERNS, ...STANDALONE_ONLY_CONCERNS]);

export function isKnownConcern(concern: string): boolean {
  return VARIANT_CONCERN_SET.has(concern) || NON_VARIANT_CONCERN_SET.has(concern);
}

export function concernRequiresVariant(concern: string): boolean {
  return VARIANT_CONCERN_SET.has(concern);
}

function concernFilename(concern: string, variant: Variant): string {
  return VARIANT_CONCERN_SET.has(concern) ? `${concern}_${variant}.json` : `${concern}.json`;
}

interface ExchangeCodeMappings {
  nse_to_bse?: Record<string, string>;
  bse_to_nse?: Record<string, string>;
}

function readMappings(mappingsPath: string): ExchangeCodeMappings {
  try {
    return JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
  } catch {
    return {};
  }
}

function findDirCaseInsensitive(splitDir: string, name: string): string | null {
  const target = path.join(splitDir, name);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return target;

  let entries: string[];
  try {
    entries = fs.readdirSync(splitDir);
  } catch {
    return null;
  }
  const lowerTarget = name.toLowerCase();
  const match = entries.find((e) => e.toLowerCase() === lowerTarget);
  return match ? path.join(splitDir, match) : null;
}

// Mirrors the exact/case-insensitive-then-BSE<->NSE-mapping fallback chain
// `searchStaticStock` in src/routes/market.ts uses for output/output_consolidated,
// but resolves a company *directory* under output_split/ instead of a file.
function resolveCompanyDir(splitDir: string, mappingsPath: string, query: string): string | null {
  const direct = findDirCaseInsensitive(splitDir, query);
  if (direct) return direct;

  const mappings = readMappings(mappingsPath);
  const upperQuery = query.toUpperCase();
  const mappedCode = mappings.nse_to_bse?.[upperQuery] ?? mappings.bse_to_nse?.[upperQuery];
  if (!mappedCode) return null;

  return findDirCaseInsensitive(splitDir, mappedCode);
}

export interface GetCompanyConcernOptions {
  splitDir: string;
  mappingsPath: string;
  symbolQuery: string;
  concern: string;
  variant: Variant;
}

export type GetCompanyConcernResult =
  | { status: 'ok'; data: unknown }
  | { status: 'company_not_found' }
  | { status: 'concern_not_found' };

export function getCompanyConcern(opts: GetCompanyConcernOptions): GetCompanyConcernResult {
  const companyDir = resolveCompanyDir(opts.splitDir, opts.mappingsPath, opts.symbolQuery);
  if (!companyDir) return { status: 'company_not_found' };

  const filePath = path.join(companyDir, concernFilename(opts.concern, opts.variant));
  if (!fs.existsSync(filePath)) return { status: 'concern_not_found' };

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { status: 'ok', data };
}
