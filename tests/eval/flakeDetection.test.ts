/**
 * Flake detection — same-(case, server_git_sha) score disagreement.
 */

import { describe, it, expect } from 'vitest';
import { detectFlakeCandidates, renderFlakeCandidates, type FlakeCorpusRun } from '../../src/eval/improver/flakeDetection';

function run(overrides: Partial<FlakeCorpusRun> & { score?: any }): FlakeCorpusRun {
  return {
    run_id: 'r1', case_id: 'L1-table-basic',
    server_git_sha: 'abc123',
    score: { build: 1, bp_clean: 1, golden_match: 1, systest: null },
    ...overrides,
  };
}

describe('detectFlakeCandidates', () => {
  it('flags two runs of the same case+sha that disagree on golden_match', () => {
    const runs = [
      run({ run_id: 'r1', score: { build: 1, bp_clean: 1, golden_match: 1, systest: null } }),
      run({ run_id: 'r2', score: { build: 1, bp_clean: 1, golden_match: 0, systest: null } }),
    ];
    const candidates = detectFlakeCandidates(runs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].case_id).toBe('L1-table-basic');
    expect(candidates[0].server_git_sha).toBe('abc123');
    expect(candidates[0].disagreements.map(d => d.field)).toEqual(['golden_match']);
  });

  it('does NOT flag runs that agree across repeats', () => {
    const runs = [
      run({ run_id: 'r1' }),
      run({ run_id: 'r2' }),
      run({ run_id: 'r3' }),
    ];
    expect(detectFlakeCandidates(runs)).toEqual([]);
  });

  it('does NOT flag a real fix: same case, DIFFERENT server_git_sha, different score', () => {
    const runs = [
      run({ run_id: 'r1', server_git_sha: 'sha1', score: { build: 1, bp_clean: 1, golden_match: 0, systest: null } }),
      run({ run_id: 'r2', server_git_sha: 'sha2', score: { build: 1, bp_clean: 1, golden_match: 1, systest: null } }),
    ];
    expect(detectFlakeCandidates(runs)).toEqual([]);
  });

  it('ignores a single run for a (case, sha) pair (nothing to compare against)', () => {
    const runs = [run({ run_id: 'r1' })];
    expect(detectFlakeCandidates(runs)).toEqual([]);
  });

  it('reports multiple disagreeing fields and ranks by disagreement count', () => {
    const runs = [
      run({ run_id: 'a1', case_id: 'A', score: { build: 1, bp_clean: 1, golden_match: 1, systest: null } }),
      run({ run_id: 'a2', case_id: 'A', score: { build: 0, bp_clean: 1, golden_match: 0, systest: null } }),
      run({ run_id: 'b1', case_id: 'B', score: { build: 1, bp_clean: 1, golden_match: 1, systest: null } }),
      run({ run_id: 'b2', case_id: 'B', score: { build: 1, bp_clean: 0, golden_match: 1, systest: null } }),
    ];
    const candidates = detectFlakeCandidates(runs);
    expect(candidates).toHaveLength(2);
    // Case A disagrees on 2 fields (build, golden_match) — ranked first.
    expect(candidates[0].case_id).toBe('A');
    expect(candidates[0].disagreements).toHaveLength(2);
    expect(candidates[1].case_id).toBe('B');
    expect(candidates[1].disagreements).toHaveLength(1);
  });
});

describe('renderFlakeCandidates', () => {
  it('renders a clean message when there are no candidates', () => {
    expect(renderFlakeCandidates([])).toMatch(/No flake candidates/);
  });

  it('renders the disagreeing run ids and values', () => {
    const runs = [
      run({ run_id: 'r1' }),
      run({ run_id: 'r2', score: { build: 1, bp_clean: 1, golden_match: 0, systest: null } }),
    ];
    const text = renderFlakeCandidates(detectFlakeCandidates(runs));
    expect(text).toMatch(/L1-table-basic/);
    expect(text).toMatch(/golden_match disagrees/);
    expect(text).toMatch(/r1=1/);
    expect(text).toMatch(/r2=0/);
  });
});
