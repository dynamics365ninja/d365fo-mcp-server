/**
 * add-field on a VIEW writes an AxViewFieldBound — a field of one of the view's data
 * sources, with no EDT of its own.
 *
 * Views used to fall through to the table path: dataField + dataSource (the natural
 * guess — it is the data-entity shape) were refused as "data-entity only", and
 * fieldType reached the bridge, whose AddField resolves tables and table extensions
 * only ("Table or table-extension 'X' not found", misread as a same-session problem).
 *
 * Shape from the 2,987 shipped views: 25,946 of 28,493 bound fields are exactly
 * Name, DataField, DataSource; an optional Label sits between Name and DataField.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddField } = vi.hoisted(() => ({ mockBridgeAddField: vi.fn() }));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddField: mockBridgeAddField,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

/** A view over embedded data sources, the shape of every shipped view with ViewMetadata. */
const EMBEDDED_VIEW_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CRItemFieldsView</Name>
\t<SourceCode>
\t\t<Methods xmlns="" />
\t</SourceCode>
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t</FieldGroups>
\t<Fields>
\t\t<AxViewField xmlns=""
\t\t\ti:type="AxViewFieldBound">
\t\t\t<Name>ItemId</Name>
\t\t\t<DataField>ItemId</DataField>
\t\t\t<DataSource>InventTable</DataSource>
\t\t</AxViewField>
\t</Fields>
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<SourceCode>
\t\t\t<Methods />
\t\t</SourceCode>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>InventTable</Name>
\t\t\t\t<Table>InventTable</Table>
\t\t\t\t<DataSources>
\t\t\t\t\t<AxQuerySimpleEmbeddedDataSource>
\t\t\t\t\t\t<Name>EcoResProductTranslation</Name>
\t\t\t\t\t\t<Table>EcoResProductTranslation</Table>
\t\t\t\t\t\t<DataSources />
\t\t\t\t\t</AxQuerySimpleEmbeddedDataSource>
\t\t\t\t</DataSources>
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxView>`;

/** What create writes for a view with no fields yet. */
const EMPTY_VIEW_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CRItemFieldsView</Name>
\t<Label>CRItemFieldsView</Label>
\t<Fields />
\t<Mappings />
\t<ViewMetadata />
</AxView>`;

