/**
 * Corpus evidence-shape guard (docs/AGENT_EVAL_LOOP.md §5).
 *
 * Regression: eval/corpus/runs/2026-07-06T16__L0-enum-basic__cc58c3f.json,
 * eval/corpus/runs/2026-07-07T07__L2-interface-abstract-basic__cb1b73d.json, and
 * eval/corpus/runs/2026-07-07T16__L4-ssrs-report-advanced__cb1b73d.json (x2,
 * the "4-controller"/"5-menuitem" sub-artifacts) were all classified
 * KNOWLEDGE_GAP purely because `score.bp_clean === 0`, yet `build.bpWarnings`
 * is populated with literal `{}` placeholders — the corpus's OWN
 * self-contained-evidence contract (§5) was violated with nothing to catch
 * it. Fixtures below are the actual recorded shapes (trimmed to the
 * fields under test) from those four runs.
 */

import { describe, it, expect } from 'vitest';
import { findThinEvidence, hasThinEvidence, isUnconfirmable } from '../../src/eval/improver/corpusShapeGuard';

describe('findThinEvidence / hasThinEvidence', () => {
  it('flags every empty-object entry in build.bpWarnings (regression: L0-enum-basic)', () => {
    const record = {
      run_id: '2026-07-06T16__L0-enum-basic__cc58c3f',
      case_id: 'L0-enum-basic',
      classification: 'KNOWLEDGE_GAP',
      build: { succeeded: true, errors: [], bpWarnings: [{}] },
      golden_diff: { matched: true, missing: [], extra: [], changed: [] },
      score: { build: 1, bp_clean: 0, golden_match: 1, systest: null, tier_weight: 0 },
    };
    expect(hasThinEvidence(record)).toBe(true);
    expect(findThinEvidence(record)).toEqual([
      { path: 'build.bpWarnings[0]', reason: expect.stringContaining('empty object') },
    ]);
  });

  it('flags multiple thin entries (regression: L2-interface-abstract-basic, 3 empty bpWarnings)', () => {
    const record = {
      run_id: '2026-07-07T07__L2-interface-abstract-basic__cb1b73d',
      case_id: 'L2-interface-abstract-basic',
      classification: 'KNOWLEDGE_GAP',
      build: { succeeded: true, errors: [], bpWarnings: [{}, {}, {}] },
      golden_diff: { matched: true, missing: [], extra: [], changed: [] },
      score: { build: 1, bp_clean: 0, golden_match: 1, systest: null, tier_weight: 2 },
    };
    const issues = findThinEvidence(record);
    expect(issues.map(i => i.path)).toEqual([
      'build.bpWarnings[0]', 'build.bpWarnings[1]', 'build.bpWarnings[2]',
    ]);
  });

  it('an EMPTY ARRAY is fine — zero warnings is a real, meaningful result, not thin evidence', () => {
    const record = {
      run_id: 'x', case_id: 'x', classification: 'PASS',
      build: { succeeded: true, errors: [], bpWarnings: [] },
      golden_diff: { matched: true, missing: [], extra: [], changed: [] },
      score: { build: 1, bp_clean: 1, golden_match: 1, systest: null, tier_weight: 1 },
    };
    expect(hasThinEvidence(record)).toBe(false);
  });

  it('a well-formed bpWarnings entry with real content is not flagged (regression control: L2-business-event-basic)', () => {
    const record = {
      run_id: 'x', case_id: 'L2-business-event-basic', classification: 'TOOL_DEFECT',
      build: {
        succeeded: true,
        errors: [],
        bpWarnings: [
          { message: "BestPractices Warning: AxClass X/Method/y: BPXmlDocNoDocumentationComments: No XML documentation headers are provided for 'X.y'." },
        ],
      },
      golden_diff: { matched: false, missing: [], extra: [], changed: [{ path: 'a/b', expected: '1', actual: '2' }] },
      score: { build: 1, bp_clean: 0, golden_match: 0, systest: null, tier_weight: 2 },
    };
    expect(hasThinEvidence(record)).toBe(false);
  });

  it('also flags thin entries in golden_diff.changed and systest.failures', () => {
    const record = {
      run_id: 'x', case_id: 'x', classification: 'VALIDATOR_GAP',
      build: { succeeded: true, errors: [], bpWarnings: [] },
      golden_diff: { matched: false, missing: [], extra: [], changed: [{}] },
      systest: { ran: true, passed: false, failures: [{}] },
      score: { build: 1, bp_clean: 1, golden_match: 0, systest: 0, tier_weight: 1 },
    };
    const paths = findThinEvidence(record).map(i => i.path);
    expect(paths).toEqual(expect.arrayContaining(['golden_diff.changed[0]', 'systest.failures[0]']));
  });
});

