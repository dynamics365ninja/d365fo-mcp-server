/**
 * Fix brief CLI — print (or write) the top-priority actionable cluster's fix
 * brief, the hand-off artifact for the eval-improver GitHub Actions workflow
 * (docs/AGENT_EVAL_LOOP.md §10). VM-free.
 *
 *   tsx src/eval/improver/fixBriefCli.ts [--out file.md] [--all]
 *
 * --all prints a brief for every actionable cluster, not just the top one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { clusterRuns } from './cluster.js';
import { renderFixBrief, buildTopFixBrief, type FixBriefRun } from './fixBrief.js';
import { loadJsonRecords } from './corpusIO.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadRuns(): FixBriefRun[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  return loadJsonRecords(
    dir,
    (r): r is FixBriefRun => r != null && typeof r === 'object' && typeof (r as FixBriefRun).classification === 'string',
  );
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const runs = loadRuns();
const all = process.argv.includes('--all');

let output: string;
if (all) {
  const clusters = clusterRuns(runs, false);
  output = clusters.length === 0
    ? 'No actionable failure clusters — corpus is clean. 🎉'
    : clusters.map(c => renderFixBrief(c, runs)).join('\n\n---\n\n');
} else {
  output = buildTopFixBrief(runs) ?? 'No actionable failure clusters — corpus is clean. 🎉';
}

const outFile = arg('--out');
if (outFile) {
  fs.writeFileSync(outFile, output + '\n');
  console.error(`Wrote brief to ${outFile}`);
} else {
  console.log(output);
}
