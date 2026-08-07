/**
 * Regression tests — add-field with an enum type on a table / table-extension.
 *
 * From a live demo (2026-08-07). Asked to add an enum field, the agent needed eight
 * write→build→fail rounds to land one field, and every round was our contract, not
 * its reasoning:
 *
 *  1. `fieldType="AxTableFieldEnum"` was accepted. That key IS the XML element name
 *     on `create` (fields[].fieldType), so carrying it to add-field is the obvious
 *     move — and it produced an AxTableFieldString referencing an EDT named
 *     "AxTableFieldEnum", discovered only at build time.
 *  2. add-field always wrote <ExtendedDataType>, so an enum field looked like it
 *     needed an EDT. It does not: AxTableFieldEnum + <EnumType> is the whole shape.
 *     Chasing the phantom EDT cost two more builds ("Extends Enum does not exist").
 *
 * The bridge's AddField RPC has no enumType parameter — only ModifyField does — so
 * EnumType is set in a follow-up call. That is deliberate: it keeps this ONE tool
 * call for the caller while working with the bridge binary already deployed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
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

describe('add-field — enum field needs no EDT', () => {
  it('writes an Enum base type and sets EnumType, with no EDT reference', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldEnumType: 'ConQualityTier' }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const [, , fieldName, baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(fieldName).toBe('QualityTier');
    expect(baseType).toBe('Enum');
    expect(edt).toBeUndefined();      // ← the phantom EDT that cost three builds

    expect(mockBridgeModifyField).toHaveBeenCalledWith(
      expect.anything(), 'ConChangeLog', 'QualityTier', { enumType: 'ConQualityTier' },
    );
  });

  it('carries label and mandatory through the same single call', async () => {
    await modifyD365FileTool(
      addFieldReq({ fieldEnumType: 'ConQualityTier', fieldLabel: '@Con:QualityTierField', fieldMandatory: true }),
      buildContext(),
    );

    const [, , , , , mandatory, label] = mockBridgeAddField.mock.calls[0] as any[];
    expect(mandatory).toBe(true);
    expect(label).toBe('@Con:QualityTierField');
  });

  it('rolls the field back when EnumType cannot be set', async () => {
    // The two calls are not atomic. What a failure can leave behind is a field
    // nobody asked for — and since the bridge's AddField does not check for an
    // existing field, an agent that reads "failed" and repeats the call ends up
    // with it twice. A failed operation may only leave the pre-call state.
    mockBridgeModifyField.mockResolvedValue({ success: false, message: 'enum not found' });
    mockBridgeRemoveField.mockResolvedValue({ success: true, message: '✅ Field removed' });

    const result = await modifyD365FileTool(
      addFieldReq({ fieldEnumType: 'ConQualityTier' }),
      buildContext(),
    );

    expect(mockBridgeRemoveField).toHaveBeenCalledWith(
      expect.anything(), 'ConChangeLog', 'QualityTier',
    );
    const text = (result.content?.[0] as any)?.text ?? '';
    expect(text).toContain('rolled back');
    expect(text).toContain('nothing was written');
  });

  it('warns against a retry when the rollback fails too', async () => {
    mockBridgeModifyField.mockResolvedValue({ success: false, message: 'enum not found' });
    mockBridgeRemoveField.mockResolvedValue({ success: false, message: 'locked' });

    const result = await modifyD365FileTool(
      addFieldReq({ fieldEnumType: 'ConQualityTier' }),
      buildContext(),
    );

    const text = (result.content?.[0] as any)?.text ?? '';
    expect(text).toContain('EnumType could not be set');
    expect(text).toContain('do NOT repeat add-field');
    expect(text).toContain('modify-field');
  });

  it('still accepts an explicit enum EDT alongside fieldEnumType', async () => {
    await modifyD365FileTool(
      addFieldReq({ fieldEnumType: 'NoYes', fieldType: 'NoYesId' }),
      buildContext(),
    );

    const [, , , baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(baseType).toBe('Enum');
    expect(edt).toBe('NoYesId');
  });
});

/**
 * Both rules pass the compiler and fail the BP checker, so they used to surface
 * only after a build — and the label one then invalidates labels already written.
 */
describe('add-field — BP rules that fire later are named now', () => {
  it('tells the caller the field still needs a field group', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'TransDate', fieldBaseType: 'Date' }),
      buildContext(),
    );

    const text = (result.content?.[0] as any)?.text ?? '';
    expect(text).toContain('BPErrorTableFieldNotInFieldGroup');
    expect(text).toContain('add-field-to-field-group');
  });

  it('warns about the enum label copy only for enum fields', async () => {
    const enumResult = await modifyD365FileTool(
      addFieldReq({ fieldEnumType: 'ConQualityTier' }),
      buildContext(),
    );
    expect((enumResult.content?.[0] as any)?.text).toContain('BPErrorFieldLabelIsCopyOfEnumLabel');

    const plainResult = await modifyD365FileTool(
      addFieldReq({ fieldType: 'TransDate', fieldBaseType: 'Date' }),
      buildContext(),
    );
    expect((plainResult.content?.[0] as any)?.text).not.toContain('IsCopyOfEnumLabel');
  });
});

describe('add-field — fieldType is an EDT name, never an XML element name', () => {
  it('refuses fieldType="AxTableFieldEnum" and points at fieldEnumType', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'AxTableFieldEnum' }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as any)?.text ?? '';
    expect(text).toContain('is an XML element name, not an EDT');
    expect(text).toContain('fieldEnumType');
    expect(mockBridgeAddField).not.toHaveBeenCalled();   // nothing written
  });

  it('refuses the other AxTableField* element names too', async () => {
    for (const bad of ['AxTableFieldString', 'AxTableFieldReal', 'AxTableFieldInt64']) {
      const result = await modifyD365FileTool(addFieldReq({ fieldType: bad }), buildContext());
      expect(result.isError).toBe(true);
    }
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });

  it('leaves ordinary EDT names alone', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'TransDate', fieldBaseType: 'Date' }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const [, , , baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(baseType).toBe('Date');
    expect(edt).toBe('TransDate');
  });

  it('names fieldEnumType when neither an EDT nor an enum was given', async () => {
    const result = await modifyD365FileTool(addFieldReq({}), buildContext());

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as any)?.text).toContain('fieldEnumType');
  });
});
