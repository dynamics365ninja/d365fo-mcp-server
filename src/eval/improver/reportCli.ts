/**
 * Corpus scoreboard CLI — `npm run eval:report [--json]`.
 * Aggregates every eval/corpus/runs/*.json (latest run per case) into per-tier
 * pass-rates and the headline tool-defect rate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildReport, renderReport, type RunForReport } from './report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadLatestPerCase(): RunForReport[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  if (!fs.existsSync(dir)) return [];
  const latest = new Map<string, RunForReport & { run_id: string }>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!r.case_id || typeof r.classification !== 'string') continue;
      const prev = latest.get(r.case_id);
      if (!prev || r.run_id > prev.run_id) latest.set(r.case_id, r);
    } catch { /* skip */ }
  }
  return [...latest.values()];
}

const asJson = process.argv.includes('--json');
const report = buildReport(loadLatestPerCase());
console.log(asJson ? JSON.stringify(report, null, 2) : renderReport(report));
