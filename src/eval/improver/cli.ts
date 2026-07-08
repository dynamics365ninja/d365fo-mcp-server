/**
 * Improver CLI — summarise the corpus into ranked failure clusters.
 *
 *   tsx src/eval/improver/cli.ts [--all] [--json]
 *
 * Reads every eval/corpus/runs/*.json and prints the actionable
 * (TOOL_DEFECT/KNOWLEDGE_GAP/VALIDATOR_GAP) clusters ranked by frequency ×
 * tier_weight — the input a human/agent uses to pick the next fix.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { clusterRuns, renderClusters, type CorpusRun } from './cluster.js';
import { loadJsonRecords } from './corpusIO.js';
import {
  aggregateBySplit, renderSplitReport, type ScoredCase, type Split,
} from './heldout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

interface CorpusRunFull extends CorpusRun {
  score?: CorpusRun['score'] & { build?: number; bp_clean?: number; golden_match?: number };
}

function loadRuns(): CorpusRunFull[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  return loadJsonRecords(
    dir,
    (r): r is CorpusRunFull => r != null && typeof r === 'object' && typeof (r as CorpusRunFull).classification === 'string',
  );
}

/** Map case id → split, read from the case specs (default holdout). */
function caseSplits(): Map<string, Split> {
  const dir = path.join(REPO_ROOT, 'eval', 'cases');
  const m = new Map<string, Split>();
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (spec.id) m.set(spec.id, spec.split === 'train' ? 'train' : 'holdout');
    } catch { /* skip */ }
  }
  return m;
}

/** Latest run per case → ScoredCase (split-aware) for the scoreboard. */
function latestScoredCases(runs: CorpusRunFull[], splits: Map<string, Split>): ScoredCase[] {
  const latest = new Map<string, CorpusRunFull>();
  for (const r of runs) {
    const prev = latest.get(r.case_id);
    if (!prev || r.run_id > prev.run_id) latest.set(r.case_id, r);
  }
  return [...latest.values()].map(r => ({
    caseId: r.case_id,
    split: splits.get(r.case_id) ?? 'holdout',
    score: {
      build: r.score?.build ?? 0,
      bp_clean: r.score?.bp_clean ?? 0,
      golden_match: r.score?.golden_match ?? 0,
    },
  }));
}

const includeAll = process.argv.includes('--all');
const asJson = process.argv.includes('--json');
const runs = loadRuns();
const clusters = clusterRuns(runs, includeAll);
const scored = latestScoredCases(runs, caseSplits());
const splitAgg = aggregateBySplit(scored);

if (asJson) {
  console.log(JSON.stringify({ clusters, splitScores: splitAgg }, null, 2));
} else {
  console.log(`Loaded ${runs.length} corpus run(s).\n`);
  console.log(renderSplitReport(splitAgg));
  console.log('');
  console.log(renderClusters(clusters));
}
