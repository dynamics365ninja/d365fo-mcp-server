/**
 * Knowledge-base feedback channel — MODEL_ERROR clustering + topic suggestion.
 */

import { describe, it, expect } from 'vitest';
import {
  modelErrorClusters, scoreTopicMatch, suggestKnowledgeTopic,
  buildKnowledgeProposals, renderKnowledgeProposals, type KnowledgeEntryLike,
} from '../../src/eval/improver/knowledgeFeedback';
import type { CorpusRun } from '../../src/eval/improver/cluster';

const KB: KnowledgeEntryLike[] = [
  { id: 'sysoperation', title: 'SysOperation Framework', keywords: ['batch', 'sysoperation', 'controller', 'service'] },
  { id: 'coc', title: 'Chain of Command', keywords: ['coc', 'extension', 'next', 'chainofcommand'] },
  { id: 'select-statement', title: 'Select Statement Patterns', keywords: ['select', 'query', 'firstonly', 'exists'] },
];

function run(overrides: Partial<CorpusRun>): CorpusRun {
  return {
    run_id: 'r1', case_id: 'c1', tier: 1, classification: 'MODEL_ERROR',
    ...overrides,
  };
}

describe('modelErrorClusters', () => {
  it('only includes MODEL_ERROR runs, not TOOL_DEFECT/PASS', () => {
    const runs: CorpusRun[] = [
      run({ run_id: 'r1', root_cause_hypothesis: 'used RunBase instead of SysOperation for a new batch job' }),
      run({ run_id: 'r2', classification: 'TOOL_DEFECT', root_cause_hypothesis: 'bridge dropped fields' }),
      run({ run_id: 'r3', classification: 'PASS' }),
    ];
    const clusters = modelErrorClusters(runs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].classification).toBe('MODEL_ERROR');
    expect(clusters[0].runIds).toEqual(['r1']);
  });

  it('groups repeated MODEL_ERROR symptoms and ranks by frequency', () => {
    const runs: CorpusRun[] = [
      run({ run_id: 'r1', tier: 2, root_cause_hypothesis: 'used RunBase instead of SysOperation' }),
      run({ run_id: 'r2', tier: 2, root_cause_hypothesis: 'used RunBase instead of SysOperation' }),
      run({ run_id: 'r3', tier: 1, root_cause_hypothesis: 'forgot next() in CoC wrapper' }),
    ];
    const clusters = modelErrorClusters(runs);
    expect(clusters[0].frequency).toBe(2);
    expect(clusters[0].runIds).toEqual(['r1', 'r2']);
  });
});

describe('scoreTopicMatch / suggestKnowledgeTopic', () => {
  it('scores higher overlap higher', () => {
    const batchScore = scoreTopicMatch('used RunBase instead of SysOperation Controller', KB[0]);
    const cocScore = scoreTopicMatch('used RunBase instead of SysOperation Controller', KB[1]);
    expect(batchScore).toBeGreaterThan(0);
    expect(batchScore).toBeGreaterThan(cocScore);
  });

  it('suggests the best-matching topic by id', () => {
    const match = suggestKnowledgeTopic('forgot to call next() in the CoC extension wrapper', KB);
    expect(match?.id).toBe('coc');
  });

  it('returns null when nothing matches', () => {
    const match = suggestKnowledgeTopic('completely unrelated gibberish zzz qqq', KB);
    expect(match).toBeNull();
  });
});

describe('buildKnowledgeProposals / renderKnowledgeProposals', () => {
  it('flags a cluster with no topic match as needing a NEW knowledge entry', () => {
    const runs: CorpusRun[] = [
      run({ run_id: 'r1', root_cause_hypothesis: 'totally unrelated gibberish zzz qqq' }),
    ];
    const proposals = buildKnowledgeProposals(runs, KB);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].isNewTopic).toBe(true);
    expect(proposals[0].suggestedTopicId).toBeNull();
    expect(renderKnowledgeProposals(proposals)).toMatch(/needs a NEW/);
  });

  it('proposes an existing topic when one matches well', () => {
    const runs: CorpusRun[] = [
      run({ run_id: 'r1', root_cause_hypothesis: 'used RunBase instead of SysOperation Controller for a new batch job' }),
    ];
    const proposals = buildKnowledgeProposals(runs, KB);
    expect(proposals[0].suggestedTopicId).toBe('sysoperation');
    expect(renderKnowledgeProposals(proposals)).toMatch(/sysoperation/);
  });

  it('renders a clean-corpus message when there are no MODEL_ERROR clusters', () => {
    expect(renderKnowledgeProposals([])).toMatch(/No MODEL_ERROR/);
  });
});
