/**
 * Evidence-gap CLI — list corpus records whose classification cannot be
 * confirmed because their evidence-carrying arrays are thin/empty
 * (docs/AGENT_EVAL_LOOP.md §5, §9). VM-free.
 *
 *   tsx src/eval/improver/evidenceGapCli.ts [--json]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadJsonRecords } from './corpusIO.js';
import { buildEvidenceGapReport, renderEvidenceGapReport, type CorpusRunLike } from './evidenceGap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadRuns(): CorpusRunLike[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  return loadJsonRecords(
    dir,
    (r): r is CorpusRunLike => r != null && typeof r === 'object' && typeof (r as CorpusRunLike).classification === 'string',
  );
}

const asJson = process.argv.includes('--json');
const runs = loadRuns();
const report = buildEvidenceGapReport(runs);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Loaded ${runs.length} corpus run(s).\n`);
  console.log(renderEvidenceGapReport(report));
}
