/**
 * Bridge-sourced search rows carry the MODEL (audit 2026-08-25).
 *
 * `search`'s published schema promises "returns name, type, model", but the C#
 * side only ever fills Name and Type (SearchItemModel is constructed with those
 * two in MetadataReadService.SearchObjects), so every bridge row rendered as
 * `- **Name** (type)` and the caller had to spend a second call to learn where
 * the hit lives. The index already knows, so the TS adapter fills it in — and a
 * method/field row spliced in from the index names its owning object.
 */

import { describe, it, expect, vi } from 'vitest';
import { tryBridgeSearch } from '../../src/bridge/bridgeAdapter';
import { buildBridgeMetaResolver, metaKey } from '../../src/tools/analysis/search';
import type { BridgeClient } from '../../src/bridge/bridgeClient';

function makeBridge(results: Array<{ name: string; type: string }>): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    searchObjects: vi.fn(async () => ({ results, totalCount: results.length })),
  } as unknown as BridgeClient;
}

describe('tryBridgeSearch — model on every row', () => {
  it('renders the model resolved from the index next to each bridge hit', async () => {
    const bridge = makeBridge([{ name: 'CustTable', type: 'table' }]);

    const result = await tryBridgeSearch(bridge, 'CustTable', 'table', 20, {
      resolveMeta: () => new Map([[metaKey('CustTable', 'table'), { model: 'Foundation' }]]),
    });
    const text = (result!.content[0] as { text: string }).text;

    expect(text).toContain('- **CustTable** (table) — Foundation');
  });

  it('renders unchanged when no resolver is supplied (backwards compatible)', async () => {
    const bridge = makeBridge([{ name: 'CustTable', type: 'table' }]);
    const text = ((await tryBridgeSearch(bridge, 'CustTable', 'table', 20))!.content[0] as { text: string }).text;
    expect(text).toContain('- **CustTable** (table)');
    expect(text).not.toContain('—');
  });

  it('names the owning object of a spliced method hit', async () => {
    // A custom-model probe is NOT restricted to top-level rows, so a method can
    // be spliced into the answer. `- **initValue** (method)` alone costs a call.
    const bridge = makeBridge([{ name: 'ConChainOther', type: 'table' }]);

    const result = await tryBridgeSearch(bridge, 'initValue', undefined, 20, {
      customMatches: [{ name: 'initValue', type: 'method', model: 'fm-mcp', parentName: 'ConChainTbl' }],
    });
    const text = (result!.content[0] as { text: string }).text;

    expect(text).toContain('- **ConChainTbl.initValue** (method) — fm-mcp');
  });
});

describe('buildBridgeMetaResolver', () => {
  it('asks the index for the model with an index-safe, bounded query', () => {
    const all = vi.fn(() => [{ name: 'CustTable', type: 'table', model: 'Foundation' }]);
    const prepare = vi.fn(() => ({ all }));
    const resolver = buildBridgeMetaResolver({ getReadDb: () => ({ prepare }) });

    const map = resolver([{ name: 'CustTable', type: 'table' }]);

    const sql = String(prepare.mock.calls[0][0]);
    // Equality on an indexed column, never LIKE / COLLATE NOCASE — those degrade
    // to a full scan of the 1.17M-row symbols table (see symbolLookup.ts).
    expect(sql).toContain('name IN (?)');
    expect(sql).toContain('parent_name IS NULL');
    expect(sql).toContain('LIMIT');
    expect(sql).not.toMatch(/LIKE|COLLATE/i);
    expect(map.get(metaKey('CustTable', 'table'))).toEqual({ model: 'Foundation' });
  });

  it('returns an empty map instead of throwing when the index is unavailable', () => {
    expect(buildBridgeMetaResolver({})([{ name: 'X', type: 'table' }]).size).toBe(0);
    expect(
      buildBridgeMetaResolver({ getReadDb: () => { throw new Error('closed'); } })([{ name: 'X', type: 'table' }]).size,
    ).toBe(0);
  });
});
