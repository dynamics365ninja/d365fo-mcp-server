/**
 * Method Signature & Source Fallback Tests (Issue #391)
 *
 * Validates the fallback chain for get_method_signature and get_method_source:
 *   1. Cache → 2. Bridge → 3. XML parser → 4. SQLite signature (methodSignature only) → Error
 *
 * Tests verify that when the C# bridge is unavailable, both tools gracefully
 * fall back to XML file parsing and (for methodSignature) SQLite-only responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMethodSignatureTool } from '../../src/tools/methodSignature';
import { getMethodSourceTool } from '../../src/tools/getMethodSource';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock bridgeAdapter — tryBridgeMethodSource is the sole bridge call in getMethodSource
const { mockTryBridgeMethodSource } = vi.hoisted(() => ({
  mockTryBridgeMethodSource: vi.fn(async () => null),
}));
vi.mock('../../src/bridge/bridgeAdapter', () => ({
  tryBridgeMethodSource: mockTryBridgeMethodSource,
  tryBridgeClass: vi.fn(async () => null),
  tryBridgeTable: vi.fn(async () => null),
}));

vi.mock('../../src/utils/metadataResolver', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/metadataResolver')>();
  return { ...actual, buildObjectTypeMismatchMessage: vi.fn(() => '') };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const makeStmt = (rows: any[] = [], row: any = undefined) => ({
  all: vi.fn(() => rows),
  get: vi.fn(() => row),
  run: vi.fn(() => ({ changes: 0 })),
});

const buildContext = (overrides: Partial<XppServerContext> = {}): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getClassMethods: vi.fn(() => []),
    getTableFields: vi.fn(() => []),
    searchLabels: vi.fn(() => []),
    getCustomModels: vi.fn(() => []),
    db: { prepare: vi.fn(() => makeStmt()) },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  } as any,
  parser: {
    parseClassFile: vi.fn(async () => ({ success: false })),
    parseTableFile: vi.fn(async () => ({ success: false })),
  } as any,
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
  termRelationshipGraph: {} as any,
  ...overrides,
});

const classRow = { file_path: '/Classes/TestClass.xml', model: 'TestModel', name: 'TestClass', type: 'class' };
const methodRow = { name: 'run', signature: 'public void run()', parent_name: 'TestClass', file_path: '/Classes/TestClass.xml' };

const SAMPLE_SOURCE = 'public void run()\n{\n    info("Hello");\n}';

// ─── get_method_signature fallback chain ─────────────────────────────────────

describe('get_method_signature fallback chain', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    // Default: class + method found in DB
    const stmt = {
      get: vi.fn()
        .mockReturnValueOnce(classRow)   // class lookup
        .mockReturnValueOnce(methodRow), // method lookup
      all: vi.fn(() => []),
      run: vi.fn(),
    };
    ctx.symbolIndex.db.prepare = vi.fn(() => stmt) as any;
  });

  it('returns signature from bridge when bridge is available', async () => {
    ctx.bridge = {
      isReady: true,
      metadataAvailable: true,
      getMethodSource: vi.fn(async () => ({ found: true, source: SAMPLE_SOURCE })),
    } as any;

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run');
    expect(result.content[0].text).toContain('void');
  });

  it('falls back to XML parser when bridge is unavailable', async () => {
    // No bridge configured
    ctx.bridge = undefined;
    // XML parser returns the class with methods
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({
      success: true,
      data: {
        name: 'TestClass',
        model: 'TestModel',
        methods: [{ name: 'run', source: SAMPLE_SOURCE }],
      },
    });

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run');
    expect(result.content[0].text).toContain('void');
  });

  it('falls back to XML parser when bridge returns no source', async () => {
    ctx.bridge = {
      isReady: true,
      metadataAvailable: true,
      getMethodSource: vi.fn(async () => ({ found: false, source: null })),
    } as any;
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({
      success: true,
      data: {
        name: 'TestClass',
        model: 'TestModel',
        methods: [{ name: 'run', source: SAMPLE_SOURCE }],
      },
    });

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run');
  });

  it('falls back to SQLite signature when both bridge and XML fail', async () => {
    ctx.bridge = undefined;
    // XML parser fails
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({ success: false });

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    // SQLite fallback — methodRow.signature is available
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run');
    expect(result.content[0].text).toMatch(/SQLite.*index/i);
  });

  it('returns error when all fallbacks fail and no SQLite signature', async () => {
    // Method row without signature
    const methodRowNoSig = { name: 'run', signature: null, parent_name: 'TestClass', file_path: '/Classes/TestClass.xml' };
    const stmt = {
      get: vi.fn()
        .mockReturnValueOnce(classRow)
        .mockReturnValueOnce(methodRowNoSig),
      all: vi.fn(() => []),
      run: vi.fn(),
    };
    ctx.symbolIndex.db.prepare = vi.fn(() => stmt) as any;
    ctx.bridge = undefined;
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({ success: false });

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no source available/i);
  });

  it('handles XML parser timeout gracefully', async () => {
    ctx.bridge = undefined;
    // Parser hangs — simulate with a never-resolving promise
    (ctx.parser.parseClassFile as any).mockImplementationOnce(
      () => new Promise(() => {}), // never resolves
    );

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    // Should still get SQLite fallback, not hang
    expect(result.content[0].text).toBeDefined();
  });

  it('detects obsolete methods via XML fallback', async () => {
    ctx.bridge = undefined;
    const obsoleteSource = "[SysObsolete('Use newRun instead')]\npublic void run()\n{\n}";
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({
      success: true,
      data: {
        name: 'TestClass',
        model: 'TestModel',
        methods: [{ name: 'run', source: obsoleteSource }],
      },
    });

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/obsolete/i);
  });

  it('returns cached result when available', async () => {
    const cachedResult = { content: [{ type: 'text', text: 'cached: void run()' }] };
    (ctx.cache.get as any).mockResolvedValueOnce(cachedResult);

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result).toEqual(cachedResult);
  });

  it('includes CoC template when includeCocTemplate is true', async () => {
    ctx.bridge = {
      isReady: true,
      metadataAvailable: true,
      getMethodSource: vi.fn(async () => ({ found: true, source: SAMPLE_SOURCE })),
    } as any;

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run', includeCocTemplate: true }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/ExtensionOf|next run/);
  });

  it('method name matching is case-insensitive in XML fallback', async () => {
    ctx.bridge = undefined;
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({
      success: true,
      data: {
        name: 'TestClass',
        model: 'TestModel',
        methods: [{ name: 'Run', source: 'public void Run()\n{\n}' }], // capital R
      },
    });

    const result = await getMethodSignatureTool(
      req('get_method_signature', { className: 'TestClass', methodName: 'run' }), // lowercase r
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // The tool finds 'Run' via case-insensitive match and returns the signature
    expect(result.content[0].text).toContain('public void');
    expect(result.content[0].text).toMatch(/run/i);
  });
});

// ─── get_method_source fallback chain ────────────────────────────────────────

describe('get_method_source fallback chain', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockTryBridgeMethodSource.mockReset();
  });

  it('returns source from bridge when available', async () => {
    mockTryBridgeMethodSource.mockResolvedValueOnce({
      content: [{ type: 'text', text: '## TestClass.run\n```xpp\npublic void run()\n{\n}\n```' }],
    });

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run');
  });

  it('falls back to XML parser when bridge returns null', async () => {
    mockTryBridgeMethodSource.mockResolvedValueOnce(null);

    // Set up DB for XML fallback path
    const stmt = {
      get: vi.fn().mockReturnValueOnce({ file_path: '/Classes/TestClass.xml', model: 'TestModel', type: 'class' }),
      all: vi.fn(() => []),
      run: vi.fn(),
    };
    ctx.symbolIndex.db.prepare = vi.fn(() => stmt) as any;

    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({
      success: true,
      data: {
        name: 'TestClass',
        model: 'TestModel',
        methods: [{ name: 'run', source: SAMPLE_SOURCE }],
      },
    });

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run');
    expect(result.content[0].text).toMatch(/XML file parsing/i);
  });

  it('detects obsolete methods in XML fallback', async () => {
    mockTryBridgeMethodSource.mockResolvedValueOnce(null);

    const stmt = {
      get: vi.fn().mockReturnValueOnce({ file_path: '/Classes/TestClass.xml', model: 'TestModel', type: 'class' }),
      all: vi.fn(() => []),
      run: vi.fn(),
    };
    ctx.symbolIndex.db.prepare = vi.fn(() => stmt) as any;

    const obsoleteSource = "[SysObsolete('Use runV2 instead')]\npublic void run()\n{\n}";
    (ctx.parser.parseClassFile as any).mockResolvedValueOnce({
      success: true,
      data: {
        name: 'TestClass',
        model: 'TestModel',
        methods: [{ name: 'run', source: obsoleteSource }],
      },
    });

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/obsolete/i);
    expect(result.content[0].text).toContain('runV2');
  });

  it('shows fuzzy suggestions when both bridge and XML fail', async () => {
    mockTryBridgeMethodSource.mockResolvedValueOnce(null);

    // DB returns no class row for XML fallback
    const stmtNoClass = {
      get: vi.fn().mockReturnValueOnce(undefined),
      all: vi.fn(() => []),
      run: vi.fn(),
    };
    // Second DB call for fuzzy suggestions
    const stmtSuggestions = {
      all: vi.fn(() => [{ name: 'runAsync', signature: 'public void runAsync()' }]),
      get: vi.fn(),
      run: vi.fn(),
    };
    let callCount = 0;
    ctx.symbolIndex.db.prepare = vi.fn(() => callCount++ === 0 ? stmtNoClass : stmtSuggestions) as any;

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it('handles XML parser timeout gracefully', async () => {
    mockTryBridgeMethodSource.mockResolvedValueOnce(null);

    const stmt = {
      get: vi.fn().mockReturnValueOnce({ file_path: '/Classes/TestClass.xml', model: 'TestModel', type: 'class' }),
      all: vi.fn(() => []),
      run: vi.fn(),
    };
    ctx.symbolIndex.db.prepare = vi.fn(() => stmt) as any;

    // Parser hangs
    (ctx.parser.parseClassFile as any).mockImplementationOnce(
      () => new Promise(() => {}),
    );

    const result = await getMethodSourceTool(
      req('get_method_source', { className: 'TestClass', methodName: 'run' }),
      ctx,
    );
    // Should not hang — should fall through to error path
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});
