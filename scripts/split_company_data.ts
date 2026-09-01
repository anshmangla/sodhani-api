import * as fs from 'fs';
import * as path from 'path';
import { VARIANT_CONCERNS, SHARED_CONCERNS, STANDALONE_ONLY_CONCERNS } from '../src/data/staticStockConcerns';

export { VARIANT_CONCERNS, SHARED_CONCERNS, STANDALONE_ONLY_CONCERNS };

export interface SplitCompanyDataOptions {
  outputDir: string;
  consolidatedDir: string;
  splitDir: string;
  checkpointPath: string;
}

interface CheckpointEntry {
  outputMtimeMs?: number;
  consolidatedMtimeMs?: number;
}
type Checkpoint = Record<string, CheckpointEntry>;

export interface SplitCompanyDataResult {
  processed: string[];
  skipped: string[];
  failed: { company: string; error: string }[];
}

function readCheckpoint(checkpointPath: string): Checkpoint {
  if (!fs.existsSync(checkpointPath)) return {};
  return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
}

function writeCheckpoint(checkpointPath: string, checkpoint: Checkpoint): void {
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
}

function listCompanies(dir: string): Set<string> {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
  );
}

function statMtimeMs(filePath: string): number | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.statSync(filePath).mtimeMs;
}

function readJsonIfExists(filePath: string): any | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Atomic write: write to a sibling .tmp file then rename, so a concurrent
// reader never sees a half-written file.
function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, filePath);
}

function overviewWithMeta(source: any): Record<string, unknown> | undefined {
  if (source?.overview === undefined) return undefined;
  return { ...source.overview, ticker: source.ticker, url: source.url };
}

export async function splitCompanyData(
  opts: SplitCompanyDataOptions
): Promise<SplitCompanyDataResult> {
  const checkpoint = readCheckpoint(opts.checkpointPath);
  const companies = new Set([
    ...listCompanies(opts.outputDir),
    ...listCompanies(opts.consolidatedDir),
  ]);

  const result: SplitCompanyDataResult = { processed: [], skipped: [], failed: [] };

  for (const company of companies) {
    const outputPath = path.join(opts.outputDir, `${company}.json`);
    const consolidatedPath = path.join(opts.consolidatedDir, `${company}.json`);
    const outputMtimeMs = statMtimeMs(outputPath);
    const consolidatedMtimeMs = statMtimeMs(consolidatedPath);

    const prev = checkpoint[company];
    if (
      prev &&
      prev.outputMtimeMs === outputMtimeMs &&
      prev.consolidatedMtimeMs === consolidatedMtimeMs
    ) {
      result.skipped.push(company);
      continue;
    }

    let outputData: any;
    let consolidatedData: any;
    try {
      outputData = readJsonIfExists(outputPath);
      consolidatedData = readJsonIfExists(consolidatedPath);
    } catch (e) {
      result.failed.push({ company, error: String(e) });
      continue;
    }

    const companyDir = path.join(opts.splitDir, company);

    for (const concern of VARIANT_CONCERNS) {
      const standaloneValue =
        concern === 'overview' ? overviewWithMeta(outputData) : outputData?.[concern];
      const consolidatedValue =
        concern === 'overview' ? overviewWithMeta(consolidatedData) : consolidatedData?.[concern];

      if (standaloneValue !== undefined) {
        writeJsonAtomic(path.join(companyDir, `${concern}_standalone.json`), standaloneValue);
      }
      if (consolidatedValue !== undefined) {
        writeJsonAtomic(path.join(companyDir, `${concern}_consolidated.json`), consolidatedValue);
      }
    }

    for (const concern of SHARED_CONCERNS) {
      const value = consolidatedData?.[concern] ?? outputData?.[concern];
      if (value !== undefined) {
        writeJsonAtomic(path.join(companyDir, `${concern}.json`), value);
      }
    }

    for (const concern of STANDALONE_ONLY_CONCERNS) {
      const value = outputData?.[concern];
      if (value !== undefined) {
        writeJsonAtomic(path.join(companyDir, `${concern}.json`), value);
      }
    }

    checkpoint[company] = { outputMtimeMs, consolidatedMtimeMs };
    result.processed.push(company);
  }

  writeCheckpoint(opts.checkpointPath, checkpoint);
  return result;
}

if (require.main === module) {
  const outputDir = process.env.STATIC_JSON_DIR || '/opt/sodhaniScrap/output';
  const consolidatedDir = process.env.CONSOLIDATED_JSON_DIR || '/opt/sodhaniScrap/output_consolidated';
  const splitDir = process.env.OUTPUT_SPLIT_DIR || '/opt/sodhaniScrap/output_split';
  const checkpointPath = process.env.SPLIT_CHECKPOINT_PATH || '/opt/sodhaniScrap/split_checkpoint.json';

  splitCompanyData({ outputDir, consolidatedDir, splitDir, checkpointPath })
    .then((result) => {
      console.log(
        `Finished. processed=${result.processed.length} skipped=${result.skipped.length} failed=${result.failed.length}`
      );
      if (result.failed.length > 0) {
        console.error('Failed companies:', result.failed);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
