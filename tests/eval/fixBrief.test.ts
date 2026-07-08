/**
 * Fix brief generator — the corpus-to-CI hand-off artifact for the autonomous improver.
 */

import { describe, it, expect } from 'vitest';
import { topPriorityCluster, renderFixBrief, buildTopFixBrief, type FixBriefRun } from '../../src/eval/improver/fixBrief';

function run(overrides: Partial<FixBriefRun>): FixBriefRun {
  return {
    run_id: 'r1', case_id: 'L1-table-basic', tier: 1, classification: 'TOOL_DEFECT',
    ...overrides,
  };
}

describe('topPriorityCluster', () => {
  it('returns null when the corpus has no actionable runs', () => {
    expect(topPriorityCluster([run({ classification: 'PASS' })])).toBeNull();
  });

  it('returns the highest-priority actionable cluster', () => {
    const runs: FixBriefRun[] = [
      run({ run_id: 'a1', tier: 1, classification: 'TOOL_DEFECT', root_cause_hypothesis: 'low priority issue' }),
      run({ run_id: 'b1', tier: 4, classification: 'TOOL_DEFECT', root_cause_hypothesis: 'high priority issue' }),
      run({ run_id: 'b2', tier: 4, classification: 'TOOL_DEFECT', root_cause_hypothesis: 'high priority issue' }),
    ];
    const top = topPriorityCluster(runs);
    expect(top?.symptom).toMatch(/high priority issue/);
    expect(top?.frequency).toBe(2);
  });
});

describe('renderFixBrief', () => {
  it('includes symptom, root cause, fix area, evidence, and a task list', () => {
    const runs: FixBriefRun[] = [
      run({
        run_id: 'r1',
        root_cause_hypothesis: 'bridge dropped EntryPoints on security-privilege create',
        suggested_fix_area: 'src/bridge/bridgeAdapter.ts BRIDGE_CREATE_TYPES',
        evidence_refs: ['eval/goldens/L4-entity-security/ConDemoNoteHeaderMaintain.metadata.xml'],
      }),
    ];
    const cluster = topPriorityCluster(runs)!;
    const brief = renderFixBrief(cluster, runs);

    expect(brief).toContain('bridge dropped EntryPoints on security-privilege create');
    expect(brief).toContain('src/bridge/bridgeAdapter.ts BRIDGE_CREATE_TYPES');
    expect(brief).toContain('eval/goldens/L4-entity-security/ConDemoNoteHeaderMaintain.metadata.xml');
    expect(brief).toMatch(/## Task/);
    expect(brief).toMatch(/Do NOT merge/);
  });

  it('picks the run with the richest root_cause_hypothesis as representative', () => {
    // Both share the same leading clause (before the first period) so cluster.ts's
    // symptomOf() groups them into ONE cluster — this exercises tie-breaking
    // between two runs of the SAME symptom, not two different symptoms.
    const runs: FixBriefRun[] = [
      run({ run_id: 'r1', root_cause_hypothesis: 'Bridge dropped EntryPoints on privilege create.' }),
      run({
        run_id: 'r2',
        root_cause_hypothesis: 'Bridge dropped EntryPoints on privilege create. Full analysis with much more detail follows here.',
      }),
    ];
    const cluster = topPriorityCluster(runs)!;
    expect(cluster.frequency).toBe(2);
    const brief = renderFixBrief(cluster, runs);
    expect(brief).toContain('Full analysis with much more detail follows here');
  });

  it('falls back to a placeholder when evidence fields are missing', () => {
    const runs: FixBriefRun[] = [run({ run_id: 'r1' })];
    const cluster = topPriorityCluster(runs)!;
    const brief = renderFixBrief(cluster, runs);
    expect(brief).toMatch(/no root_cause_hypothesis recorded/);
  });
});

describe('buildTopFixBrief', () => {
  it('returns null for a clean corpus', () => {
    expect(buildTopFixBrief([run({ classification: 'PASS' })])).toBeNull();
  });

  it('returns a brief for the top cluster otherwise', () => {
    const brief = buildTopFixBrief([run({ root_cause_hypothesis: 'x' })]);
    expect(brief).toContain('# Fix brief');
  });
});