describe('isUnconfirmable', () => {
  it('a bp_clean=0 record with only thin bpWarnings AND no hypothesis/evidence_refs is unconfirmable (regression: L4-ssrs-report-advanced 4-controller/5-menuitem)', () => {
    const record = {
      run_id: '2026-07-07T16__L4-ssrs-report-advanced__cb1b73d',
      case_id: 'L4-ssrs-report-advanced',
      classification: 'KNOWLEDGE_GAP',
      build: { succeeded: true, errors: [], bpWarnings: [{}] },
      golden_diff: { matched: true, missing: [], extra: [], changed: [] },
      score: { build: 1, bp_clean: 0, golden_match: 1, systest: null, tier_weight: 4 },
    };
    expect(isUnconfirmable(record)).toBe(true);
  });

  it('PASS records are never unconfirmable regardless of shape', () => {
    expect(isUnconfirmable({ classification: 'PASS', score: { bp_clean: 0 }, build: { bpWarnings: [{}] } })).toBe(false);
  });

  it('a record WITH a root_cause_hypothesis is NOT unconfirmable even with thin bpWarnings — the improver has something to act on', () => {
    const record = {
      run_id: 'x', case_id: 'x', classification: 'TOOL_DEFECT',
      build: { succeeded: true, errors: [], bpWarnings: [{}] },
      golden_diff: { matched: false, missing: [], extra: [], changed: [{ path: 'a', expected: '1', actual: '2' }] },
      score: { build: 1, bp_clean: 0, golden_match: 0, systest: null, tier_weight: 2 },
      root_cause_hypothesis: 'the generator omitted X',
    };
    expect(isUnconfirmable(record)).toBe(false);
  });

  it('golden_match=0 explained by missing/extra (not changed) is NOT the thin-"changed" case, even with an empty changed[]', () => {
    const record = {
      run_id: 'x', case_id: 'L1-table-basic', classification: 'TOOL_DEFECT',
      build: { succeeded: true, errors: [], bpWarnings: [] },
      golden_diff: { matched: false, missing: ['A/B'], extra: [], changed: [] },
      score: { build: 1, bp_clean: 1, golden_match: 0, systest: null, tier_weight: 1 },
    };
    // golden_diff.missing has real content — golden_match=0 IS explained (by `missing`,
    // not thin `changed` entries), so this is NOT the "total loss" case.
    expect(isUnconfirmable(record)).toBe(false);
  });

  it('bp_clean=0 with thin bpWarnings makes a record unconfirmable even when golden_match independently passed', () => {
    const record = {
      run_id: 'x', case_id: 'L1-table-basic', classification: 'TOOL_DEFECT',
      build: { succeeded: true, errors: [], bpWarnings: [{}, {}] },
      golden_diff: { matched: true, missing: [], extra: [], changed: [] },
      score: { build: 1, bp_clean: 0, golden_match: 1, systest: null, tier_weight: 1 },
    };
    // The bp_clean=0 signal has zero recoverable detail — that dimension of the
    // classification cannot be confirmed, regardless of golden_match.
    expect(isUnconfirmable(record)).toBe(true);
    expect(hasThinEvidence(record)).toBe(true);
  });
});
