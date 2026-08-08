/**
 * d365fo_file [modify] — failures that state their own fix are applied, not returned.
 *
 * From the session audit (#824/#827): two add-field/field-group calls failed with an
 * error message that spelled out the exact corrected call, the agent re-issued that
 * call verbatim, and it succeeded. The round trip was pure cost — the server had
 * already reached the conclusion it refused to act on.
 *
 * The rule these tests pin: a correction is applied ONLY when there is exactly one
 * valid reading derivable from state the server already holds (the payload, the
 * symbol index, the base object's XML). Anything ambiguous still errors, and
 * autoCorrect=false restores the strict behaviour the eval harness depends on.
 *
 * The `Note:` wording is asserted verbatim — it is what the agent reads to learn
 * the correct form, so it must not drift silently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const {
  mockBridgeAddField,
  mockBridgeModifyField,
  mockBridgeRemoveField,
  mockBridgeAddFieldToFieldGroup,
  mockBridgeRefreshProvider,
} = vi.hoisted(() => ({
  mockBridgeAddField: vi.fn(async () => ({ success: true, message: '✅ Field added' })),
  mockBridgeModifyField: vi.fn(async () => ({ success: true, message: '✅ Field modified' })),
  mockBridgeRemoveField: vi.fn(async () => ({ success: true, message: '✅ Field removed' })),
  mockBridgeAddFieldToFieldGroup: vi.fn(async () => ({ success: true, message: '✅ Field added to group' })),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddField: mockBridgeAddField,
    bridgeModifyField: mockBridgeModifyField,
    bridgeRemoveField: mockBridgeRemoveField,
    bridgeAddFieldToFieldGroup: mockBridgeAddFieldToFieldGroup,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const BASE_TABLE_XML =
  `<?xml version="1.0" encoding="utf-8"?>\n<AxTable><Name>ConRentalAgreement</Name>` +
  `<FieldGroups>` +
  `<AxTableFieldGroup><Name>Administration</Name><Fields><AxTableFieldGroupField><DataField>CreatedBy</DataField></AxTableFieldGroupField></Fields></AxTableFieldGroup>` +
  `<AxTableFieldGroup><Name>AutoReport</Name><Fields /></AxTableFieldGroup>` +
  `</FieldGroups></AxTable>`;

const BASE_TABLE_PATH =
  'K:\\PackagesLocalDirectory\\AppSuite\\AppSuite\\AxTable\\ConRentalAgreement.xml';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('ConRentalAgreement.xml')) return BASE_TABLE_XML;
    if (typeof p === 'string' && p.endsWith('.xml')) {
      return `<?xml version="1.0" encoding="utf-8"?>\n<AxTableExtension><Name>ConRentalAgreement.ConExtension</Name><Fields /></AxTableExtension>`;
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
  // Members added to an extension are prefixed — the enum-name derivation has to
  // see through that (the field carries the prefix, the enum it names does not).
  resolveRegularObjectPrefixToken: vi.fn(() => 'Con'),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const EXT_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTableExtension\\ConRentalAgreement.ConExtension.xml';
const TABLE_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConChangeLog.xml';

/**
 * Symbol index stub: `indexedEnums` are the enum names the index knows, and the
 * base table resolves to a file the fs mock can read.
 */
const buildContext = (indexedEnums: string[] = []): XppServerContext => {
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn(() => []),
    run: vi.fn(),
    get: vi.fn((...params: any[]) => {
      if (/FROM symbols WHERE type = 'enum'/.test(sql)) {
        const wanted = String(params[0] ?? '').toLowerCase();
        const hit = indexedEnums.find(e => e.toLowerCase() === wanted);
        return hit ? { name: hit } : undefined;
      }
      if (/SELECT file_path FROM symbols WHERE type = \?/.test(sql)) {
        return params[0] === 'table' && params[1] === 'ConRentalAgreement'
          ? { file_path: BASE_TABLE_PATH }
          : undefined;
      }
      return undefined;
    }),
  }));
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare },
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

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const addFieldReq = (params: Record<string, unknown>) =>
  req({
    objectType: 'table',
    objectName: 'ConChangeLog',
    operation: 'add-field',
    filePath: TABLE_PATH,
    fieldName: 'ConQualityTier',
    ...params,
  });

