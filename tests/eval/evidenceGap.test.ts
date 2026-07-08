/**
 * Evidence-gap report building/rendering (docs/AGENT_EVAL_LOOP.md §5, §9).
 * VM-free — see src/eval/improver/evidenceGapCli.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildEvidenceGapReport, renderEvidenceGapReport } from '../../src/eval/improver/evidenceGap';

describe('buildEvidenceGapReport', () => {
  it('is empty for a corpus with no thin evidence', () => {
    const runs = [
      { run_id: 'a', case_id: 'A', tier: 1, classification: 'PASS', build: { succeeded: true, bpWarnings: [] } },
    ];
    expect(buildEvidenceGapReport(runs as any)).toEqual([]);
  });

  it('surfaces unconfirmable runs first, then confirmable-but-partially-thin ones, sorted by case_id', () => {
    const runs = [
      {
        run_id: 'z-run', case_id: 'Z-case', classification: 'TOOL_DEFECT',
        build: { succeeded: true, bpWarnings: [{ message: 'a real warning' }, {}] },
        golden_diff: { matched: false, missing: ['x'], extra: [], changed: [] },
        score: { bp_clean: 0, golden_match: 0 },
      },
      {
        run_id: 'a-run', case_id: 'A-case', classification: 'KNOWLEDGE_GAP',
        build: { succeeded: true, bpWarnings: [{}] },
        golden_diff: { matched: true, missing: [], extra: [], changed: [] },
        score: { bp_clean: 0, golden_match: 1 },
      },
    ];
    const report = buildEvidenceGapReport(runs as any);
    expect(report.map(r => r.case_id)).toEqual(['A-case', 'Z-case']);
    expect(report[0].unconfirmable).toBe(true); // A-case: no hypothesis, thin bpWarnings, nothing else to go on
    expect(report[1].unconfirmable).toBe(false); // Z-case: golden_diff.missing gives a real, confirmable signal
  });
});

describe('renderEvidenceGapReport', () => {
  it('renders the all-clear message when there are no gaps', () => {
    expect(renderEvidenceGapReport([])).toContain('No thin-evidence');
  });

  it('renders unconfirmable entries with an explanatory banner and per-issue detail', () => {
    const report = buildEvidenceGapReport([
      {
        run_id: 'r1', case_id: 'C1', classification: 'KNOWLEDGE_GAP',
        build: { succeeded: true, bpWarnings: [{}] },
        golden_diff: { matched: true, missing: [], extra: [], changed: [] },
        score: { bp_clean: 0, golden_match: 1 },
      },
    ] as any);
    const text = renderEvidenceGapReport(report);
    expect(text).toContain('UNCONFIRMABLE');
    expect(text).toContain('C1');
    expect(text).toContain('build.bpWarnings[0]');
    expect(text).toContain('fresh eval-implementer VM run');
  });
});
