/**
 * modify-property with dataSourceName sets JoinSource / LinkType / InsertIfEmpty on
 * a data source that already exists on a form (#1161).
 *
 * add-data-source was the only operation that took joinSource and linkType, so the
 * join of an existing data source could not be changed through the tool. The write
 * goes to the XML and never to the bridge, which has no such operation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeSetProperty } = vi.hoisted(() => ({ mockBridgeSetProperty: vi.fn() }));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeSetProperty: mockBridgeSetProperty,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const FORM_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
  '\t<Name>ContosoRentForm</Name>',
  '\t<DataSources>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentHeader</Name>',
  '\t\t\t<Table>ContosoRentHeader</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<InsertIfEmpty>No</InsertIfEmpty>',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentLine</Name>',
  '\t\t\t<Table>ContosoRentLine</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t</DataSources>',
  '\t<Design />',
  '</AxForm>',
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
    getModelName: vi.fn(() => 'ContosoExt'),
    getWriteAnchorModel: vi.fn(() => 'ContosoExt'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'ContosoExt'),
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

const FILE_PATH = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxForm\\ContosoRentForm.xml';

const modifyProperty = (params: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'form', objectName: 'ContosoRentForm', operation: 'modify-property',
      filePath: FILE_PATH, dataSourceName: 'ContosoRentLine', ...params,
    },
  },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['ContosoExt']),
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

/** The form XML this server wrote (writeFileAtomic writes a temp sibling). */
const writtenXml = (): string | undefined =>
  mockWriteFile.mock.calls.find((c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxForm '))?.[1] as
    string | undefined;

beforeEach(() => {
  fixture.xml = FORM_XML;
  mockWriteFile.mockClear();
  mockBridgeSetProperty.mockReset();
});

describe('modify-property — dataSourceName on a form', () => {
  it('joins an existing data source: JoinSource lands after ReferencedDataSources, in CRLF', async () => {
    const r = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'JoinSource', propertyValue: 'ContosoRentHeader' }), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    const xml = writtenXml()!;
    expect(xml).toBe(FORM_XML.replace(
      '<Table>ContosoRentLine</Table>\r\n\t\t\t<Fields />\r\n\t\t\t<ReferencedDataSources />\r\n',
      '<Table>ContosoRentLine</Table>\r\n\t\t\t<Fields />\r\n\t\t\t<ReferencedDataSources />\r\n' +
        '\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\r\n'));
    expect(textOf(r)).toContain("set ContosoRentLine.JoinSource='ContosoRentHeader'");
    // The bridge has no such operation and must not be asked: it would set a form property.
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();
    expect(textOf(r)).not.toContain('IGNORED');
  });

  it('sets LinkType after an existing JoinSource', async () => {
    fixture.xml = FORM_XML.replace(
      '<Table>ContosoRentLine</Table>\r\n\t\t\t<Fields />\r\n\t\t\t<ReferencedDataSources />\r\n',
      '<Table>ContosoRentLine</Table>\r\n\t\t\t<Fields />\r\n\t\t\t<ReferencedDataSources />\r\n' +
        '\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\r\n');
    const r = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'LinkType', propertyValue: 'Delayed' }), buildContext());
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(writtenXml()).toContain(
      '\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\r\n\t\t\t<LinkType>Delayed</LinkType>\r\n\t\t\t<DataSourceLinks />');
  });

  it('refuses a JoinSource that is not on the form and writes nothing', async () => {
    const r = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'JoinSource', propertyValue: 'ContosoRentTable' }), buildContext());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("'ContosoRentTable' is not a data source of this form");
    expect(writtenXml()).toBeUndefined();
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();
  });

  it('refuses a bad LinkType and an unsupported property, naming what is valid', async () => {
    const link = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'LinkType', propertyValue: 'LeftJoin' }), buildContext());
    expect(link.isError).toBe(true);
    expect(textOf(link)).toContain('Valid values: InnerJoin, OuterJoin');

    const prop = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'CounterField', propertyValue: 'LineNum' }), buildContext());
    expect(prop.isError).toBe(true);
    expect(textOf(prop)).toContain('Supported: AutoNotify, AutoQuery, AutoSearch');
    expect(writtenXml()).toBeUndefined();
  });

  it('sets AllowEdit=No and AllowCreate=No in the platform order, whatever order they are asked in', async () => {
    const first = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'AllowEdit', propertyValue: 'false' }), buildContext());
    expect(first.isError, textOf(first)).toBeFalsy();
    fixture.xml = writtenXml()!;
    mockWriteFile.mockClear();
    const second = await modifyD365FileTool(
      modifyProperty({ propertyPath: 'AllowCreate', propertyValue: 'No' }), buildContext());
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(writtenXml()).toContain(
      '\t\t\t<ReferencedDataSources />\r\n\t\t\t<AllowCreate>No</AllowCreate>\r\n\t\t\t<AllowEdit>No</AllowEdit>\r\n\t\t\t<DataSourceLinks />');
  });

  it('refuses an unknown data source', async () => {
    const r = await modifyD365FileTool(
      modifyProperty({ dataSourceName: 'ContosoRentLines', propertyPath: 'LinkType', propertyValue: 'Active' }),
      buildContext());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Data sources in this file: ContosoRentHeader, ContosoRentLine');
  });

  it('is refused on an object that has no form data sources', async () => {
    const r = await modifyD365FileTool(
      modifyProperty({
        objectType: 'table', objectName: 'ContosoRentLine', propertyPath: 'LinkType', propertyValue: 'Active',
        filePath: 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxTable\\ContosoRentLine.xml',
      }),
      buildContext());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('applies to objectType="form" and "form-extension" only');
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();
  });
});
