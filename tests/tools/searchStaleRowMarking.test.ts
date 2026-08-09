/**
 * search — index rows whose file is gone are MARKED, never hidden (#876).
 *
 * The stale-row sweep only covered the two probes spliced into a bridge answer,
 * which is the wrong way round for the failure it was written for: a stale index
 * outlives a deleted file precisely when the bridge is silent, so the one answer
 * made entirely of index rows was the one still reporting ghosts as fact.
 *
 * Sweeping that answer too is worse, and these tests pin why: `indexedPathIsMissing`
 * fires for any PackagesLocalDirectory path with no file here, the shipped symbol
 * index covers every standard package, and a machine installs a subset — so dropping
 * those rows answers "no X++ symbols found" for most of D365FO on a partial install,
 * in the tool every other workflow starts from. The row stays, says what it is, and
 * ranks below the live ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const GHOST_PATH = 'K:\\PackagesLocalDirectory\\Contoso\\Contoso\\AxTable\\ConGhostTable.xml';
const LIVE_PATH = 'K:\\PackagesLocalDirectory\\MyPkg\\MyModel\\AxTable\\ConLiveTable.xml';

const sym = (name: string, filePath: string, type = 'table', model = 'Contoso') => ({
  id: 1, name, type, parentName: undefined, signature: undefined, filePath, model,
});

/** No bridge — the index-only answer, which is the path under test. */
const buildContext = (rows: any[]): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => rows),
    searchCustomModelSymbols: vi.fn(() => []),
    getAllSymbolNames: vi.fn(() => []),
    getSymbolsByTerm: vi.fn(() => new Map()),
    getCustomModels: vi.fn(() => ['Contoso']),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  } as any,
  cache: {} as any,
  parser: {} as any,
  workspaceScanner: {} as any,
  hybridSearch: {} as any,
} as any);

beforeEach(() => {
  mockIndexedPathIsMissing.mockReset();
  mockIndexedPathIsMissing.mockResolvedValue(false);
});

describe('index-only search answer', () => {
  it('marks a row whose file is gone instead of dropping it', async () => {
    mockIndexedPathIsMissing.mockImplementation(async (p) => p === GHOST_PATH);

    const text = (await searchTool(
      req({ query: 'ConGhostTable' }),
      buildContext([sym('ConGhostTable', GHOST_PATH)]),
    )).content[0].text as string;

    // The hit is still reported — hiding it is what would answer "no such object".
    expect(text).toContain('ConGhostTable');
    expect(text).not.toContain('No X++ symbols found');
    // …and it says what it is, both on the row and once in full.
    expect(text).toContain('STALE index row');
    expect(text).toMatch(/1 result marked STALE/);
    expect(text).toContain('update_symbol_index');
  });

  it('ranks stale rows below live ones', async () => {
    mockIndexedPathIsMissing.mockImplementation(async (p) => p === GHOST_PATH);

    const text = (await searchTool(
      req({ query: 'Con' }),
      buildContext([sym('ConGhostTable', GHOST_PATH), sym('ConLiveTable', LIVE_PATH)]),
    )).content[0].text as string;

    expect(text.indexOf('ConLiveTable')).toBeLessThan(text.indexOf('ConGhostTable'));
  });

  it('says so on the exact-match line, where a caller acts without reading on', async () => {
    mockIndexedPathIsMissing.mockImplementation(async (p) => p === GHOST_PATH);

    const text = (await searchTool(
      req({ query: 'ConGhostTable' }),
      buildContext([sym('ConGhostTable', GHOST_PATH)]),
    )).content[0].text as string;

    const exactLine = text.split('\n').find(l => l.includes('Exact name match')) ?? '';
    expect(exactLine).toContain('ConGhostTable');
    expect(exactLine).toMatch(/STALE/);
  });

  it('keeps a partial install searchable — every row missing locally is still an answer', async () => {
    // The shipped index covers every standard package; this machine has a subset.
    // Sweeping here is what turned search("CustTable") into a no-match.
    mockIndexedPathIsMissing.mockResolvedValue(true);

    const result = await searchTool(
      req({ query: 'CustTable' }),
      buildContext([
        sym('CustTable', 'K:\\PackagesLocalDirectory\\App\\Foundation\\AxTable\\CustTable.xml', 'table', 'Foundation'),
        sym('CustTableType', 'K:\\PackagesLocalDirectory\\App\\Foundation\\AxClass\\CustTableType.xml', 'class', 'Foundation'),
      ]),
    );
    const text = result.content[0].text as string;

    expect(text).toContain('Found 2 matches');
    expect(text).toContain('CustTable');
    expect(text).not.toContain('No X++ symbols found');
    expect(text).toMatch(/2 results marked STALE/);
  });

  it('says nothing at all when every row is live', async () => {
    const text = (await searchTool(
      req({ query: 'ConLiveTable' }),
      buildContext([sym('ConLiveTable', LIVE_PATH)]),
    )).content[0].text as string;

    expect(text).toContain('ConLiveTable');
    expect(text).not.toMatch(/STALE/);
  });
});
