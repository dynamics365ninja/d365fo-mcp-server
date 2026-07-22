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
  score: { build: number; bp_clean: number | null; golden_match: number };
  /**
   * Did the capture actually run xppbp? `undefined` = unknown provenance (every
   * record written before the flag existed). Mirrors `bpState` in report.ts:
   * only `bp_clean === 0` proves the check ran, so an unflagged 1 is NOT
   * comparable with a checked one and is left out of `pass_at_bp_clean`
   * (docs/eval-sweep-findings-2026-07-21.md #3).
   */
  bpChecked?: boolean;
}

/** 'clean' | 'dirty' | 'unverified' — see `bpState` in report.ts. */
function bpVerified(c: ScoredCase): boolean {
  return c.bpChecked === true || c.score.bp_clean === 0;
}

export interface SplitAggregate {
  count: number;
  /** Fractions in [0,1]. */
  pass_at_build: number;
  /** Over BP-VERIFIED cases only; `null` when none carries BP evidence. */
  pass_at_bp_clean: number | null;
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
    pass_at_bp_clean: (() => {
      const verified = cases.filter(bpVerified);
      return verified.length === 0
        ? null
        : frac(verified.filter(c => c.score.bp_clean === 1).length, verified.length);
    })(),
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
    const b = baseline[m];
    const c = candidate[m];
    // A `null` side means the metric was not measured on that run — there is no
    // regression to assert, and fabricating a 0 would invent a failure.
    if (b === null || c === null) continue;
    if (c < b - epsilon) {
      regressions.push({ metric: m, baseline: b, candidate: c });
    }
  }
  return { ok: regressions.length === 0, regressions };
}

export function renderSplitReport(agg: Record<Split, SplitAggregate>): string {
  const row = (name: string, a: SplitAggregate) =>
    `  ${name.padEnd(8)} n=${a.count}  build=${pct(a.pass_at_build)}  bp=${a.pass_at_bp_clean === null ? 'n/a' : pct(a.pass_at_bp_clean)}  golden=${pct(a.pass_at_golden)}`;
  return ['# Scores by split', row('train', agg.train), row('holdout', agg.holdout)].join('\n');
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}