const addToGroupReq = (params: Record<string, unknown>) =>
  req({
    objectType: 'table-extension',
    objectName: 'ConRentalAgreement.ConExtension',
    operation: 'add-field-to-field-group',
    filePath: EXT_PATH,
    fieldGroupName: 'Administration',
    fieldName: 'ConQualityTier',
    ...params,
  });

const GROUP_MISS_MESSAGE =
  `Bridge error [-32603]: Error in addFieldToFieldGroup: Field group 'Administration' not found on ` +
  `table-extension 'ConRentalAgreement.ConExtension'. If it is a group defined by the BASE table, pass ` +
  `extendBaseFieldGroup=true to append the field through <FieldGroupExtensions> instead.`;

const textOf = (result: any): string => (result.content?.[0] as any)?.text ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  mockBridgeAddField.mockResolvedValue({ success: true, message: '✅ Field added' });
  mockBridgeModifyField.mockResolvedValue({ success: true, message: '✅ Field modified' });
  mockBridgeRemoveField.mockResolvedValue({ success: true, message: '✅ Field removed' });
  mockBridgeAddFieldToFieldGroup.mockResolvedValue({ success: true, message: '✅ Field added to group' });
});

describe('add-field — fieldType="AxTableFieldEnum" is read as fieldEnumType when the enum is certain', () => {
  it('applies the call when the enum name is in the same payload', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'AxTableFieldEnum', fieldEnumType: 'ConQualityTier' }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const [, , fieldName, baseType, edt] = mockBridgeAddField.mock.calls[0] as any[];
    expect(fieldName).toBe('ConQualityTier');
    expect(baseType).toBe('Enum');
    expect(edt).toBeUndefined();          // the element name must NOT become an EDT
    expect(mockBridgeModifyField).toHaveBeenCalledWith(
      expect.anything(), 'ConChangeLog', 'ConQualityTier', { enumType: 'ConQualityTier' },
    );

    expect(textOf(result)).toContain(
      'Note: fieldType="AxTableFieldEnum" is an XML element name; treated as fieldEnumType="ConQualityTier". ' +
      'Pass fieldEnumType (and no fieldType) for an enum field.',
    );
    expect(textOf(result)).toContain('autoCorrect=false');
  });

  it('derives the enum from the field name when the symbol index confirms one', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'AxTableFieldEnum' }),
      buildContext(['ConQualityTier']),
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeModifyField).toHaveBeenCalledWith(
      expect.anything(), 'ConChangeLog', 'ConQualityTier', { enumType: 'ConQualityTier' },
    );
    expect(textOf(result)).toContain('treated as fieldEnumType="ConQualityTier"');
  });

  it('uses the enum spelling from the index, not the caller\'s casing', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldName: 'conqualitytier', fieldType: 'AxTableFieldEnum' }),
      buildContext(['ConQualityTier']),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('treated as fieldEnumType="ConQualityTier"');
  });

  it('sees through the extension member prefix applied to the field name', async () => {
    // The caller asks for field "QualityTier" on a table-extension; the tool renames
    // it to "ConQualityTier" before the write. The enum is still "QualityTier".
    const result = await modifyD365FileTool(
      req({
        objectType: 'table-extension',
        objectName: 'ConRentalAgreement.ConExtension',
        operation: 'add-field',
        filePath: EXT_PATH,
        fieldName: 'QualityTier',
        fieldType: 'AxTableFieldEnum',
      }),
      buildContext(['QualityTier']),
    );

    expect(result.isError).toBeFalsy();
    const [, , fieldName] = mockBridgeAddField.mock.calls[0] as any[];
    expect(fieldName).toBe('ConQualityTier');       // prefix still applied to the field
    expect(textOf(result)).toContain('treated as fieldEnumType="QualityTier"');
  });

  it('still refuses when no enum can be derived', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'AxTableFieldEnum' }),
      buildContext(),                                // index knows no such enum
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is an XML element name, not an EDT');
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });

  it('still refuses the other AxTableField* element names, enum name or not', async () => {
    for (const bad of ['AxTableFieldString', 'AxTableFieldReal', 'AxTableFieldInt64']) {
      const result = await modifyD365FileTool(
        addFieldReq({ fieldType: bad, fieldEnumType: 'ConQualityTier' }),
        buildContext(['ConQualityTier']),
      );
      expect(result.isError, bad).toBe(true);
    }
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });

  it('autoCorrect=false reproduces the strict refusal', async () => {
    const result = await modifyD365FileTool(
      addFieldReq({ fieldType: 'AxTableFieldEnum', fieldEnumType: 'ConQualityTier', autoCorrect: false }),
      buildContext(['ConQualityTier']),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is an XML element name, not an EDT');
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });
});

