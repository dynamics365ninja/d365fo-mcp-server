/**
 * get_knowledge(topics[]) — whole topics, then a named list of what did not fit.
 *
 * Measured over 1,400 real MCP calls on this VM: get_knowledge was called 186
 * times against only 81 prepares, and its batch form topics[] was used ZERO
 * times — because knowledge topics measure 8–12 KB and the generic 5,000-char
 * response cap halved them. Raising the cap alone is not enough: a batch can
 * still overrun it, and the generic capper cuts on a block boundary anywhere in
 * the text, so the last topic arrives half-written. A rule truncated mid-sentence
 * is worse than an absent one, because the caller cannot tell it is incomplete.
 */

import { describe, it, expect } from 'vitest';
import { getKnowledgeTool, renderTopicBatch, TOPIC_BATCH_BUDGET } from '../../src/tools/knowledge/getKnowledge';

const call = (args: Record<string, unknown>) =>
  getKnowledgeTool({ method: 'tools/call', params: { name: 'get_knowledge', arguments: args } } as any);

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

describe('renderTopicBatch', () => {
  const entries = [
    { topic: 'alpha', text: 'A'.repeat(80) },
    { topic: 'beta', text: 'B'.repeat(80) },
    { topic: 'gamma', text: 'C'.repeat(80) },
  ];

  it('drops whole topics and names them instead of cutting one in half', () => {
    const out = renderTopicBatch(entries, 'knowledge', 100);
    expect(out).toContain('A'.repeat(80));
    // Nothing of the dropped topics leaks in partially.
    expect(out).not.toContain('B'.repeat(10));
    expect(out).not.toContain('C'.repeat(10));
    expect(out).toContain('2 topics NOT included');
    expect(out).toContain('Not included: beta, gamma');
    expect(out).toContain('get_knowledge(kind="knowledge", topics: ["beta", "gamma"])');
  });

  it('always returns the first topic whole, even when it alone busts the budget', () => {
    const out = renderTopicBatch(entries, 'op-spec', 5);
    expect(out).toContain('A'.repeat(80));
    expect(out).toContain('Not included: beta, gamma');
    expect(out).toContain('kind="op-spec"');
  });

  it('says nothing when everything fits', () => {
    const out = renderTopicBatch(entries, 'knowledge', 10_000);
    expect(out).not.toContain('NOT included');
    expect(out).toContain('C'.repeat(80));
  });
});

describe('get_knowledge(kind="knowledge", topics[]) end to end', () => {
  it('never exceeds the topic budget by more than the notice, and names what it dropped', async () => {
    const topics = [
      'select-statement', 'coc-authoring', 'bp-rules', 'sysoperation', 'event-handlers',
      'workflow', 'number-sequences', 'security', 'sysda', 'form patterns',
    ];
    const text = textOf(await call({ kind: 'knowledge', topics, format: 'detailed' }));

    const notice = text.indexOf('NOT included');
    if (notice === -1) {
      // Everything fitted — then the whole batch must be inside the budget.
      expect(text.length).toBeLessThanOrEqual(TOPIC_BATCH_BUDGET);
      return;
    }
    // The body (everything before the notice) is what the budget governs.
    expect(text.slice(0, notice).length).toBeLessThanOrEqual(TOPIC_BATCH_BUDGET);
    const dropped = /Not included: (.+)/.exec(text)?.[1].split(', ') ?? [];
    expect(dropped.length).toBeGreaterThan(0);
    // A dropped topic must be absent from the body, not present in fragments.
    for (const t of dropped) {
      expect(text.slice(0, notice)).not.toContain(`## ${t}`);
    }
    expect(text).toContain('get_knowledge(kind="knowledge", topics: [');
  });
});

describe('get_knowledge(kind="op-spec", topics[])', () => {
  it('still answers every contract when the batch fits', async () => {
    const text = textOf(await call({ kind: 'op-spec', topics: ['add-field', 'add-index'] }));
    expect(text).toContain('add-field');
    expect(text).toContain('add-index');
    expect(text).not.toContain('NOT included');
  });
});
