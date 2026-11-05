/**
 * search — the owner on the exact-match line is for members only.
 *
 * The owner tells three fields called SalesLine on three tables apart. An extension
 * is an object, not a member, yet its index row carries the base object as
 * parentName, so the line read OrganizationAdministration.OrganizationAdministration.
 * ContosoExtension for a menu extension (seen on a dev VM), and
 * SalesTable.SalesTableContoso_Extension for a class extension — a member of
 * SalesTable, to the reader.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/indexedXmlLookup', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/indexedXmlLookup')>();
  return { ...actual, indexedPathIsMissing: async () => false };
});

// The workspace-aware path validates the folder against the configured roots first.
vi.mock('../../src/workspace/workspaceUtils', async (orig) => {
  const actual = await orig<typeof import('../../src/workspace/workspaceUtils')>();
  return { ...actual, validateWorkspacePath: async () => ({ valid: true }) };
});

import { searchTool } from '../../src/tools/analysis/search';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'search', arguments: args },
});

const sym = (name: string, type: string, parentName?: string) => ({
  id: 1, name, type, parentName, signature: parentName, model: 'Contoso',
  filePath: `K:\\PackagesLocalDirectory\\Contoso\\Contoso\\Ax\\${name}.xml`,
});

/** No bridge — the index-only answer. */
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

async function exactLine(query: string, rows: any[]): Promise<string> {
  const text = (await searchTool(req({ query }), buildContext(rows))).content[0].text as string;
  return text.split('\n').find(l => l.includes('Exact name match')) ?? '';
}

describe('exact-match line', () => {
  it('names an extension once, without its base object in front', async () => {
    const line = await exactLine('ContosoMain.ContosoExt', [sym('ContosoMain.ContosoExt', 'menu-extension', 'ContosoMain')]);
    expect(line).toContain('**Exact name match:** ContosoMain.ContosoExt (menu-extension) in Contoso');
    expect(line).not.toContain('ContosoMain.ContosoMain.');
  });

  it('does not make a class extension read as a member of its base class', async () => {
    const line = await exactLine('SalesTableContoso_Extension', [sym('SalesTableContoso_Extension', 'class-extension', 'SalesTable')]);
    expect(line).toContain('**Exact name match:** SalesTableContoso_Extension (class-extension)');
  });

  it('keeps the owner on members, where it tells same-named ones apart', async () => {
    const line = await exactLine('ContosoLine', [
      sym('ContosoLine', 'field', 'ContosoTable'),
      sym('ContosoLine', 'field', 'ContosoOtherTable'),
    ]);
    expect(line).toContain('ContosoTable.ContosoLine (field)');
    expect(line).toContain('ContosoOtherTable.ContosoLine (field)');
  });
});

describe('workspace-aware listing', () => {
  /** includeWorkspace + workspacePath: rows come from hybridSearch, one line per hit. */
  async function hybridText(query: string, rows: any[]): Promise<string> {
    const ctx = buildContext([]) as any;
    ctx.hybridSearch = {
      search: vi.fn(async () => rows.map(symbol => ({ source: 'external', symbol }))),
    };
    const res = await searchTool(req({ query, includeWorkspace: true, workspacePath: 'K:/Contoso' }), ctx);
    return res.content[0].text as string;
  }

  it('names an extension once there too', async () => {
    const text = await hybridText('ContosoMain.ContosoExt', [sym('ContosoMain.ContosoExt', 'menu-extension', 'ContosoMain')]);
    expect(text).toContain('[MENU-EXTENSION] ContosoMain.ContosoExt');
    expect(text).not.toContain('ContosoMain.ContosoMain.');
  });

  it('keeps the owner on a member there', async () => {
    const text = await hybridText('ContosoLine', [sym('ContosoLine', 'field', 'ContosoTable')]);
    expect(text).toContain('[FIELD] ContosoTable.ContosoLine');
  });
});
