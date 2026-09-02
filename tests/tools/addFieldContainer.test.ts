/**
 * Regression tests — add-field with a CONTAINER field on a table.
 *
 * Found while authoring the eval case L4-ssrs-report-logo-barcode (2026-09-02), which
 * stages a company logo into a report temp table. A logo is a `container`, and every
 * spelling of the request was refused:
 *
 *     fieldType="Container"      → "extended data type 'Container' does not exist —
 *                                   check the spelling, or create the EDT first"
 *     fieldBaseType="Container"  → "add-field requires fieldType (the EDT)"
 *
 * Both answers are wrong in the same way. `container` is a PRIMITIVE in X++ and never
 * an EDT name, so the first message sends the caller off to create an object that
 * cannot exist and the second demands a parameter with no legal value. The bridge had
 * handled `container` all along (CreateTableField switch) — only the TypeScript side
 * never routed to it, so a supported field type was unreachable through the tool.
 *
 * A census then corrected the case itself, which is the part worth keeping: of 332
 * container fields in shipped tables, 280 DO carry a container EDT (Bitmap 64 across
 * both casings, Blobdata 33, InfologData 23), and Bitmap is what a shipped report temp
 * table uses for a company logo. So the right answer for a logo is fieldType="Bitmap",
 * which the EDT ladder already handled. A bare container is legal — 52 shipped fields —
 * but draws BPErrorTableFieldNotDefinedUsingType, and this branch is what makes those
 * 52 reachable.
 *
 * The shape is the enum one: a base type and NO EDT. See addFieldEnum.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddField, mockBridgeModifyField, mockBridgeRemoveField, mockBridgeRefreshProvider } = vi.hoisted(() => ({
  mockBridgeAddField: vi.fn(async () => ({ success: true, message: '✅ Field added' })),
  mockBridgeModifyField: vi.fn(async () => ({ success: true, message: '✅ Field modified' })),
  mockBridgeRemoveField: vi.fn(async () => ({ success: true, message: '✅ Field removed' })),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddField: mockBridgeAddField,
    bridgeModifyField: mockBridgeModifyField,
    bridgeRemoveField: mockBridgeRemoveField,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) {
      return `<?xml version="1.0" encoding="utf-8"?>\n<AxTable><Name>ConChangeLog</Name><Fields /></AxTable>`;
    }
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
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
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
    getCustomPackagesPath: vi.fn(async () => null),
    getMicrosoftPackagesPath: vi.fn(async () => null),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

vi.mock('../../src/utils/packageResolver', () => ({
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (m: string) => ({
      packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const TABLE_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConChangeLog.xml';

const addFieldReq = (params: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'table',
      objectName: 'ConChangeLog',
      operation: 'add-field',
      filePath: TABLE_PATH,
      fieldName: 'QualityTier',
      ...params,
    },
  },
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
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((q: string) => `k:${q}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

beforeEach(() => {
  mockBridgeAddField.mockClear();
  mockBridgeModifyField.mockClear();
  mockBridgeRemoveField.mockClear();
  mockBridgeAddField.mockResolvedValue({ success: true, message: '✅ Field added' });
  mockBridgeModifyField.mockResolvedValue({ success: true, message: '✅ Field modified' });
  mockBridgeRemoveField.mockResolvedValue({ success: true, message: '✅ Field removed' });
});

describe('add-field — container field needs no EDT', () => {
  it('routes fieldBaseType="Container" to the bridge with no EDT', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldName: 'CompanyLogo', fieldBaseType: 'Container' }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const [, , fieldName, baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(fieldName).toBe('CompanyLogo');
    expect(baseType).toBe('Container');
    expect(edt).toBeUndefined();      // ← the EDT that cannot exist
  });

  it('accepts fieldType="Container" too, because that is what callers reach for', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldName: 'CompanyLogo', fieldType: 'Container' }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const [, , , baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(baseType).toBe('Container');
    expect(edt).toBeUndefined();
  });

  it('is case-insensitive, like the bridge switch it feeds', async () => {
    await modifyD365FileTool(
      addFieldReq({ fieldName: 'CompanyLogo', fieldBaseType: 'container' }),
      buildContext(),
    );
    expect((mockBridgeAddField.mock.calls[0] as any[])[3]).toBe('Container');
  });

  it('carries label and mandatory through the same single call', async () => {
    await modifyD365FileTool(
      addFieldReq({
        fieldName: 'CompanyLogo', fieldBaseType: 'Container',
        fieldLabel: '@Con:CompanyLogoField', fieldMandatory: true,
      }),
      buildContext(),
    );
    const [, , , , , mandatory, label] = mockBridgeAddField.mock.calls[0] as any[];
    expect(mandatory).toBe(true);
    expect(label).toBe('@Con:CompanyLogoField');
  });

  it('still refuses a field with no type at all, and now names Container as a way out', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldName: 'CompanyLogo' }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Container');
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });

  it('still refuses fieldBaseType="String" with no EDT — widening the mutation list must not open that door', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldName: 'Description', fieldBaseType: 'String' }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fieldType');
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });

  it('does not hijack an EDT whose name merely contains "container"', async () => {
    await modifyD365FileTool(
      addFieldReq({ fieldName: 'ContainerId', fieldType: 'WHSContainerId' }),
      buildContext(),
    );
    const [, , , baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(baseType).not.toBe('Container');
    expect(edt).toBe('WHSContainerId');
  });
});
