/**
 * Modify on a data-entity through the real dispatcher, with the bridge mocked to refuse as the
 * real one does: modify-property for ConfigurationKey / PrimaryCompanyContext, add-data-source
 * and add-field with a dataField + dataSource binding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockSetProperty, mockAddDataSource, mockAddField, mockRefresh } = vi.hoisted(() => ({
  mockSetProperty: vi.fn(),
  mockAddDataSource: vi.fn(),
  mockAddField: vi.fn(),
  mockRefresh: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeSetProperty: mockSetProperty,
    bridgeAddDataSource: mockAddDataSource,
    bridgeAddField: mockAddField,
    bridgeRefreshProvider: mockRefresh,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const { fixture, mockWriteFile } = vi.hoisted(() => ({
  fixture: { xml: '' },
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return fixture.xml;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return '<Project><ItemGroup></ItemGroup></Project>';
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

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxDataEntityView\\MyEntity.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});
const base = { objectType: 'data-entity', objectName: 'MyEntity', filePath: FILE_PATH };

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
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => {}), generateSearchKey: vi.fn(() => 'k') } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
/** The XML of the last writeFile that carried an entity. */
const written = (): string => {
  const calls = mockWriteFile.mock.calls.filter((c: any[]) => typeof c[1] === 'string' && c[1].includes('AxDataEntityView'));
  return (calls.at(-1)?.[1] as string | undefined) ?? '';
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.xml = buildAxDataEntityXml('MyEntity', {
    primaryTable: 'AssetTrans', dynamicFields: true, fields: [{ name: 'AssetId' }, { name: 'DefaultDimension' }],
  });
  // What the real bridge does for these three: refuse.
  mockSetProperty.mockResolvedValue({
    success: false,
    message: "Unknown AxDataEntityView property 'ConfigurationKey' — nothing was written.",
  });
  mockAddDataSource.mockResolvedValue({
    success: false,
    message: "add-data-source not supported for objectType 'data-entity' via bridge",
  });
  mockAddField.mockResolvedValue({ success: false, message: 'bridge cannot add a mapped field to an entity' });
});

describe('modify-property on a data-entity', () => {
  it('writes ConfigurationKey in canonical position', async () => {
    const r: any = await modifyD365FileTool(
      req({ ...base, operation: 'modify-property', propertyPath: 'ConfigurationKey', propertyValue: 'Asset' }),
      buildContext(),
    );
    expect(r.isError).not.toBe(true);
    const xml = written();
    expect(xml).toContain('<ConfigurationKey>Asset</ConfigurationKey>');
    expect(xml.indexOf('<ConfigurationKey>')).toBeLessThan(xml.indexOf('<Label>'));
  });
  it('writes PrimaryCompanyContext before PrimaryKey', async () => {
    const r: any = await modifyD365FileTool(
      req({ ...base, operation: 'modify-property', propertyPath: 'PrimaryCompanyContext', propertyValue: 'DataAreaId' }),
      buildContext(),
    );
    expect(r.isError).not.toBe(true);
    const xml = written();
    expect(xml.indexOf('<PrimaryCompanyContext>')).toBeGreaterThan(-1);
    expect(xml.indexOf('<PrimaryCompanyContext>')).toBeLessThan(xml.indexOf('<PrimaryKey>'));
  });
});

describe('add-data-source + add-field on a data-entity', () => {
  it('add-data-source writes the outer-joined datasource', async () => {
    const r: any = await modifyD365FileTool(
      req({
        ...base, operation: 'add-data-source', dataSourceName: 'DefaultDimensionDAVS',
        dataSourceTable: 'DimensionSetEntity', linkType: 'OuterJoin',
        joinField: 'DefaultDimension', relatedField: 'RecId', dataSourceReadOnly: true,
      }),
      buildContext(),
    );
    expect(r.isError, text(r)).not.toBe(true);
    const xml = written();
    expect(xml).toContain('<Name>DefaultDimensionDAVS</Name>');
    expect(xml).toContain('<JoinMode>OuterJoin</JoinMode>');
    expect(xml).toContain('<IsReadOnly>Yes</IsReadOnly>');
  });
  it('add-data-source without its relation is refused, nothing written', async () => {
    const r: any = await modifyD365FileTool(
      req({ ...base, operation: 'add-data-source', dataSourceName: 'X', dataSourceTable: 'T' }),
      buildContext(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/joinField/);
    expect(written()).toBe('');
  });
  it('add-field with dataField+dataSource maps a field onto an entity datasource', async () => {
    const r: any = await modifyD365FileTool(
      req({ ...base, operation: 'add-field', fieldName: 'AssetIdCopy', dataField: 'AssetId', dataSource: 'AssetTrans' }),
      buildContext(),
    );
    expect(r.isError, text(r)).not.toBe(true);
    expect(written()).toMatch(/<Name>AssetIdCopy<\/Name>\s*<DataField>AssetId<\/DataField>\s*<DataSource>AssetTrans<\/DataSource>/);
  });
  it('add-field on an entity without the binding says so instead of writing an AxTableField', async () => {
    const r: any = await modifyD365FileTool(
      req({ ...base, operation: 'add-field', fieldName: 'Foo', dataField: 'Foo' }),
      buildContext(),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/BOTH dataField and dataSource/);
  });
});
