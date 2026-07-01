/**
 * Train/holdout split + anti-overfitting regression gate (docs/AGENT_EVAL_LOOP.md §10).
 *
 * A fix is accepted only if **holdout** scores do not regress — improvements
 * tuned to the cases they were derived from (train) don't count. New cases enter
 * the holdout set first, so a fix cannot be overfit to them.
 *
 * Pure + VM-free: callers supply already-scored cases (from the oracle / corpus).
 */

export type Split = 'train' | 'holdout';

export interface ScoredCase {
  caseId: string;
  split: Split;
  score: { build: number; bp_clean: number; golden_match: number };
}

export interface SplitAggregate {
  count: number;
  /** Fractions in [0,1]. */
  pass_at_build: number;
  pass_at_bp_clean: number;
  pass_at_golden: number;
}

function frac(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

export function aggregate(cases: ScoredCase[]): SplitAggregate {
  const count = cases.length;
  return {
    count,
    pass_at_build: frac(cases.filter(c => c.score.build === 1).length, count),
    pass_at_bp_clean: frac(cases.filter(c => c.score.bp_clean === 1).length, count),
    pass_at_golden: frac(cases.filter(c => c.score.golden_match === 1).length, count),
  };
}

export function aggregateBySplit(cases: ScoredCase[]): Record<Split, SplitAggregate> {
  return {
    train: aggregate(cases.filter(c => c.split === 'train')),
    holdout: aggregate(cases.filter(c => c.split === 'holdout')),
  };
}

export interface RegressionResult {
  ok: boolean;
  regressions: Array<{ metric: keyof Omit<SplitAggregate, 'count'>; baseline: number; candidate: number }>;
}

const METRICS: Array<keyof Omit<SplitAggregate, 'count'>> = [
  'pass_at_build', 'pass_at_bp_clean', 'pass_at_golden',
];

/**
 * Compare a candidate holdout aggregate against a baseline. Fails if any metric
 * drops by more than `epsilon` (default 0 — no regression tolerated). A candidate
 * that improves or ties on every metric passes.
 */
export function holdoutRegressed(
  baseline: SplitAggregate,
  candidate: SplitAggregate,
  epsilon = 0,
): RegressionResult {
  const regressions: RegressionResult['regressions'] = [];
  for (const m of METRICS) {
    if (candidate[m] < baseline[m] - epsilon) {
      regressions.push({ metric: m, baseline: baseline[m], candidate: candidate[m] });
    }
  }
  return { ok: regressions.length === 0, regressions };
}

export function renderSplitReport(agg: Record<Split, SplitAggregate>): string {
  const row = (name: string, a: SplitAggregate) =>
    `  ${name.padEnd(8)} n=${a.count}  build=${pct(a.pass_at_build)}  bp=${pct(a.pass_at_bp_clean)}  golden=${pct(a.pass_at_golden)}`;
  return ['# Scores by split', row('train', agg.train), row('holdout', agg.holdout)].join('\n');
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}
