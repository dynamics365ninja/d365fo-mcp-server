/**
 * `search` routing — which backing search answers which query (audit 2026-08-25).
 *
 * MEASURED on this VM: `search(query="CustTable", type="table")` answers in
 * 0.33 s through the C# bridge, while the same call with no type filter took
 * 17.9 s ("SalesLine") and 35.4 s ("ConChain"). The bridge answers an untyped
 * query by walking GetPrimaryKeys() of every collection on both providers with
 * no cache, and can only stop early once the result budget is full — so the
 * narrower the query, the longer it runs. The SQLite FTS index holds the same
 * object names and answers in milliseconds.
 *
 * These tests pin the routing that follows from that, and the two things it must
 * NOT cost: freshly written objects stay findable (the untyped route still asks
 * live metadata when the index has nothing), and the exact/custom splice into a
 * Microsoft-dominated bridge window is unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTryBridgeSearch = vi.fn(async () => null as any);
vi.mock('../../src/bridge/bridgeAdapter', () => ({
  tryBridgeSearch: (...args: any[]) => mockTryBridgeSearch.apply(null, args as any),
}));

const mockIndexedPathIsMissing = vi.fn(async (_p?: string | null) => false);
vi.mock('../../src/utils/indexedXmlLookup', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/indexedXmlLookup')>();
  return { ...actual, indexedPathIsMissing: (p?: string | null) => mockIndexedPathIsMissing(p) };
});

import { searchTool } from '../../src/tools/analysis/search';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'search', arguments: args },
});

const row = (name: string, type = 'table', model = 'Foundation') => ({
  id: 1, name, type, model,
  filePath: `K:\\PackagesLocalDirectory\\App\\${model}\\AxTable\\${name}.xml`,
});

function buildContext(rows: any[]) {
  const searchSymbols = vi.fn(() => rows);
  const context = {
    bridge: { isReady: true, metadataAvailable: true } as any,
    symbolIndex: {
      searchSymbols,
      searchCustomModelSymbols: vi.fn(() => []),
      getAllSymbolNames: vi.fn(() => []),
      getSymbolsByTerm: vi.fn(() => new Map()),
      getReadDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) })),
    },
  } as unknown as XppServerContext;
  return { context, searchSymbols };
}

beforeEach(() => {
  mockTryBridgeSearch.mockReset();
  mockTryBridgeSearch.mockResolvedValue(null);
  mockIndexedPathIsMissing.mockReset();
  mockIndexedPathIsMissing.mockResolvedValue(false);
});

describe('search routing', () => {
  it('answers an untyped query from the index without touching the bridge', async () => {
    const { context } = buildContext([row('SalesLine'), row('SalesLineDelete')]);

    const text = (await searchTool(req({ query: 'SalesLine' }), context)).content[0].text as string;

    expect(mockTryBridgeSearch).not.toHaveBeenCalled();
    expect(text).toContain('SalesLine');
    expect(text).toContain('Found 2 matches');
  });

  it('still asks live metadata when the index has nothing under that name', async () => {
    // The whole value of the bridge on this path: an object the index has never
    // seen exists only in the provider, and "no such object" is the most
    // expensive wrong answer this tool can give.
    const { context } = buildContext([]);
    mockTryBridgeSearch.mockResolvedValue({
      content: [{ type: 'text', text: '# Search: "BrandNewTbl"\n- **BrandNewTbl** (table)' }],
    } as any);

    const text = (await searchTool(req({ query: 'BrandNewTbl' }), context)).content[0].text as string;

    expect(mockTryBridgeSearch).toHaveBeenCalledTimes(1);
    // Untyped ⇒ no objectType is passed to the bridge.
    expect(mockTryBridgeSearch.mock.calls[0][2]).toBeUndefined();
    expect(text).toContain('BrandNewTbl');
  });

  it('asks the bridge when every index row is a ghost (file gone from disk)', async () => {
    // A row whose file is gone says nothing about an object that was RECREATED
    // since — and that object exists only in live metadata, so an index-only
    // answer here would report a deleted object as the current one.
    const { context } = buildContext([
      { ...row('ConChainTbl'), filePath: 'K:\\PackagesLocalDirectory\\App\\Foundation\\AxTable\\Gone.xml' },
    ]);
    mockIndexedPathIsMissing.mockResolvedValue(true);
    mockTryBridgeSearch.mockResolvedValue({
      content: [{ type: 'text', text: '# Search: "ConChainTbl"\n- **ConChainTbl** (table)' }],
    } as any);

    const text = (await searchTool(req({ query: 'ConChainTbl' }), context)).content[0].text as string;

    expect(mockTryBridgeSearch).toHaveBeenCalledTimes(1);
    // The live answer wins over the ghost row.
    expect(text).toContain('# Search: "ConChainTbl"');
    expect(text).not.toContain('STALE');
  });

  it('keeps the bridge first for a type-scoped query', async () => {
    const { context } = buildContext([row('CustTable')]);
    mockTryBridgeSearch.mockResolvedValue({
      content: [{ type: 'text', text: '# Search: "CustTable" (type: table)' }],
    } as any);

    await searchTool(req({ query: 'CustTable', type: 'table' }), context);

    expect(mockTryBridgeSearch).toHaveBeenCalledTimes(1);
    expect(mockTryBridgeSearch.mock.calls[0][2]).toBe('table');
  });

  it('falls back to the index when the bridge cannot answer a type-scoped query', async () => {
    const { context } = buildContext([row('CustTable')]);
    mockTryBridgeSearch.mockResolvedValue(null);

    const text = (await searchTool(req({ query: 'CustTable', type: 'table' }), context)).content[0].text as string;

    expect(text).toContain('CustTable');
    expect(text).not.toContain('No X++ symbols found');
  });

  it('still passes the exact/custom splice to the bridge on the routes that use it', async () => {
    const { context } = buildContext([]);
    mockTryBridgeSearch.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] } as any);

    await searchTool(req({ query: 'CustTable', type: 'table' }), context);

    const opts = mockTryBridgeSearch.mock.calls[0][4] as any;
    expect(opts).toHaveProperty('exactMatches');
    expect(opts).toHaveProperty('customMatches');
    // …plus the model resolver that fills in what the C# side never sends.
    expect(typeof opts.resolveMeta).toBe('function');
  });

  it('logs the route it took, so an audit can read it instead of timing it', async () => {
    const { context } = buildContext([row('SalesLine')]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await searchTool(req({ query: 'SalesLine' }), context);

    expect(spy.mock.calls.some(c => String(c[0]).includes('[search] route=index'))).toBe(true);
    spy.mockRestore();
  });

  it('defaults limit to the 20 the published schema advertises, not 50', async () => {
    // The caller budgets its context for the documented default; handing it 50
    // rows is a contract the caller cannot see.
    const { context, searchSymbols } = buildContext([row('SalesLine')]);

    await searchTool(req({ query: 'SalesLine' }), context);

    expect(searchSymbols).toHaveBeenCalledWith('SalesLine', 20, undefined);
  });
});
