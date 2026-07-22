/**
 * Train/holdout split aggregation + anti-overfitting regression gate.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregate,
  aggregateBySplit,
  holdoutRegressed,
  renderSplitReport,
  type ScoredCase,
} from '../../src/eval/improver/heldout';

// `bpChecked: true` = the capture actually ran xppbp. Since the 2026-07-22
// scoring-integrity fix (#3) an unchecked run is excluded from pass_at_bp_clean
// rather than counted as clean.
const sc = (caseId: string, split: 'train' | 'holdout', b: number, bp: number, g: number): ScoredCase =>
  ({ caseId, split, score: { build: b, bp_clean: bp, golden_match: g }, bpChecked: true });

describe('aggregate', () => {
  it('computes pass fractions per metric', () => {
    const a = aggregate([sc('a', 'train', 1, 1, 1), sc('b', 'train', 1, 0, 0)]);
    expect(a.count).toBe(2);
    expect(a.pass_at_build).toBe(1);
    expect(a.pass_at_bp_clean).toBe(0.5);
    expect(a.pass_at_golden).toBe(0.5);
  });

  it('is 0 (not NaN) for an empty set — and bp is null, since nothing was measured', () => {
    expect(aggregate([])).toEqual({ count: 0, pass_at_build: 0, pass_at_bp_clean: null, pass_at_golden: 0 });
  });

  it('excludes BP-unverified cases from the BP rate instead of counting them clean (#3)', () => {
    const a = aggregate([
      sc('a', 'train', 1, 1, 1),
      { caseId: 'b', split: 'train', score: { build: 1, bp_clean: 1, golden_match: 1 } }, // legacy: unverifiable
      { caseId: 'c', split: 'train', score: { build: 1, bp_clean: null, golden_match: 1 } }, // BP not run
    ]);
    expect(a.count).toBe(3);
    expect(a.pass_at_bp_clean).toBe(1); // 1 of 1 VERIFIED case, not 2 of 3
  });

  it('holdoutRegressed skips a metric that was not measured on either side', () => {
    const unmeasured = { count: 1, pass_at_build: 1, pass_at_bp_clean: null, pass_at_golden: 1 };
    const measured = { count: 1, pass_at_build: 1, pass_at_bp_clean: 1, pass_at_golden: 1 };
    expect(holdoutRegressed(measured, unmeasured).ok).toBe(true);
    expect(holdoutRegressed(unmeasured, measured).ok).toBe(true);
  });
});

describe('aggregateBySplit', () => {
  it('partitions train and holdout', () => {
    const agg = aggregateBySplit([
      sc('a', 'train', 1, 1, 1),
      sc('b', 'holdout', 1, 1, 0),
    ]);
    expect(agg.train.count).toBe(1);
    expect(agg.holdout.count).toBe(1);
    expect(agg.holdout.pass_at_golden).toBe(0);
  });
});

describe('holdoutRegressed', () => {
  const base = { count: 2, pass_at_build: 1, pass_at_bp_clean: 0.5, pass_at_golden: 1 };

  it('passes when every metric ties or improves', () => {
    const r = holdoutRegressed(base, { count: 2, pass_at_build: 1, pass_at_bp_clean: 1, pass_at_golden: 1 });
    expect(r.ok).toBe(true);
    expect(r.regressions).toEqual([]);
  });

  it('fails when any holdout metric drops', () => {
    const r = holdoutRegressed(base, { count: 2, pass_at_build: 1, pass_at_bp_clean: 0.5, pass_at_golden: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.regressions).toEqual([{ metric: 'pass_at_golden', baseline: 1, candidate: 0.5 }]);
  });

  it('tolerates a drop within epsilon', () => {
    const r = holdoutRegressed(base, { count: 2, pass_at_build: 0.95, pass_at_bp_clean: 0.5, pass_at_golden: 1 }, 0.1);
    expect(r.ok).toBe(true);
  });
});

describe('renderSplitReport', () => {
  it('renders train and holdout rows as percentages', () => {
    const out = renderSplitReport(aggregateBySplit([sc('a', 'train', 1, 1, 1), sc('b', 'holdout', 1, 0, 0)]));
    expect(out).toContain('train');
    expect(out).toContain('holdout');
    expect(out).toContain('golden=100%');
    expect(out).toContain('golden=0%');
  });
});
