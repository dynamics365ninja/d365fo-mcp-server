/**
 * Custom/ISV-model prioritization in `search`.
 *
 * Observation (2026-07-23): broad keyword searches "return only standard
 * Microsoft objects, not custom code" even though custom models are indexed.
 *
 * Root cause: the C# bridge enumerates ONE merged, provider-ordered key list
 * across all models — dominated by the far larger Microsoft standard corpus —
 * and truncates at `maxResults` (MetadataReadService.SearchObjects). Custom
 * matches that enumerate later fall outside the window and never reach the
 * client. Only exact-name hits were rescued (defect #15); broad keyword hits in
 * custom models were not.
 *
 * The repair probes the SQLite index for custom-model matches and splices them
 * back in, ranked directly after exact matches (ahead of Microsoft standard
 * hits). These tests pin that behaviour plus the secondary fix to
 * `getCustomModels()` (it used to classify every Microsoft model as custom).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BridgeClient } from '../../src/bridge/bridgeClient';
import { tryBridgeSearch } from '../../src/bridge/bridgeAdapter';
import { rankCustomFirst, exactMatchRank } from '../../src/utils/exactMatchRanking';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { clearAutoDetectedModels } from '../../src/utils/modelClassifier';

// ── ranking primitive ────────────────────────────────────────────────────────

describe('rankCustomFirst', () => {
  it('orders exact > custom > rest, stable within each tier', () => {
    const items = [
      { name: 'CustTableMsFoo', custom: false }, // Microsoft substring hit
      { name: 'CustTable', custom: false },       // exact (Microsoft) — still wins
      { name: 'CustTableHbrExt', custom: true },  // custom substring hit
      { name: 'CustTableMsBar', custom: false },
    ];
    const ranked = rankCustomFirst('CustTable', items, i => i.name, i => i.custom);
    expect(ranked.map(i => i.name)).toEqual([
      'CustTable',        // tier 0 — exact
      'CustTableHbrExt',  // tier 1 — custom
      'CustTableMsFoo',   // tier 2 — rest, original order preserved
      'CustTableMsBar',
    ]);
  });

  it('lifts a custom hit above Microsoft PREFIX hits (custom beats name quality)', () => {
    // A Microsoft prefix match (rank 2) must NOT outrank a custom substring hit —
    // "prioritize custom" is the whole point.
    const items = [
      { name: 'AccountingSourcePrefix', custom: false }, // prefix match, standard
      { name: 'MyAccountingSourceExt', custom: true },   // substring match, custom
    ];
    const ranked = rankCustomFirst('AccountingSource', items, i => i.name, i => i.custom);
    expect(ranked[0].name).toBe('MyAccountingSourceExt');
  });

  it('does not disturb exactMatchRank semantics', () => {
    expect(exactMatchRank('Num', 'Num')).toBe(0);
    expect(exactMatchRank('Num', 'NUM')).toBe(1);
  });
});

// ── bridge splice + prioritization ───────────────────────────────────────────

function makeBridge(results: { name: string; type: string }[]): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    searchObjects: vi.fn(async () => ({ results, totalCount: results.length })),
  } as unknown as BridgeClient;
}

/** A Microsoft-dominated window with no custom object in it. */
const MS_WINDOW = Array.from({ length: 40 }, (_, i) => ({
  name: `CustTableMs${i}`,
  type: 'table',
}));

