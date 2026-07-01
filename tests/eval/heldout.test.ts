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

const sc = (caseId: string, split: 'train' | 'holdout', b: number, bp: number, g: number): ScoredCase =>
  ({ caseId, split, score: { build: b, bp_clean: bp, golden_match: g } });

describe('aggregate', () => {
  it('computes pass fractions per metric', () => {
    const a = aggregate([sc('a', 'train', 1, 1, 1), sc('b', 'train', 1, 0, 0)]);
    expect(a.count).toBe(2);
    expect(a.pass_at_build).toBe(1);
    expect(a.pass_at_bp_clean).toBe(0.5);
    expect(a.pass_at_golden).toBe(0.5);
  });

  it('is 0 (not NaN) for an empty set', () => {
    expect(aggregate([])).toEqual({ count: 0, pass_at_build: 0, pass_at_bp_clean: 0, pass_at_golden: 0 });
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