describe('add-field-to-field-group — a base-table group is extended, not refused', () => {
  it('retries through <FieldGroupExtensions> when the base table defines the group', async () => {
    mockBridgeAddFieldToFieldGroup
      .mockResolvedValueOnce({ success: false, message: GROUP_MISS_MESSAGE })
      .mockResolvedValueOnce({ success: true, message: "✅ Field 'ConQualityTier' added to group 'Administration' in <FieldGroupExtensions>" });

    const result = await modifyD365FileTool(addToGroupReq({}), buildContext());

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddFieldToFieldGroup).toHaveBeenCalledTimes(2);
    const secondCall = mockBridgeAddFieldToFieldGroup.mock.calls[1] as any[];
    expect(secondCall[4]).toBe(true);               // extendBaseFieldGroup

    expect(textOf(result)).toContain(
      `Note: 'Administration' is defined by the base table "ConRentalAgreement"; extended it through ` +
      `<FieldGroupExtensions> instead of creating a new group. ` +
      `Pass extendBaseFieldGroup=true for a base-table group.`,
    );
  });

  it('does not retry when the base table has no such group', async () => {
    mockBridgeAddFieldToFieldGroup.mockResolvedValue({
      success: false,
      message: GROUP_MISS_MESSAGE.replace(/Administration/g, 'Nonexistent'),
    });

    const result = await modifyD365FileTool(
      addToGroupReq({ fieldGroupName: 'Nonexistent' }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    expect(mockBridgeAddFieldToFieldGroup).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain('extendBaseFieldGroup=true');   // the bridge's own guidance
  });

  it('leaves an explicit extendBaseFieldGroup=false alone — that is a decision, not an omission', async () => {
    mockBridgeAddFieldToFieldGroup.mockResolvedValue({ success: false, message: GROUP_MISS_MESSAGE });

    const result = await modifyD365FileTool(
      addToGroupReq({ extendBaseFieldGroup: false }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    expect(mockBridgeAddFieldToFieldGroup).toHaveBeenCalledTimes(1);
  });

  it('autoCorrect=false reproduces the strict failure', async () => {
    mockBridgeAddFieldToFieldGroup.mockResolvedValue({ success: false, message: GROUP_MISS_MESSAGE });

    const result = await modifyD365FileTool(
      addToGroupReq({ autoCorrect: false }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    expect(mockBridgeAddFieldToFieldGroup).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("Field group 'Administration' not found");
  });

  it('adds no note when the first call already succeeds', async () => {
    const result = await modifyD365FileTool(
      addToGroupReq({ extendBaseFieldGroup: true }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddFieldToFieldGroup).toHaveBeenCalledTimes(1);
    expect(textOf(result)).not.toContain('Note:');
  });
});
