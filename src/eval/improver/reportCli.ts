/**
 * Corpus scoreboard CLI — `npm run eval:report [--json]`.
 * Aggregates every eval/corpus/runs/*.json (latest run per case) into per-tier
 * pass-rates and the headline tool-defect rate.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildReport, renderReport, type RunForReport } from './report.js';
import { loadJsonRecords } from './corpusIO.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadLatestPerCase(): RunForReport[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  const records = loadJsonRecords(
    dir,
    (r): r is RunForReport & { run_id: string } =>
      r != null && typeof r === 'object' &&
      !!(r as any).case_id && typeof (r as any).classification === 'string',
  );
  const latest = new Map<string, RunForReport & { run_id: string }>();
  for (const r of records) {
    const prev = latest.get(r.case_id);
    if (!prev || r.run_id > prev.run_id) latest.set(r.case_id, r);
  }
  return [...latest.values()];
}

const asJson = process.argv.includes('--json');
const report = buildReport(loadLatestPerCase());
console.log(asJson ? JSON.stringify(report, null, 2) : renderReport(report));