describe('tryBridgeSearch — custom-model prioritization', () => {
  it('splices a custom hit the Microsoft-dominated window truncated away', async () => {
    const bridge = makeBridge(MS_WINDOW);

    const result = await tryBridgeSearch(bridge, 'CustTable', 'table', 40, {
      customMatches: [{ name: 'CustTableHbr_Extension', type: 'table-extension' }],
    });
    const text = (result!.content[0] as { text: string }).text;

    expect(text).toContain('CustTableHbr_Extension');
    expect(text).toContain('custom/ISV-model match');
  });

  it('ranks the custom hit ahead of Microsoft standard hits (but behind exact)', async () => {
    // Bridge window: an exact Microsoft match + noise. Custom hit spliced in.
    const bridge = makeBridge([{ name: 'CustTable', type: 'table' }, ...MS_WINDOW]);

    const result = await tryBridgeSearch(bridge, 'CustTable', 'table', 40, {
      customMatches: [{ name: 'CustTableHbr_Extension', type: 'table-extension' }],
    });
    const text = (result!.content[0] as { text: string }).text;
    const bullets = text.split('\n').filter(l => l.startsWith('- '));

    expect(bullets[0]).toContain('**CustTable**');            // exact first
    expect(bullets[0]).toContain('exact match');
    expect(bullets[1]).toContain('**CustTableHbr_Extension**'); // custom next
    // A Microsoft noise hit must come only after the custom one.
    const customIdx = bullets.findIndex(b => b.includes('CustTableHbr_Extension'));
    const firstMsIdx = bullets.findIndex(b => /CustTableMs\d/.test(b));
    expect(customIdx).toBeLessThan(firstMsIdx);
  });

  it('does not duplicate a custom match already inside the bridge window, but still prioritizes it', async () => {
    const bridge = makeBridge([...MS_WINDOW.slice(0, 20), { name: 'CustTableHbr_Extension', type: 'table-extension' }, ...MS_WINDOW.slice(20)]);

    const result = await tryBridgeSearch(bridge, 'CustTable', 'table', 40, {
      customMatches: [{ name: 'CustTableHbr_Extension', type: 'table-extension' }],
    });
    const text = (result!.content[0] as { text: string }).text;
    const bullets = text.split('\n').filter(l => l.startsWith('- '));

    expect(text.match(/CustTableHbr_Extension/g)).toHaveLength(1);
    const customIdx = bullets.findIndex(b => b.includes('CustTableHbr_Extension'));
    const firstMsIdx = bullets.findIndex(b => /CustTableMs\d/.test(b));
    expect(customIdx).toBeLessThan(firstMsIdx);
  });

  it('keeps working without customMatches (backwards compatible)', async () => {
    const bridge = makeBridge([{ name: 'CustTable', type: 'table' }]);
    const result = await tryBridgeSearch(bridge, 'CustTable', 'table', 40);
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('**CustTable**');
    expect(text).not.toContain('custom/ISV-model match');
  });
});

// ── symbol-index: getCustomModels + searchCustomModelSymbols ──────────────────

describe('XppSymbolIndex custom-model queries', () => {
  const savedEnv = {
    CUSTOM_MODELS: process.env.CUSTOM_MODELS,
    EXTENSION_PREFIX: process.env.EXTENSION_PREFIX,
    D365FO_MODEL_NAME: process.env.D365FO_MODEL_NAME,
  };

  beforeEach(() => {
    clearAutoDetectedModels();
    process.env.CUSTOM_MODELS = 'MyCustom';
    process.env.EXTENSION_PREFIX = '';
    delete process.env.D365FO_MODEL_NAME;
  });

  afterEach(() => {
    process.env.CUSTOM_MODELS = savedEnv.CUSTOM_MODELS;
    process.env.EXTENSION_PREFIX = savedEnv.EXTENSION_PREFIX;
    if (savedEnv.D365FO_MODEL_NAME === undefined) delete process.env.D365FO_MODEL_NAME;
    else process.env.D365FO_MODEL_NAME = savedEnv.D365FO_MODEL_NAME;
    clearAutoDetectedModels();
  });

  function seed(): XppSymbolIndex {
    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.addSymbol({ name: 'CustTable', type: 'table', filePath: '/ms.xml', model: 'ApplicationPlatform' } as any);
    index.addSymbol({ name: 'LedgerJournalTable', type: 'table', filePath: '/gl.xml', model: 'GeneralLedger' } as any);
    index.addSymbol({ name: 'CustTableMyExt', type: 'table-extension', filePath: '/c.xml', model: 'MyCustom' } as any);
    index.addSymbol({ name: 'MyCustomHelper', type: 'class', filePath: '/h.xml', model: 'MyCustom' } as any);
    return index;
  }

  it('getCustomModels returns only non-Microsoft models (regression: used to return all)', () => {
    const index = seed();
    expect(index.getCustomModels()).toEqual(['MyCustom']);
    index.close?.();
  });

  it('searchCustomModelSymbols returns only custom-model matches for a shared name', () => {
    const index = seed();
    const hits = index.searchCustomModelSymbols('CustTable');
    expect(hits.map(h => h.name)).toContain('CustTableMyExt');
    expect(hits.map(h => h.name)).not.toContain('CustTable'); // the Microsoft one is excluded
    index.close?.();
  });

  it('searchCustomModelSymbols returns [] when there are no custom models', () => {
    process.env.CUSTOM_MODELS = '';
    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.addSymbol({ name: 'CustTable', type: 'table', filePath: '/ms.xml', model: 'ApplicationPlatform' } as any);
    expect(index.searchCustomModelSymbols('CustTable')).toEqual([]);
    index.close?.();
  });
});
