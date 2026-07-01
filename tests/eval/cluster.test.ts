/**
 * Improver corpus clustering — pure ranking logic with inline run fixtures.
 */

import { describe, it, expect } from 'vitest';
import { clusterRuns, symptomOf, renderClusters, type CorpusRun } from '../../src/eval/improver/cluster';

const run = (over: Partial<CorpusRun>): CorpusRun => ({
  run_id: Math.random().toString(36).slice(2),
  case_id: 'L0-x',
  tier: 0,
  classification: 'TOOL_DEFECT',
  score: { tier_weight: 0 },
  ...over,
});

describe('symptomOf', () => {
  it('prefers the root-cause clause, truncated at the first sentence break', () => {
    expect(symptomOf(run({
      root_cause_hypothesis: 'bridge dropped the EDT key. Field became bare String.',
      suggested_fix_area: 'normalizeFieldSpecsForBridge',
    }))).toBe('bridge dropped the EDT key');
  });
  it('strips leading status markers like FIXED: and (1)', () => {
    expect(symptomOf(run({ root_cause_hypothesis: '', suggested_fix_area: 'FIXED: normalize keys now emit type/edt' })))
      .toBe('normalize keys now emit type/edt');
    expect(symptomOf(run({ root_cause_hypothesis: '(1) XML001 false-positive on extensions' })))
      .toBe('XML001 false-positive on extensions');
  });
  it('falls back to classification when nothing else is present', () => {
    expect(symptomOf(run({ suggested_fix_area: '', root_cause_hypothesis: '', classification: 'VALIDATOR_GAP' })))
      .toBe('VALIDATOR_GAP');
  });
});

describe('clusterRuns', () => {
  it('excludes non-actionable classes by default (PASS/MODEL_ERROR/ENV_FLAKE)', () => {
    const clusters = clusterRuns([
      run({ classification: 'PASS' }),
      run({ classification: 'MODEL_ERROR' }),
      run({ classification: 'ENV_FLAKE' }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('groups by (classification, symptom) and counts frequency', () => {
    const clusters = clusterRuns([
      run({ suggested_fix_area: 'normalizeFieldSpecsForBridge keys', case_id: 'L2-a' }),
      run({ suggested_fix_area: 'normalizeFieldSpecsForBridge keys', case_id: 'L2-b' }),
      run({ classification: 'VALIDATOR_GAP', suggested_fix_area: 'XML001 on extensions', case_id: 'L2-a' }),
    ]);
    expect(clusters).toHaveLength(2);
    const top = clusters.find(c => c.symptom === 'normalizeFieldSpecsForBridge keys')!;
    expect(top.frequency).toBe(2);
    expect(top.caseIds.sort()).toEqual(['L2-a', 'L2-b']);
  });

  it('ranks by frequency × max tier weight', () => {
    const clusters = clusterRuns([
      // one high-tier defect
      run({ classification: 'TOOL_DEFECT', suggested_fix_area: 'defect-A', score: { tier_weight: 4 } }),
      // three low-tier defects
      run({ classification: 'KNOWLEDGE_GAP', suggested_fix_area: 'gap-B', score: { tier_weight: 0 } }),
      run({ classification: 'KNOWLEDGE_GAP', suggested_fix_area: 'gap-B', score: { tier_weight: 0 } }),
      run({ classification: 'KNOWLEDGE_GAP', suggested_fix_area: 'gap-B', score: { tier_weight: 0 } }),
    ]);
    // defect-A: freq1 × tw4 = 4 ; gap-B: freq3 × max(tw,1)=1 = 3 → defect-A ranks first
    expect(clusters[0].symptom).toBe('defect-A');
    expect(clusters[0].priority).toBe(4);
    expect(clusters[1].symptom).toBe('gap-B');
    expect(clusters[1].priority).toBe(3);
  });

  it('includeAll keeps every class for reporting', () => {
    const clusters = clusterRuns([run({ classification: 'PASS', suggested_fix_area: 'none' })], true);
    expect(clusters).toHaveLength(1);
  });
});

describe('renderClusters', () => {
  it('reports a clean corpus', () => {
    expect(renderClusters([])).toContain('clean');
  });
  it('lists ranked clusters with evidence run ids', () => {
    const out = renderClusters(clusterRuns([
      run({ run_id: 'r1', suggested_fix_area: 'defect-A', score: { tier_weight: 2 } }),
    ]));
    expect(out).toContain('[TOOL_DEFECT] defect-A');
    expect(out).toContain('r1');
  });
});
