/**
 * The Azure read-only path for method bodies.
 *
 * Neither reader ahead of the index can run on an App Service: the bridge is a
 * .NET Framework process and the XML path reads PackagesLocalDirectory. Before
 * the index fallback, `get_object_info(options:{method,include:"source"})`
 * answered "not found" there for a body it had indexed, and the class reader
 * rendered "signatures only". These pin both to the body instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMethodSourceTool } from '../../src/tools/readers/getMethodSource';
import { classInfoTool } from '../../src/tools/readers/classInfo';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/bridge/bridgeAdapter', () => ({
  tryBridgeMethodSource: vi.fn(async () => null),
  tryBridgeClass: vi.fn(async () => null),
  tryBridgeTable: vi.fn(async () => null),
}));

vi.mock('../../src/utils/metadataResolver', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/metadataResolver')>();
  return { ...actual, buildObjectTypeMismatchMessage: vi.fn(() => '') };
});

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const BODY = [
  'static CustTable find(CustAccount _custAccount, boolean _forUpdate = false)',
  '{',
  '    CustTable custTable;',
  '    if (_custAccount)',
  '    {',
  '        select firstonly custTable where custTable.AccountNum == _custAccount;',
  '    }',
  '    return custTable;',
  '}',
].join('\n');

/**
 * A db that answers by SQL shape, so the readers' several different queries
 * (canonicalization, owner lookup, method body) each get the right rows.
 */
function makeDb(opts: { body?: string | null; methods?: any[] } = {}) {
  const body = opts.body === undefined ? BODY : opts.body;
  const methodRow = { name: 'find', source: body, signature: 'static CustTable find()', model: 'Foundation' };

  return {
    prepare(sql: string) {
      const flat = sql.replace(/\s+/g, ' ');
      const isBodyQuery = flat.includes("type = 'method'") && flat.includes('parent_name = ?');
      const rows = isBodyQuery ? (opts.methods ?? [methodRow]) : [];
      return {
        get: (..._p: unknown[]) => (isBodyQuery ? rows[0] : { name: 'CustTable', type: 'table', model: 'Foundation', file_path: 'K:/Packages/CustTable.xml' }),
        all: (..._p: unknown[]) => rows,
        run: () => ({ changes: 0 }),
      };
    },
  };
}

function buildContext(db: any, overrides: Partial<XppServerContext> = {}): XppServerContext {
  return {
    symbolIndex: {
      db,
      getReadDb: vi.fn(() => db),
      getSymbolByName: vi.fn(() => ({ name: 'CustTable', model: 'Foundation', filePath: 'K:/Packages/CustTable.xml' })),
      getClassMethods: vi.fn(() => [{ name: 'find', signature: 'static CustTable find()' }]),
      searchSymbols: vi.fn(() => []),
      getTableFields: vi.fn(() => []),
      searchLabels: vi.fn(() => []),
      getCustomModels: vi.fn(() => []),
    } as any,
    // Azure: no PackagesLocalDirectory, so every parse fails.
    parser: {
      parseClassFile: vi.fn(async () => ({ success: false, error: 'ENOENT' })),
      parseTableFile: vi.fn(async () => ({ success: false, error: 'ENOENT' })),
      parseViewFile: vi.fn(async () => ({ success: false, error: 'ENOENT' })),
    } as any,
    bridge: undefined,
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      setClassInfo: vi.fn(async () => {}),
      generateSearchKey: vi.fn((q: string) => `k:${q}`),
      generateClassKey: vi.fn((n: string) => `c:${n}`),
      generateTableKey: vi.fn((n: string) => `t:${n}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    ...overrides,
  } as XppServerContext;
}

describe('method source with no bridge and no metadata files (Azure read-only)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext(makeDb());
  });

  it('returns the indexed body instead of "not found"', async () => {
    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'CustTable', methodName: 'find' }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('select firstonly custTable');
    expect(text).toContain('return custTable;');
  });

  it('says the body came from the index, so a stale answer is attributable', async () => {
    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'CustTable', methodName: 'find' }),
      ctx,
    );
    expect(result.content[0].text).toContain('symbol index');
  });

  it('still reports not-found when the index has no body either', async () => {
    const empty = buildContext(makeDb({ methods: [] }));

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'CustTable', methodName: 'find' }),
      empty,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('does not invent a body from a row indexed before the source column existed', async () => {
    const nullSource = buildContext(makeDb({ body: null }));

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'CustTable', methodName: 'find' }),
      nullSource,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('```xpp\n\n```');
  });

  it('carries the obsolete warning through the index path', async () => {
    const obsolete = buildContext(makeDb({
      methods: [{ name: 'oldWay', source: '[SysObsolete("Use newWay", false)]\nvoid oldWay() {}', signature: null, model: 'Foundation' }],
    }));

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'CustTable', methodName: 'oldWay' }),
      obsolete,
    );

    expect(result.content[0].text).toContain('marked obsolete');
    expect(result.content[0].text).toContain('Use newWay');
  });
});

describe('class listing with compact:false and no metadata files', () => {
  it('renders indexed bodies rather than falling back to signatures only', async () => {
    const ctx = buildContext(makeDb());

    const result = await classInfoTool(
      req('class_info', { className: 'CustTable', compact: false }),
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain('```xpp');
    expect(text).toContain('CustTable custTable;');
    // And it tells the reader the bodies are a snapshot, not live metadata.
    expect(text).toContain('symbol index');
  });

  it('keeps compact:true as the cheap signatures-only view — the index is not consulted', async () => {
    const db = makeDb();
    const spy = vi.spyOn(db, 'prepare');
    const ctx = buildContext(db);

    const result = await classInfoTool(
      req('class_info', { className: 'CustTable', compact: true }),
      ctx,
    );

    const text = result.content[0].text;
    expect(text).not.toContain('```xpp');
    const bodyQueries = spy.mock.calls
      .map(c => String(c[0]).replace(/\s+/g, ' '))
      .filter(s => s.includes('source') && s.includes("type = 'method'"));
    expect(bodyQueries).toHaveLength(0);
  });
});
