/**
 * The `reserved-words` topic is generated from the compiler's keyword set, so it
 * must list exactly that set: every word the parser rejects as a name, and not
 * the exempted `in`. A recapture (scripts/capture-compiler-facts.ts) changes the
 * set; these tests then check the topic followed it without anyone editing it.
 */
import { describe, expect, it } from 'vitest';

import { XPP_EXEMPTED_KEYWORDS, XPP_KEYWORDS } from '../../src/knowledge/compilerFacts.js';
import { KNOWLEDGE_BASE, xppKnowledgeTool } from '../../src/tools/knowledge/xppKnowledge.js';

const entry = KNOWLEDGE_BASE.find(e => e.id === 'reserved-words')!;

/** The words the catalog rule lists, group by group. */
function listedWords(): string[] {
  const catalog = entry.rules[0];
  const groups = catalog.slice(catalog.indexOf('loop variable.') + 'loop variable.'.length);
  return groups
    .split(' · ')
    .flatMap(g => g.slice(g.indexOf(':') + 1).split(','))
    .map(w => w.trim())
    .filter(Boolean);
}

async function lookup(topic: string): Promise<string> {
  const res = await xppKnowledgeTool({
    method: 'tools/call',
    params: { name: 'get_xpp_knowledge', arguments: { topic } },
  });
  return (res.content[0] as { text: string }).text;
}

describe('reserved-words knowledge topic', () => {
  it('exists', () => {
    expect(entry).toBeDefined();
  });

  it('lists exactly the compiler keyword set, minus the exempted words', () => {
    const expected = XPP_KEYWORDS.filter(k => !XPP_EXEMPTED_KEYWORDS.includes(k));
    expect(new Set(listedWords())).toEqual(new Set(expected));
    expect(listedWords()).toHaveLength(expected.length);
  });

  it('puts every word of today\'s set in a named group', () => {
    expect(entry.rules[0]).not.toMatch(/ other: /);
  });

  it('states the exemption, the @ escape and that the reference differs', () => {
    const text = entry.rules.join('\n');
    expect(text).toMatch(/`in` is reserved but EXEMPTED/);
    expect(text).toMatch(/int @index; compiles/);
    expect(text).toMatch(/language reference and the compiler disagree/);
  });

  it.each(['reserved keywords', 'reserved words', 'keywords', 'reserved-words'])(
    'is the first answer to "%s"',
    async topic => {
      expect(await lookup(topic)).toMatch(/^## Reserved Words/);
    },
  );
});
