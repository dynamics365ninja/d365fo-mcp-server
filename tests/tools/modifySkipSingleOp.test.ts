/**
 * A bridge skip on a SINGLE operation (no operations[]), and the note that
 * replaced the bridge's table-match skip on add-data-source.
 *
 *  1. runModifyBatch already kept a skipped file out of its "Verified: on disk" and
 *     index trailers; the single-operation path still printed both — plus BP advice
 *     about a field that was never added — under a "⏭️ SKIPPED" header.
 *  2. A skipped add-field must not go on to set EnumType on the field that was
 *     already there, or roll that field back when the second call fails.
 *  3. add-data-source over a table another data source already binds is written
 *     (313 shipped forms bind one table in two or more unjoined roots), and the
 *     reply names the existing bindings instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { dataSourcesBindingTable } from '../../src/tools/write/formDataSourceNote';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const {
  mockBridgeAddDataSource, mockBridgeAddField, mockBridgeModifyField, mockBridgeRemoveField,
} = vi.hoisted(() => ({
  mockBridgeAddDataSource: vi.fn(),
  mockBridgeAddField: vi.fn(),
  mockBridgeModifyField: vi.fn(),
  mockBridgeRemoveField: vi.fn(),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddDataSource: mockBridgeAddDataSource,
    bridgeAddField: mockBridgeAddField,
    bridgeModifyField: mockBridgeModifyField,
    bridgeRemoveField: mockBridgeRemoveField,
    bridgeRefreshProvider: vi.fn(async () => {}),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const { currentXml } = vi.hoisted(() => ({ currentXml: { value: '' } }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return currentXml.value;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1234 })),
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
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
}));

const FORM_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\ConDemoForm.xml';
const TABLE_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConDemoTable.xml';

/** A form as it reads AFTER the bridge wrote `NewDS` over `DocuHistory`. */
const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoForm</Name>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>HeaderDS</Name>
\t\t\t<Table>DocuHistory</Table>
\t\t\t<Fields>
\t\t\t\t<AxFormDataSourceField><DataField>RecId</DataField></AxFormDataSourceField>
\t\t\t</Fields>
\t\t\t<ReferencedDataSources />
\t\t</AxFormDataSource>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>Lines</Name>
\t\t\t<Table>DocuHistoryLine</Table>
\t\t\t<JoinSource>HeaderDS</JoinSource>
\t\t</AxFormDataSource>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>NewDS</Name>
\t\t\t<Table>DocuHistory</Table>
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design />
</AxForm>`;

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTable</Name>
\t<Fields />
\t<FieldGroups />
</AxTable>`;

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

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

const SKIPPED = {
  success: true,
  skipped: true,
  message: "⏭️ NOT written — DataSource 'NewDS' was skipped by the bridge: data source 'NewDS' already exists",
};

const addDataSource = (dataSourceName: string, dataSourceTable: string) =>
  modifyD365FileTool(
    req({
      objectType: 'form',
      objectName: 'ConDemoForm',
      operation: 'add-data-source',
      dataSourceName,
      dataSourceTable,
      filePath: FORM_FILE_PATH,
    }),
    buildContext(),
  );

beforeEach(() => {
  vi.clearAllMocks();
  currentXml.value = FORM_XML;
  mockBridgeAddDataSource.mockResolvedValue({ success: true, message: "✅ DataSource 'NewDS' added via IMetaFormProvider.Update" });
  mockBridgeModifyField.mockResolvedValue({ success: false, message: 'enum not found' });
  mockBridgeRemoveField.mockResolvedValue({ success: true, message: 'removed' });
});

describe('a skipped single operation signs off on nothing', () => {
  it('says SKIPPED with the bridge reason, and signs off on nothing', async () => {
    const applied = textOf(await addDataSource('NewDS', 'DocuHistory'));
    // The control: without a skip, the headline is a ✅.
    expect(applied).toMatch(/^✅ add-data-source on form "ConDemoForm"/);

    mockBridgeAddDataSource.mockResolvedValue(SKIPPED);
    const skipped = textOf(await addDataSource('NewDS', 'DocuHistory'));

    expect(skipped).not.toMatch(/^✅/);
    expect(skipped).toContain('SKIPPED, nothing was written');
    expect(skipped).toContain('already exists');
    expect(skipped).not.toMatch(/Verified/);
    expect(skipped).not.toMatch(/Symbol index updated/);
    // Nor the "already bound" note: nothing was added to be a duplicate.
    expect(skipped).not.toContain('was already bound');
  });

  it('does not set EnumType on — or roll back — a field the bridge skipped', async () => {
    currentXml.value = TABLE_XML;
    mockBridgeAddField.mockResolvedValue({
      success: true,
      skipped: true,
      message: "⏭️ NOT written — Field 'Status' was skipped by the bridge: field 'Status' already exists",
    });

    const text = textOf(await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoTable',
        operation: 'add-field',
        fieldName: 'Status',
        fieldEnumType: 'NoSuchEnum',
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    ));

    expect(mockBridgeModifyField).not.toHaveBeenCalled();
    expect(mockBridgeRemoveField).not.toHaveBeenCalled();
    expect(text).toContain('SKIPPED');
    // BP advice about adding the new field to a group is advice about a field that was not added.
    expect(text).not.toContain('BPErrorTableFieldNotInFieldGroup');
  });
});

describe('add-data-source over an already-bound table', () => {
  it('writes it and names the existing binding', async () => {
    const text = textOf(await addDataSource('NewDS', 'DocuHistory'));

    expect(text).toContain("Table 'DocuHistory' was already bound on this form by 'HeaderDS' (root)");
    expect(text).toContain("so 'NewDS' was written");
    // The new data source is not reported as binding its own table.
    expect(text).not.toContain("'NewDS' (root)");
  });

  it('says nothing when the table is bound by no other data source', async () => {
    const text = textOf(await addDataSource('Lines2', 'CustTable'));
    expect(text).not.toContain('was already bound');
  });
});

describe('dataSourcesBindingTable', () => {
  it('reads each data source\'s own Name/Table/JoinSource, not a nested one', () => {
    const xml = `<DataSources>
      <AxFormDataSource xmlns="">
        <Name>Root</Name>
        <Table>PurchTable</Table>
        <ReferencedDataSources>
          <AxFormReferencedDataSource><Name>Ref</Name><JoinSource>Elsewhere</JoinSource></AxFormReferencedDataSource>
        </ReferencedDataSources>
      </AxFormDataSource>
      <AxFormDataSource xmlns="">
        <Name>PurchTable1</Name>
        <Table>purchtable</Table>
        <JoinSource>Root</JoinSource>
      </AxFormDataSource>
      <AxFormDataSource xmlns="">
        <Name>Other</Name>
        <Table>VendTable</Table>
      </AxFormDataSource>
    </DataSources>`;

    expect(dataSourcesBindingTable(xml, 'PurchTable')).toEqual([
      { name: 'Root', joinSource: '' },
      { name: 'PurchTable1', joinSource: 'Root' },
    ]);
    expect(dataSourcesBindingTable(xml, 'PurchTable', 'purchtable1')).toEqual([
      { name: 'Root', joinSource: '' },
    ]);
    expect(dataSourcesBindingTable(xml, 'CustTable')).toEqual([]);
  });
});