/** A view built on an AxQuery: its data sources live in the query, not here. */
const QUERY_VIEW_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CRItemFieldsView</Name>
\t<Query>CRItemQuery</Query>
\t<Fields />
\t<Mappings />
\t<ViewMetadata />
</AxView>`;

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

const VIEW_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxView\\CRItemFieldsView.xml';

const addField = (params: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'view', objectName: 'CRItemFieldsView', operation: 'add-field',
      filePath: VIEW_FILE_PATH, fieldName: 'ProductName', ...params,
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
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

/** The view XML the write landed (writeFileAtomic writes a temp sibling, then renames). */
const writtenXml = (): string | undefined =>
  mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxView'),
  )?.[1] as string | undefined;

/** The <AxViewField> element named `name` in `xml`. */
const viewField = (xml: string, name: string): string | undefined =>
  new RegExp(`<AxViewField xmlns=""\\s+i:type="AxViewFieldBound">\\s*<Name>${name}</Name>[\\s\\S]*?</AxViewField>`)
    .exec(xml)?.[0];

beforeEach(() => {
  fixture.xml = EMBEDDED_VIEW_XML;
  mockWriteFile.mockClear();
  mockBridgeAddField.mockReset();
});

describe('add-field on a view', () => {
  it('writes an AxViewFieldBound into the view\'s own <Fields>, without the bridge', async () => {
    const r = await modifyD365FileTool(
      addField({ dataField: 'Name', dataSource: 'EcoResProductTranslation' }), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    expect(mockBridgeAddField).not.toHaveBeenCalled();
    const xml = writtenXml()!;
    const field = viewField(xml, 'ProductName')!;
    expect(field).toMatch(/<Name>ProductName<\/Name>\s*<DataField>Name<\/DataField>\s*<DataSource>EcoResProductTranslation<\/DataSource>/);
    // Appended after the existing field, in the top-level <Fields> — not in the
    // field group's nested one, which comes first in the file.
    expect(xml.indexOf('<Name>ItemId</Name>')).toBeLessThan(xml.indexOf('<Name>ProductName</Name>'));
    expect(xml).toMatch(/<AxTableFieldGroup>\s*<Name>AutoReport<\/Name>\s*<Fields \/>/);
    expect(textOf(r)).toContain("this server's XML writer");
  });

  it('puts a label between Name and the binding, as shipped views do', async () => {
    await modifyD365FileTool(
      addField({ dataField: 'Name', dataSource: 'EcoResProductTranslation', fieldLabel: '@SYS7399' }), buildContext());

    expect(viewField(writtenXml()!, 'ProductName'))
      .toMatch(/<Name>ProductName<\/Name>\s*<Label>@SYS7399<\/Label>\s*<DataField>Name<\/DataField>/);
  });

  it('defaults dataField to fieldName', async () => {
    await modifyD365FileTool(addField({ fieldName: 'Name', dataSource: 'EcoResProductTranslation' }), buildContext());
    expect(viewField(writtenXml()!, 'Name')).toContain('<DataField>Name</DataField>');
  });

  it('takes the data source\'s declared casing', async () => {
    await modifyD365FileTool(addField({ dataField: 'Name', dataSource: 'ecoresproducttranslation' }), buildContext());
    expect(viewField(writtenXml()!, 'ProductName')).toContain('<DataSource>EcoResProductTranslation</DataSource>');
  });

  it('refuses a data source the view does not declare, naming the ones it does', async () => {
    const r = await modifyD365FileTool(addField({ dataField: 'Name', dataSource: 'EcoResProduct' }), buildContext());

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('InventTable, EcoResProductTranslation');
    expect(writtenXml()).toBeUndefined();
  });

  it('refuses fieldType, with the view contract instead of the table one', async () => {
    const r = await modifyD365FileTool(addField({ fieldType: 'Name' }), buildContext());

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('add-field on a view needs dataSource');
    expect(textOf(r)).toContain('fieldType/fieldEnumType do not apply to a view field');
    expect(mockBridgeAddField).not.toHaveBeenCalled();
    expect(writtenXml()).toBeUndefined();
  });

  it('skips an identical field and refuses a same-named one bound elsewhere', async () => {
    const same = await modifyD365FileTool(
      addField({ fieldName: 'ItemId', dataField: 'ItemId', dataSource: 'InventTable' }), buildContext());
    expect(same.isError).toBeFalsy();
    expect(textOf(same)).toContain('SKIPPED');

    const clash = await modifyD365FileTool(
      addField({ fieldName: 'ItemId', dataField: 'Name', dataSource: 'EcoResProductTranslation' }), buildContext());
    expect(clash.isError).toBe(true);
    expect(textOf(clash)).toContain('different binding');
    expect(writtenXml()).toBeUndefined();
  });

  it('expands an empty <Fields />', async () => {
    fixture.xml = EMPTY_VIEW_XML;
    const r = await modifyD365FileTool(addField({ dataField: 'Name', dataSource: 'EcoResProductTranslation' }), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    expect(writtenXml()).toMatch(/<Fields>\s*<AxViewField xmlns=""\s+i:type="AxViewFieldBound">\s*<Name>ProductName<\/Name>/);
  });

  it('writes on a query-based view and says the data source was not checked', async () => {
    fixture.xml = QUERY_VIEW_XML;
    const r = await modifyD365FileTool(addField({ dataField: 'Name', dataSource: 'InventTable' }), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    expect(viewField(writtenXml()!, 'ProductName')).toContain('<DataSource>InventTable</DataSource>');
    expect(textOf(r)).toContain('was not checked here');
  });
});
