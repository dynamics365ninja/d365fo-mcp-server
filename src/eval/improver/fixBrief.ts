/**
 * Fix brief generator (docs/AGENT_EVAL_LOOP.md §10, "Autonomous improver"). VM-free.
 *
 * Turns the TOP-PRIORITY actionable cluster (from cluster.ts) into a
 * self-contained Markdown brief: symptom, root cause, evidence, and a concrete
 * task list. This is the hand-off artifact between the two halves of the
 * autonomous-improver idea:
 *
 *   VM half (this repo, interactive session)      VM-free half (CI runner)
 *   ─────────────────────────────────────────     ──────────────────────────
 *   run cases on the D365FO VM → corpus records    reproduce as a failing repo
 *   → `npm run eval:brief` picks the top   ──brief──▶  test → fix → `npx vitest
 *   cluster and writes this brief                  run` + held-out gate → PR
 *
 * The corpus (`eval/corpus/runs/`) is gitignored — it never reaches a CI
 * runner's checkout. So a brief is the thing that DOES cross that boundary:
 * generate it locally (where the corpus lives), then hand it to
 * `.github/workflows/eval-improver.yml` (workflow_dispatch input) to run the
 * reproduce→fix→test→PR loop, which needs only the repo + toolchain, not the
 * VM. This module only builds the text; it never applies a fix itself.
 */

import { clusterRuns, type CorpusRun, type Cluster } from './cluster.js';

/** A corpus record with the evidence fields a brief needs (superset of CorpusRun). */
export interface FixBriefRun extends CorpusRun {
  timestamp?: string;
  evidence_refs?: string[];
}

/** Pick the most informative run in a cluster: richest root_cause_hypothesis, most recent as tiebreak. */
function representativeRun(cluster: Cluster, runs: FixBriefRun[]): FixBriefRun | undefined {
  const inCluster = runs.filter(r => cluster.runIds.includes(r.run_id));
  if (inCluster.length === 0) return undefined;
  return [...inCluster].sort((a, b) => {
    const lenDiff = (b.root_cause_hypothesis?.length ?? 0) - (a.root_cause_hypothesis?.length ?? 0);
    if (lenDiff !== 0) return lenDiff;
    return (b.timestamp ?? b.run_id).localeCompare(a.timestamp ?? a.run_id);
  })[0];
}

/** The single highest-priority actionable cluster, or null if the corpus is clean. */
export function topPriorityCluster(runs: CorpusRun[]): Cluster | null {
  const clusters = clusterRuns(runs, false);
  return clusters[0] ?? null;
}

/** Render one cluster + its representative evidence as a self-contained Markdown brief. */
export function renderFixBrief(cluster: Cluster, runs: FixBriefRun[]): string {
  const rep = representativeRun(cluster, runs);
  const lines: string[] = [
    `# Fix brief: [${cluster.classification}] ${cluster.symptom}`,
    '',
    `Priority: ${cluster.priority}  (frequency=${cluster.frequency} × max tier_weight)`,
    `Affected cases: ${cluster.caseIds.join(', ')}`,
    `Corpus run(s): ${cluster.runIds.join(', ')}`,
    '',
    '## Root cause',
    rep?.root_cause_hypothesis?.trim() || '(no root_cause_hypothesis recorded on the representative run)',
    '',
    '## Suggested fix area',
    rep?.suggested_fix_area?.trim() || '(none recorded — investigate from the root cause above)',
  ];
  if (rep?.evidence_refs?.length) {
    lines.push('', '## Evidence', ...rep.evidence_refs.map(e => `- ${e}`));
  }
  lines.push(
    '',
    '## Task',
    '1. Reproduce this as a minimal FAILING test under `tests/` (mirroring the root cause above) — a real server-side gap must be demonstrable without the D365FO VM.',
    '2. Fix the root cause in `src/`.',
    '3. Run `npx vitest run` — the full suite must pass, including the new regression test.',
    '4. Run `npm run eval:clusters` against the corpus (if available) and confirm this symptom no longer ranks — or note that the corpus is VM-side evidence not present in this checkout, and the regression test is the durable proof instead.',
    '5. Open a PR citing this brief. Do NOT merge — a human reviews and merges.',
  );
  return lines.join('\n');
}

/** Build the brief for the single top-priority cluster, or null if the corpus has nothing actionable. */
export function buildTopFixBrief(runs: FixBriefRun[]): string | null {
  const top = topPriorityCluster(runs);
  if (!top) return null;
  return renderFixBrief(top, runs);
}
