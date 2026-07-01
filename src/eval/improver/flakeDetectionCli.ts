/**
 * Flake detection CLI — print same-sha score disagreements across corpus runs
 * (docs/AGENT_EVAL_LOOP.md §9). VM-free.
 *
 *   tsx src/eval/improver/flakeDetectionCli.ts [--json]
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectFlakeCandidates, renderFlakeCandidates, type FlakeCorpusRun } from './flakeDetection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadRuns(): FlakeCorpusRun[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as FlakeCorpusRun; }
      catch { return null; }
    })
    .filter((r): r is FlakeCorpusRun => r != null && typeof r.run_id === 'string');
}

const asJson = process.argv.includes('--json');
const runs = loadRuns();
const candidates = detectFlakeCandidates(runs);

if (asJson) {
  console.log(JSON.stringify(candidates, null, 2));
} else {
  console.log(`Loaded ${runs.length} corpus run(s).\n`);
  console.log(renderFlakeCandidates(candidates));
}
