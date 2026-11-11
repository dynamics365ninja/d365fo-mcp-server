import { describe, expect, it } from 'vitest';
import { getKnowledgeTool } from '../../src/tools/knowledge/getKnowledge';
import { KNOWLEDGE_BASE } from '../../src/tools/knowledge/xppKnowledge';
import { runRules } from '../../src/tools/analysis/validateXpp';

const read = async (topic: string, format = 'concise') => {
  const result = await getKnowledgeTool({
    method: 'tools/call',
    params: {
      name: 'get_knowledge',
      arguments: { kind: 'knowledge', topic, format },
    },
  });
  return result.content.map(part => ('text' in part ? part.text : '')).join('\n');
};

describe('menu-item guard knowledge retrieval', () => {
  it.each(['menu-item-guards', 'UI001', 'Unable to open menu item', 'action menu item missing data'])(
    'finds guard advice through get_knowledge: %s',
    async topic => {
      const text = await read(topic);
      expect(text).toContain('Menu-item guards');
      expect(text).toContain('warning');
      expect(text).toContain('rollback');
      expect(text).toContain('security');
      expect(text).toContain('batch');
    },
  );

  it('grounds exception semantics separately from the observed menu wrapper', async () => {
    const text = await read('menu-item-guards', 'detailed');
    expect(text).toContain(
      'https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/dev-ref/xpp-exceptions',
    );
    expect(text).toContain('observed');
    expect(text).toContain('not a universal');
    expect(text).toContain('before writes');
    expect(text).toContain('does not prove');
    expect(text).toContain('warning("@MyModel:MissingSelection");');
    expect(text).toContain('return;');
  });

  it('links from error-handling and teaches a warning-free guard example', () => {
    expect(KNOWLEDGE_BASE.find(entry => entry.id === 'error-handling')?.related).toContain('menu-item-guards');
    const entry = KNOWLEDGE_BASE.find(item => item.id === 'menu-item-guards');
    expect(entry?.examples?.length).toBeGreaterThan(0);
    for (const example of entry?.examples ?? []) expect(runRules(example.code, 'xpp')).toEqual([]);
  });
});
