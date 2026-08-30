/**
 * add-field must derive the field's base type from the EDT the way create does.
 *
 * Phase F, L2-date-effective-table on the VM: `add-field fieldName="ValidFrom"
 * fieldType="FromDate"` wrote `<AxTableField i:type="AxTableFieldString">` with
 * `<ExtendedDataType>FromDate</ExtendedDataType>` and xppc rejected the table with
 * "Data type mismatch". The old resolver walked FromDate → TransDate, found a root
 * EDT the index does not record a primitive for, and handed the bridge the ROOT
 * EDT NAME ("TransDate") as the base type — the bridge then defaulted to String.
 * create's fields[] never had this problem because it asks the live metadata
 * first and falls back to the name heuristic; add-field now uses the same ladder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddField, mockBridgeRefreshProvider } = vi.hoisted(() => ({
  mockBridgeAddField: vi.fn(),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddField: mockBridgeAddField,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoWorkerBonusRate</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoWorkerBonusRate extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>@SYS32359</Label>
\t<ValidTimeStateFieldType>Date</ValidTimeStateFieldType>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>WorkerId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>`;

const { mockWriteFile } = vi.hoisted(() => ({ mockWriteFile: vi.fn(async () => {}) }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return TABLE_XML;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
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
    resolve: vi.fn(async (m: string) => ({ packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({ packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
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

const TABLE_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConDemoWorkerBonusRate.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

/** edt_metadata rows the way the real index stores them: a root EDT carries NO primitive. */
const EDT_ROWS: Record<string, { extends: string | null; enum_type: string | null; string_size: string | null }> = {
  FromDate: { extends: 'TransDate', enum_type: null, string_size: null },
  ToDate: { extends: 'TransDate', enum_type: null, string_size: null },
  TransDate: { extends: null, enum_type: null, string_size: null },
  Num: { extends: null, enum_type: null, string_size: '20' },
};

const buildContext = (bridgeReadEdt?: (name: string) => unknown): XppServerContext => {
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn(() => []),
    run: vi.fn(),
    get: vi.fn((name?: string) => (/edt_metadata/i.test(sql) && name ? EDT_ROWS[name] : undefined)),
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
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => {}), generateSearchKey: vi.fn((q: string) => `k:${q}`) } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: bridgeReadEdt
      ? ({ isReady: true, metadataAvailable: true, readEdt: vi.fn(async (n: string) => bridgeReadEdt(n)) } as any)
      : ({ isReady: false, metadataAvailable: false } as any),
  };
};

const addDateField = (fieldName: string, fieldType: string) =>
  req({ objectType: 'table', objectName: 'ConDemoWorkerBonusRate', operation: 'add-field', filePath: TABLE_FILE_PATH, fieldName, fieldType });

describe('add-field derives the base type from the EDT like create does', () => {
  beforeEach(() => {
    mockBridgeAddField.mockReset();
    mockBridgeAddField.mockResolvedValue({ success: true, message: '✅ Field added via IMetaTableProvider.Update' });
  });

  it('FromDate → TransDate (root without a primitive in the index) resolves to Date, not the root EDT name', async () => {
    await modifyD365FileTool(addDateField('ValidFrom', 'FromDate'), buildContext());
    expect(mockBridgeAddField).toHaveBeenCalledTimes(1);
    const [, tableName, fieldName, baseType, edt] = mockBridgeAddField.mock.calls[0];
    expect(tableName).toBe('ConDemoWorkerBonusRate');
    expect(fieldName).toBe('ValidFrom');
    expect(edt).toBe('FromDate');
    expect(baseType).toBe('Date');
  });

  it('prefers the live metadata primitive when the bridge can read the EDT', async () => {
    const ctx = buildContext((name) => (name === 'ToDate' ? { baseType: 'Date' } : undefined));
    await modifyD365FileTool(addDateField('ValidTo', 'ToDate'), ctx);
    const [, , , baseType] = mockBridgeAddField.mock.calls[0];
    expect(baseType).toBe('Date');
  });

  it('still resolves a string EDT (with a string_size) to String', async () => {
    await modifyD365FileTool(addDateField('WorkerRef', 'Num'), buildContext());
    const [, , , baseType] = mockBridgeAddField.mock.calls[0];
    expect(baseType).toBe('String');
  });

  it('an explicit fieldBaseType still wins', async () => {
    await modifyD365FileTool(
      req({ objectType: 'table', objectName: 'ConDemoWorkerBonusRate', operation: 'add-field', filePath: TABLE_FILE_PATH, fieldName: 'ValidFrom', fieldType: 'FromDate', fieldBaseType: 'UtcDateTime' }),
      buildContext(),
    );
    const [, , , baseType] = mockBridgeAddField.mock.calls[0];
    expect(baseType).toBe('UtcDateTime');
  });
});
