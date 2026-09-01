import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getCompanyConcern,
  isKnownConcern,
  concernRequiresVariant,
} from '../src/services/companySplitDataService';

const workspaces: string[] = [];

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-split-service-'));
  const splitDir = path.join(root, 'output_split');
  const mappingsPath = path.join(root, 'exchange_code_mappings.json');
  fs.mkdirSync(splitDir);
  fs.writeFileSync(mappingsPath, JSON.stringify({ nse_to_bse: {}, bse_to_nse: {} }));
  workspaces.push(root);
  return { root, splitDir, mappingsPath };
}

function writeCompanyFile(splitDir: string, company: string, filename: string, data: unknown) {
  const dir = path.join(splitDir, company);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
}

afterEach(() => {
  while (workspaces.length) {
    fs.rmSync(workspaces.pop()!, { recursive: true, force: true });
  }
});

describe('isKnownConcern / concernRequiresVariant', () => {
  it('accepts variant, shared, and standalone-only concerns, rejects unknown ones', () => {
    expect(isKnownConcern('key_metrics')).toBe(true);
    expect(isKnownConcern('shareholding')).toBe(true);
    expect(isKnownConcern('industry')).toBe(true);
    expect(isKnownConcern('not_a_real_concern')).toBe(false);
  });

  it('only requires a variant for the standalone/consolidated concerns', () => {
    expect(concernRequiresVariant('key_metrics')).toBe(true);
    expect(concernRequiresVariant('shareholding')).toBe(false);
    expect(concernRequiresVariant('industry')).toBe(false);
  });
});

describe('getCompanyConcern', () => {
  it('returns the requested variant file for an exact directory match', () => {
    const ws = makeWorkspace();
    writeCompanyFile(ws.splitDir, 'RELIANCE', 'key_metrics_consolidated.json', { ROCE: '10.3 %' });

    const result = getCompanyConcern({
      ...ws,
      symbolQuery: 'RELIANCE',
      concern: 'key_metrics',
      variant: 'consolidated',
    });

    expect(result).toEqual({ status: 'ok', data: { ROCE: '10.3 %' } });
  });

  it('resolves the company directory case-insensitively', () => {
    const ws = makeWorkspace();
    writeCompanyFile(ws.splitDir, 'RELIANCE', 'shareholding.json', { promoters: '50.3 %' });

    const result = getCompanyConcern({
      ...ws,
      symbolQuery: 'reliance',
      concern: 'shareholding',
      variant: 'consolidated',
    });

    expect(result).toEqual({ status: 'ok', data: { promoters: '50.3 %' } });
  });

  it('falls back through the BSE<->NSE mapping when no direct directory matches', () => {
    const ws = makeWorkspace();
    fs.writeFileSync(
      ws.mappingsPath,
      JSON.stringify({ nse_to_bse: { RELIANCE: '500325' }, bse_to_nse: { '500325': 'RELIANCE' } })
    );
    writeCompanyFile(ws.splitDir, '500325', 'industry.json', { industry_name: 'Energy' });

    const result = getCompanyConcern({
      ...ws,
      symbolQuery: 'RELIANCE',
      concern: 'industry',
      variant: 'consolidated',
    });

    expect(result).toEqual({ status: 'ok', data: { industry_name: 'Energy' } });
  });

  it('returns company_not_found when the symbol resolves to nothing', () => {
    const ws = makeWorkspace();

    const result = getCompanyConcern({
      ...ws,
      symbolQuery: 'NOPE',
      concern: 'shareholding',
      variant: 'consolidated',
    });

    expect(result).toEqual({ status: 'company_not_found' });
  });

  it('returns concern_not_found when the company exists but that concern/variant was never split', () => {
    const ws = makeWorkspace();
    writeCompanyFile(ws.splitDir, 'RELIANCE', 'key_metrics_consolidated.json', { ROCE: '10.3 %' });

    const result = getCompanyConcern({
      ...ws,
      symbolQuery: 'RELIANCE',
      concern: 'key_metrics',
      variant: 'standalone',
    });

    expect(result).toEqual({ status: 'concern_not_found' });
  });
});
