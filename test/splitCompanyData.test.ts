import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { splitCompanyData } from '../scripts/split_company_data';

const workspaces: string[] = [];

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-company-data-'));
  const outputDir = path.join(root, 'output');
  const consolidatedDir = path.join(root, 'output_consolidated');
  const splitDir = path.join(root, 'output_split');
  const checkpointPath = path.join(root, 'split_checkpoint.json');
  fs.mkdirSync(outputDir);
  fs.mkdirSync(consolidatedDir);
  workspaces.push(root);
  return { root, outputDir, consolidatedDir, splitDir, checkpointPath };
}

function writeJson(dir: string, name: string, data: unknown) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data));
}

function readJson(...parts: string[]) {
  return JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
}

afterEach(() => {
  while (workspaces.length) {
    const dir = workspaces.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('splitCompanyData', () => {
  it('writes standalone and consolidated variant files for a company present in both source directories', async () => {
    const ws = makeWorkspace();

    writeJson(ws.outputDir, 'RELIANCE', {
      ticker: 'RELIANCE',
      url: 'https://www.screener.in/company/RELIANCE/',
      overview: { company_name: 'Reliance Industries Ltd', about: 'Standalone about text', website: '' },
      industry: { industry_name: 'Energy' },
      key_metrics: { 'Book Value': '₹ 418', ROCE: '7.78 %' },
      shareholding: { promoters: '50.3 %' },
    });
    writeJson(ws.consolidatedDir, 'RELIANCE', {
      ticker: 'RELIANCE',
      url: 'https://www.screener.in/company/RELIANCE/consolidated/',
      overview: { company_name: 'Reliance Industries Ltd', about: '', website: '' },
      key_metrics: { 'Book Value': '₹ 668', ROCE: '10.3 %' },
      shareholding: { promoters: '50.3 %' },
    });

    await splitCompanyData(ws);

    const overviewStandalone = readJson(ws.splitDir, 'RELIANCE', 'overview_standalone.json');
    expect(overviewStandalone).toEqual({
      company_name: 'Reliance Industries Ltd',
      about: 'Standalone about text',
      website: '',
      ticker: 'RELIANCE',
      url: 'https://www.screener.in/company/RELIANCE/',
    });

    const overviewConsolidated = readJson(ws.splitDir, 'RELIANCE', 'overview_consolidated.json');
    expect(overviewConsolidated).toEqual({
      company_name: 'Reliance Industries Ltd',
      about: '',
      website: '',
      ticker: 'RELIANCE',
      url: 'https://www.screener.in/company/RELIANCE/consolidated/',
    });

    const keyMetricsStandalone = readJson(ws.splitDir, 'RELIANCE', 'key_metrics_standalone.json');
    expect(keyMetricsStandalone).toEqual({ 'Book Value': '₹ 418', ROCE: '7.78 %' });

    const keyMetricsConsolidated = readJson(ws.splitDir, 'RELIANCE', 'key_metrics_consolidated.json');
    expect(keyMetricsConsolidated).toEqual({ 'Book Value': '₹ 668', ROCE: '10.3 %' });

    const industry = readJson(ws.splitDir, 'RELIANCE', 'industry.json');
    expect(industry).toEqual({ industry_name: 'Energy' });

    // Consolidated has no `industry` key - no consolidated-suffixed industry file should exist.
    expect(fs.existsSync(path.join(ws.splitDir, 'RELIANCE', 'industry_consolidated.json'))).toBe(false);

    // shareholding is identical across standalone/consolidated in practice - one shared file,
    // no _standalone/_consolidated split.
    const shareholding = readJson(ws.splitDir, 'RELIANCE', 'shareholding.json');
    expect(shareholding).toEqual({ promoters: '50.3 %' });
    expect(fs.existsSync(path.join(ws.splitDir, 'RELIANCE', 'shareholding_standalone.json'))).toBe(false);
    expect(fs.existsSync(path.join(ws.splitDir, 'RELIANCE', 'shareholding_consolidated.json'))).toBe(false);
  });

  it('writes only standalone files for a company that has no consolidated source yet', async () => {
    const ws = makeWorkspace();

    writeJson(ws.outputDir, 'ANDHRAPET', {
      ticker: 'ANDHRAPET',
      url: 'https://www.screener.in/company/ANDHRAPET/',
      overview: { company_name: 'Andhra Petrochemicals Ltd' },
    });

    const result = await splitCompanyData(ws);

    expect(result.failed).toEqual([]);
    expect(result.processed).toEqual(['ANDHRAPET']);

    const overviewStandalone = readJson(ws.splitDir, 'ANDHRAPET', 'overview_standalone.json');
    expect(overviewStandalone).toEqual({
      company_name: 'Andhra Petrochemicals Ltd',
      ticker: 'ANDHRAPET',
      url: 'https://www.screener.in/company/ANDHRAPET/',
    });
    expect(fs.existsSync(path.join(ws.splitDir, 'ANDHRAPET', 'overview_consolidated.json'))).toBe(false);
  });

  it('skips re-splitting a company whose source files have not changed since the last run', async () => {
    const ws = makeWorkspace();
    writeJson(ws.outputDir, 'ANDHRAPET', {
      ticker: 'ANDHRAPET',
      url: 'https://www.screener.in/company/ANDHRAPET/',
      overview: { company_name: 'Andhra Petrochemicals Ltd' },
    });

    const first = await splitCompanyData(ws);
    expect(first.processed).toEqual(['ANDHRAPET']);

    // Simulate a manual edit to prove the second run leaves the file alone rather
    // than regenerating it from the (unchanged) source.
    const overviewPath = path.join(ws.splitDir, 'ANDHRAPET', 'overview_standalone.json');
    fs.writeFileSync(overviewPath, JSON.stringify({ manually_edited: true }));

    const second = await splitCompanyData(ws);
    expect(second.skipped).toEqual(['ANDHRAPET']);
    expect(second.processed).toEqual([]);
    expect(readJson(overviewPath)).toEqual({ manually_edited: true });
  });

  it('re-splits a company after its source file is rewritten (e.g. a fresh quarterly-results scrape)', async () => {
    const ws = makeWorkspace();
    writeJson(ws.outputDir, 'ANDHRAPET', {
      ticker: 'ANDHRAPET',
      url: 'https://www.screener.in/company/ANDHRAPET/',
      overview: { company_name: 'Andhra Petrochemicals Ltd' },
      quarterly: { 'Mar 2026': 'old figures' },
    });
    await splitCompanyData(ws);

    // Re-scrape lands new quarterly figures. Bump mtime forward to guarantee it
    // differs from the first write, same as a real file rewrite would.
    writeJson(ws.outputDir, 'ANDHRAPET', {
      ticker: 'ANDHRAPET',
      url: 'https://www.screener.in/company/ANDHRAPET/',
      overview: { company_name: 'Andhra Petrochemicals Ltd' },
      quarterly: { 'Jun 2026': 'new figures' },
    });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(ws.outputDir, 'ANDHRAPET.json'), future, future);

    const second = await splitCompanyData(ws);
    expect(second.processed).toEqual(['ANDHRAPET']);

    const quarterly = readJson(ws.splitDir, 'ANDHRAPET', 'quarterly_standalone.json');
    expect(quarterly).toEqual({ 'Jun 2026': 'new figures' });
  });

  it('skips a company with malformed source JSON without aborting the rest of the run', async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws.outputDir, 'BROKEN.json'), '{ not valid json');
    writeJson(ws.outputDir, 'ANDHRAPET', {
      ticker: 'ANDHRAPET',
      url: 'https://www.screener.in/company/ANDHRAPET/',
      overview: { company_name: 'Andhra Petrochemicals Ltd' },
    });

    const result = await splitCompanyData(ws);

    expect(result.processed).toEqual(['ANDHRAPET']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].company).toBe('BROKEN');
    expect(fs.existsSync(path.join(ws.splitDir, 'BROKEN'))).toBe(false);

    const overviewStandalone = readJson(ws.splitDir, 'ANDHRAPET', 'overview_standalone.json');
    expect(overviewStandalone.company_name).toBe('Andhra Petrochemicals Ltd');
  });

  it('retries a previously-failed company on the next run instead of leaving it permanently skipped', async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws.outputDir, 'BROKEN.json'), '{ not valid json');

    const first = await splitCompanyData(ws);
    expect(first.failed.map((f) => f.company)).toEqual(['BROKEN']);

    // Fix the file without touching mtime semantics beyond a normal rewrite.
    writeJson(ws.outputDir, 'BROKEN', {
      ticker: 'BROKEN',
      url: 'https://www.screener.in/company/BROKEN/',
      overview: { company_name: 'Now Valid Ltd' },
    });

    const second = await splitCompanyData(ws);
    expect(second.failed).toEqual([]);
    expect(second.processed).toEqual(['BROKEN']);
    const overview = readJson(ws.splitDir, 'BROKEN', 'overview_standalone.json');
    expect(overview.company_name).toBe('Now Valid Ltd');
  });
});
