/**
 * add-data-source on a form / form extension takes insertIfEmpty.
 *
 * The bridge's AddDataSource has no such property, so a new data source always came
 * out with the platform default (Yes) — while the VS designer writes
 * <InsertIfEmpty>No</InsertIfEmpty> for one, and 12,798 shipped form data sources
 * carry it, every one of them as No (Yes is the default and never serialized).
 *
 * Position, measured over the 21,168 shipped form data sources: only StartPosition,
 * MaxAccessRight, ValidTimeState*, OptionalRecordMode, DataSourceLinks and
 * DerivedDataSources ever follow it; nothing appears on both sides.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddDataSource } = vi.hoisted(() => ({ mockBridgeAddDataSource: vi.fn() }));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddDataSource: mockBridgeAddDataSource,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

/** What the bridge writes for an outer-joined data source (captured live). */
const AFTER_BRIDGE_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
  '\t<Name>CRJournalTable.ContosoRobotics</Name>',
  '\t<ControlModifications />',
  '\t<Controls />',
  '\t<DataSourceModifications />',
  '\t<DataSourceReferences />',
  '\t<DataSources>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>CRItemFieldsView</Name>',
  '\t\t\t<Table>CRItemFieldsView</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<JoinSource>CRJournalTable</JoinSource>',
  '\t\t\t<LinkType>OuterJoin</LinkType>',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t</DataSources>',
  '\t<Parts />',
  '\t<PropertyModifications />',
  '</AxFormExtension>',
].join('\r\n');

const { fixture, mockWriteFile } = vi.hoisted(() => ({
  fixture: { xml: '' },
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return fixture.xml;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 100 })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'ContosoRobotics'),
    getWriteAnchorModel: vi.fn(() => 'ContosoRobotics'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'ContosoRobotics'),
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

const FILE_PATH =
  'K:\\PackagesLocalDirectory\\ContosoRobotics\\ContosoRobotics\\AxFormExtension\\CRJournalTable.ContosoRobotics.xml';

const addDataSource = (params: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'form-extension', objectName: 'CRJournalTable.ContosoRobotics', operation: 'add-data-source',
      filePath: FILE_PATH, dataSourceName: 'CRItemFieldsView', dataSourceTable: 'CRItemFieldsView',
      joinSource: 'CRJournalTable', linkType: 'OuterJoin', ...params,
    },
  },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['ContosoRobotics']),
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

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

/** The extension XML this server wrote (writeFileAtomic writes a temp sibling). */
const writtenXml = (): string | undefined =>
  mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxFormExtension'),
  )?.[1] as string | undefined;

beforeEach(() => {
  fixture.xml = AFTER_BRIDGE_XML;
  mockWriteFile.mockClear();
  mockBridgeAddDataSource.mockReset();
  mockBridgeAddDataSource.mockResolvedValue({
    success: true, message: "DataSource 'CRItemFieldsView' added via IMetaFormExtensionProvider.Update",
  });
});

describe('add-data-source — insertIfEmpty', () => {
  it('false writes InsertIfEmpty=No right after LinkType, where the designer puts it', async () => {
    const r = await modifyD365FileTool(addDataSource({ insertIfEmpty: false }), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    const xml = writtenXml()!;
    expect(xml).toContain(
      '\t\t\t<LinkType>OuterJoin</LinkType>\r\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\r\n\t\t\t<DataSourceLinks />',
    );
    // Microsoft's serialization convention: CRLF, no BOM — no whole-file churn.
    expect(xml).not.toMatch(/[^\r]\n/);
    expect(xml.charCodeAt(0)).not.toBe(0xFEFF);
    expect(textOf(r)).toContain('InsertIfEmpty=No set');
  });

  it('true removes an InsertIfEmpty=No, so the file reads as a defaulted one', async () => {
    fixture.xml = AFTER_BRIDGE_XML.replace(
      '<LinkType>OuterJoin</LinkType>\r\n', '<LinkType>OuterJoin</LinkType>\r\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\r\n',
    );
    await modifyD365FileTool(addDataSource({ insertIfEmpty: true }), buildContext());
    expect(writtenXml()).not.toContain('InsertIfEmpty');
  });

  it('is idempotent: a second No is not written twice', async () => {
    fixture.xml = AFTER_BRIDGE_XML.replace(
      '<LinkType>OuterJoin</LinkType>\r\n', '<LinkType>OuterJoin</LinkType>\r\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\r\n',
    );
    await modifyD365FileTool(addDataSource({ insertIfEmpty: false }), buildContext());
    expect(writtenXml()).toBeUndefined();   // the file already says it — nothing to write
  });

  it('omitted leaves the file to the bridge alone', async () => {
    await modifyD365FileTool(addDataSource({}), buildContext());
    expect(writtenXml()).toBeUndefined();
  });

  it('a skipped add (data source already there) sets nothing', async () => {
    mockBridgeAddDataSource.mockResolvedValue({ success: true, skipped: true, message: 'already exists' });
    const r = await modifyD365FileTool(addDataSource({ insertIfEmpty: false }), buildContext());
    expect(textOf(r)).toContain('SKIPPED');
    expect(writtenXml()).toBeUndefined();
  });

  it('places it before DerivedDataSources when a data source carries no DataSourceLinks', async () => {
    // A form's own data source sits one level shallower than an extension's.
    fixture.xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
      '\t<Name>CRJournalTable</Name>',
      '\t<DataSources>',
      '\t\t<AxFormDataSource xmlns="">',
      '\t\t\t<Name>CRItemFieldsView</Name>',
      '\t\t\t<Table>CRItemFieldsView</Table>',
      '\t\t\t<Fields />',
      '\t\t\t<ReferencedDataSources />',
      '\t\t\t<AllowEdit>No</AllowEdit>',
      '\t\t\t<DerivedDataSources />',
      '\t\t</AxFormDataSource>',
      '\t</DataSources>',
      '</AxForm>',
    ].join('\r\n');
    const r = await modifyD365FileTool(
      addDataSource({ objectType: 'form', objectName: 'CRJournalTable', insertIfEmpty: false }), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    const xml = mockWriteFile.mock.calls.find((c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxForm '))?.[1] as string;
    expect(xml).toContain('<AllowEdit>No</AllowEdit>\r\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\r\n\t\t\t<DerivedDataSources />');
  });
});
