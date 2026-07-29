/**
 * Coverage matrix tests — VM-free.
 *
 * The point of the matrix is that it is *derived*: these tests pin the
 * derivation rules (golden_pending proves nothing, dangling references are
 * caught, orphans are reported) and check the shipped taxonomy against the
 * real catalog so the published number cannot go stale unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { computeCoverage, danglingReferences, type CoverageInputs } from '../../src/eval/coverage/coverage';
import type { CoverageLeaf } from '../../src/eval/coverage/taxonomy';
import { TAXONOMY } from '../../src/eval/coverage/taxonomy';
import { KNOWLEDGE_BASE } from '../../src/tools/xppKnowledge';
import { loadCases, toolObjectTypes, buildReport } from '../../src/eval/coverage/sources';

const leaf = (partial: Partial<CoverageLeaf>): CoverageLeaf => ({
  id: 'l', label: 'L', domain: 'D', source: 'aot', tier: 'core', weight: 3, ...partial,
});

const inputs = (over: Partial<CoverageInputs> = {}): CoverageInputs => ({
  knowledgeIds: new Set(['k1']),
  cases: [{ id: 'L1-a', tags: ['table'], goldenPending: false }],
  toolTypes: new Set(['table']),
  ...over,
});

describe('coverage derivation', () => {
  it('requires all three of K, E and T', () => {
    const r = computeCoverage(
      [leaf({ knowledgeIds: ['k1'], caseIds: ['L1-a'], aotTypes: ['table'] })],
      inputs(),
    );
    expect(r.leaves[0]).toMatchObject({ k: true, e: true, t: true, covered: true });
  });

  it('does not count a case whose golden is still pending', () => {
    const r = computeCoverage(
      [leaf({ knowledgeIds: ['k1'], caseIds: ['L1-a'], aotTypes: ['table'] })],
      inputs({ cases: [{ id: 'L1-a', tags: ['table'], goldenPending: true }] }),
    );
    expect(r.leaves[0].e).toBe(false);
    expect(r.leaves[0].covered).toBe(false);
  });

  it('drops T when the tool path cannot create the type', () => {
    const r = computeCoverage(
      [leaf({ knowledgeIds: ['k1'], caseIds: ['L1-a'], aotTypes: ['aggregate-measurement'] })],
      inputs(),
    );
    expect(r.leaves[0].t).toBe(false);
  });

  it('matches by tag only when every declared tag is present', () => {
    const cases = [
      { id: 'L1-a', tags: ['form', 'modify'], goldenPending: false },
      { id: 'L1-b', tags: ['form'], goldenPending: false },
    ];
    const r = computeCoverage(
      [leaf({ knowledgeIds: ['k1'], caseTags: ['form', 'modify'], aotTypes: ['table'] })],
      inputs({ cases }),
    );
    expect(r.leaves[0].matchedCases).toEqual(['L1-a']);
  });

  it('reports orphan knowledge entries and unmapped cases', () => {
    const r = computeCoverage(
      [leaf({ knowledgeIds: ['k1'], aotTypes: ['table'] })],
      inputs({ knowledgeIds: new Set(['k1', 'k2']) }),
    );
    expect(r.orphans.knowledge).toEqual(['k2']);
    expect(r.orphans.cases).toEqual(['L1-a']);
  });

  it('flags a leaf pointing at a knowledge entry or case that no longer exists', () => {
    const r = computeCoverage(
      [leaf({ knowledgeIds: ['gone'], caseIds: ['L9-gone'], aotTypes: ['table'] })],
      inputs(),
    );
    expect(danglingReferences(r)).toHaveLength(2);
  });
});

describe('shipped taxonomy', () => {
  it('has unique ids and a weight in range', () => {
    const ids = TAXONOMY.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of TAXONOMY) expect(l.weight, l.id).toBeGreaterThanOrEqual(0);
    for (const l of TAXONOMY) expect(l.weight, l.id).toBeLessThanOrEqual(5);
  });

  it('never points at a knowledge entry or eval case that does not exist', () => {
    const report = computeCoverage(TAXONOMY, {
      knowledgeIds: new Set(KNOWLEDGE_BASE.map(e => e.id)),
      cases: loadCases(),
      toolTypes: toolObjectTypes(),
    });
    expect(danglingReferences(report)).toEqual([]);
  });

  it('explains every uncovered leaf — a red cell must say why', () => {
    const unexplained = buildReport().queue.filter(r => !r.leaf.note && !r.leaf.caseIds?.length && !r.leaf.caseTags?.length);
    expect(unexplained.map(r => r.leaf.id)).toEqual([]);
  });
});
