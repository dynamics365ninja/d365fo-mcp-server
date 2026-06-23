/**
 * Context ranker scoring (Phase 2 context pipeline).
 * Uses a mock symbol index so the test is fast and DB-free.
 */

import { describe, it, expect } from 'vitest';
import {
  rankContext,
  tokenizeIntent,
  renderRankedContext,
} from '../../src/workspace/contextRanker.js';
import type { XppSymbol } from '../../src/metadata/types.js';

function sym(partial: Partial<XppSymbol> & { name: string; type: XppSymbol['type'] }): XppSymbol {
  return {
    model: 'ContosoExt',
    filePath: `K:/ws/${partial.name}.xml`,
    ...partial,
  } as XppSymbol;
}

/** Build a fake XppServerContext exposing only what rankContext touches. */
function ctxWith(symbols: XppSymbol[], anchor?: XppSymbol) {
  return {
    symbolIndex: {
      searchSymbols: (_q: string, limit: number) => symbols.slice(0, limit),
      getSymbolByName: (name: string, _type: string) =>
        anchor && anchor.name === name ? anchor : null,
    },
  } as any;
}

describe('tokenizeIntent', () => {
  it('drops stopwords and short tokens, dedupes', () => {
    expect(tokenizeIntent('Add a custom validation rule to CustTable validateWrite')).toEqual([
      'validation',
      'custtable',
      'validatewrite',
    ]);
  });
});

describe('rankContext', () => {
  it('ranks keyword + relationship matches and drops the anchor itself', () => {
    const symbols = [
      sym({ name: 'CustTable', type: 'table' }), // the anchor — should be dropped
      sym({ name: 'validateWrite', type: 'method', parentName: 'CustTable', signature: 'boolean validateWrite()' }),
      sym({ name: 'SomeUnrelated', type: 'class', model: 'ApplicationSuite' }),
    ];
    const ranked = rankContext(ctxWith(symbols), {
      intent: 'validateWrite on CustTable',
      activeObject: { name: 'CustTable', type: 'table' },
    });

    const names = ranked.items.map((i) => i.name);
    expect(names).not.toContain('CustTable'); // anchor dropped
    expect(names).toContain('validateWrite');
    // The member-of-anchor + keyword match should outrank the unrelated class.
    expect(ranked.items[0].name).toBe('validateWrite');
    expect(ranked.items[0].reasons.join(' ')).toContain('member of CustTable');
  });

  it('respects the token budget and flags truncation', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      sym({ name: `Helper${i}`, type: 'class', signature: 'public void doSomethingWithALongSignature()' })
    );
    const ranked = rankContext(ctxWith(many), {
      intent: 'helper',
      tokenBudget: 40,
      limit: 50,
    });
    expect(ranked.truncated).toBe(true);
    expect(ranked.approxTokens).toBeLessThanOrEqual(40 + 30); // budget honored within one item
    expect(ranked.items.length).toBeLessThan(many.length);
  });

  it('returns a well-formed empty result when the index throws', () => {
    const ctx = {
      symbolIndex: {
        searchSymbols: () => {
          throw new Error('index not ready');
        },
        getSymbolByName: () => null,
      },
    } as any;
    const ranked = rankContext(ctx, { intent: 'anything' });
    expect(ranked.items).toEqual([]);
    expect(ranked.truncated).toBe(false);
    expect(renderRankedContext(ranked)[1]).toContain('no related objects');
  });
});
