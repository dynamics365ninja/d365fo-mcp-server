/**
 * Regression tests — CDATA-corruption guard (assertCleanXppSource)
 *
 * Reproduces the observed corruption where a method's `<Source>` payload that
 * already contained XML/CDATA markup (a "]]>" terminator and/or a stray
 * <Method> tag) survived into the file, yielding invalid XML:
 *
 *     …    }
 *     ]]>]]></Source>           ← doubled "]]>"
 *           <Method>             ← previous </Method> dropped
 *
 * Method source is CDATA-wrapped by the D365FO serializer, so such a payload is
 * always a slice of .xml the AI pasted where clean X++ was expected. The guard
 * must reject it BEFORE any bridge write — never reaching disk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool, assertCleanXppSource } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Bridge mock — assert these are NEVER called for a poisoned payload ───────

const { mockBridgeAddMethod, mockBridgeReplaceCode } = vi.hoisted(() => ({
  mockBridgeAddMethod: vi.fn(async () => ({ success: true, message: '✅ added' })),
  mockBridgeReplaceCode: vi.fn(async () => ({ success: true, message: '✅ replaced' })),
}));

vi.mock('../../src/bridge/index', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/index')>();
  return {
    ...actual,
    bridgeAddMethod: mockBridgeAddMethod,
    bridgeReplaceCode: mockBridgeReplaceCode,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return CLASS_XML;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  // modify_d365fo_file forces a backup for edits outside git (0432c5d) —
  // without this the tool fails before it ever reaches the bridge.
  copyFile: vi.fn(async () => {}),
  // The direct-XML writes go through writeFileAtomic: a temp sibling written with
  // writeFile, then renamed over the target (rm cleans the temp up on failure).
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    // Writes are measured against the anchor, not the active model (see getWriteAnchorModel).
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getToolProjectSwitch: vi.fn(() => null),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CLASS_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxClass>
  <Name>MyClass</Name>
  <SourceCode>
    <Declaration><![CDATA[class MyClass {}]]></Declaration>
    <Methods>
      <Method>
        <Name>modifiedField</Name>
        <Source><![CDATA[public void modifiedField(FieldId _id)
{
    super(_id);
}]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>`;

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\MyClass.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare: vi.fn(() => stmt) },
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

// ─── Unit-level guard ────────────────────────────────────────────────────────

describe('assertCleanXppSource', () => {
  it('rejects a payload containing the CDATA terminator "]]>"', () => {
    expect(() => assertCleanXppSource('void m()\n{\n}\n]]></Source>', 'sourceCode'))
      .toThrow(/CDATA terminator|\]\]>/);
  });

  it('rejects a payload containing a stray <Method> tag', () => {
    expect(() => assertCleanXppSource('void m() {}\n<Method>\n<Name>foo</Name>', 'sourceCode'))
      .toThrow(/metadata token|<Method>/);
  });

  it('rejects a payload containing <![CDATA[', () => {
    expect(() => assertCleanXppSource('<Source><![CDATA[void m(){}', 'sourceCode'))
      .toThrow(/metadata token|CDATA/);
  });

  it('accepts clean X++ that uses < and > (generics, comparisons, doc comments)', () => {
    const clean =
      `/// <summary>\n/// Does work.\n/// </summary>\n` +
      `public void run()\n{\n    List<str> items = new List(Types::String);\n    if (a < b && b > c) { info("ok"); }\n}`;
    expect(() => assertCleanXppSource(clean, 'sourceCode')).not.toThrow();
  });

  it('accepts undefined / empty source', () => {
    expect(() => assertCleanXppSource(undefined, 'sourceCode')).not.toThrow();
    expect(() => assertCleanXppSource('', 'sourceCode')).not.toThrow();
  });
});

// ─── Tool-level: poisoned payload must not reach the bridge ───────────────────

describe('modify_d365fo_file CDATA-corruption guard (regression)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeAddMethod.mockClear();
    mockBridgeReplaceCode.mockClear();
  });

  it('add-method: rejects sourceCode with "]]>" before any bridge write', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'class',
        objectName: 'MyClass',
        operation: 'add-method',
        methodName: 'AC_defaultTaxItemGroupFromAsset',
        sourceCode: 'public void AC_defaultTaxItemGroupFromAsset()\n{\n}\n]]></Source>\n</Method>',
        filePath: FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/\]\]>|CDATA/);
    expect(mockBridgeAddMethod).not.toHaveBeenCalled();
  });

  it('replace-code: rejects newCode with a stray </Method> before any bridge write', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'class',
        objectName: 'MyClass',
        operation: 'replace-code',
        methodName: 'modifiedField',
        oldCode: 'super(_id);',
        newCode: 'super(_id);\n]]></Source>\n</Method>',
        filePath: FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/\]\]>|CDATA|Method/);
    expect(mockBridgeReplaceCode).not.toHaveBeenCalled();
  });

  it('add-method: clean X++ source passes the guard and reaches the bridge', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'class',
        objectName: 'MyClass',
        operation: 'add-method',
        methodName: 'AC_defaultTaxItemGroupFromAsset',
        sourceCode: 'public void AC_defaultTaxItemGroupFromAsset()\n{\n    List<str> x = new List(Types::String);\n}',
        filePath: FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddMethod).toHaveBeenCalledTimes(1);
  });
});
