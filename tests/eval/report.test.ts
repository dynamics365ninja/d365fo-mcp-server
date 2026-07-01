/**
 * Corpus scoreboard aggregation.
 */

import { describe, it, expect } from 'vitest';
import { buildReport, renderReport, type RunForReport } from '../../src/eval/improver/report';

const run = (tier: number, cls: string, b: number, bp: number, g: number): RunForReport =>
  ({ case_id: `L${tier}-x${Math.random()}`, tier, classification: cls, score: { build: b, bp_clean: bp, golden_match: g } });

describe('buildReport', () => {
  it('computes overall and per-tier pass rates', () => {
    const r = buildReport([
      run(0, 'PASS', 1, 1, 1),
      run(0, 'KNOWLEDGE_GAP', 1, 0, 1),
      run(2, 'TOOL_DEFECT', 1, 1, 0),
    ]);
    expect(r.total).toBe(3);
    expect(r.pass_at_build).toBe(1);
    expect(r.pass_at_bp_clean).toBeCloseTo(2 / 3);
    expect(r.pass_at_golden).toBeCloseTo(2 / 3);
    const t0 = r.byTier.find(t => t.tier === 0)!;
    expect(t0.count).toBe(2);
    expect(t0.pass_at_bp_clean).toBe(0.5);
    const t2 = r.byTier.find(t => t.tier === 2)!;
    expect(t2.pass_at_golden).toBe(0);
  });

  it('tool-defect rate counts only actionable classes', () => {
    const r = buildReport([
      run(0, 'PASS', 1, 1, 1),
      run(0, 'TOOL_DEFECT', 1, 1, 0),
      run(0, 'VALIDATOR_GAP', 1, 1, 0),
      run(0, 'ENV_FLAKE', 0, 0, 0),
    ]);
    // 2 actionable of 4
    expect(r.toolDefectRate).toBe(0.5);
    expect(r.classificationCounts.TOOL_DEFECT).toBe(1);
    expect(r.classificationCounts.PASS).toBe(1);
  });

  it('handles an empty corpus', () => {
    const r = buildReport([]);
    expect(r.total).toBe(0);
    expect(r.toolDefectRate).toBe(0);
    expect(renderReport(r)).toContain('No corpus runs');
  });
});

describe('renderReport', () => {
  it('renders tier rows and the tool-defect rate', () => {
    const out = renderReport(buildReport([run(1, 'TOOL_DEFECT', 1, 0, 1)]));
    expect(out).toContain('L1');
    expect(out).toContain('tool-defect rate');
    expect(out).toContain('golden=100%');
  });
});
