/**
 * BP-clean create, end to end through d365fo_file(action="create"): the menu
 * item and table defaults land on disk whichever writer ran (bridge or
 * template), and the response says what was written. The defaults themselves
 * are covered in bpCleanCreateDefaults.test.ts.
 *
 * The harness (in-memory disk, config and package mocks) is the one
 * createTableParamSilentDrop.test.ts uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (files.has(p)) return files.get(p)!;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup /></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async (p: string, content: string) => { files.set(p, content); }),
  copyFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (p: string) => {
    if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/') return;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1024 })),
  readdir: vi.fn(async () => []),
  rename: vi.fn(async (from: string, to: string) => {
    const content = files.get(from);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    files.set(to, content);
    files.delete(from);
  }),
  rm: vi.fn(async (p: string) => { files.delete(p); }),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

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
    resolve: vi.fn(async (modelName: string) => ({
      packageName: modelName, modelName, rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  isAsGivenNamingMode: vi.fn(() => false),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  getExtensionNamingStyle: vi.fn(() => 'prefix'),
  getExtensionClassNamingStyle: vi.fn(() => 'prefix'),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

// The fixtures create into model "Contoso" while the mocked workspace targets "MyModel".
beforeEach(() => {
  process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'Contoso';
  files.clear();
  vi.clearAllMocks();
});
afterEach(() => { delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS; });

const MI_PATH = 'K:\\PackagesLocalDirectory\\Contoso\\Contoso\\AxMenuItemAction\\ContosoRentPost.xml';
const TABLE_PATH = 'K:\\PackagesLocalDirectory\\Contoso\\Contoso\\AxTable\\ContosoRentLine.xml';

const createArgs = (objectType: string, objectName: string, properties: Record<string, unknown>) => ({
  objectType, objectName, modelName: 'Contoso', packageName: 'Contoso',
  packagePath: 'K:\\PackagesLocalDirectory', addToProject: false, properties,
});

/** The symbol index: no stored EDT XML, and ItemId's legacy ReferenceTable in edt_metadata. */
const buildContext = (bridge?: unknown) => ({
  bridge,
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => ['Contoso']),
    db: {
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() => []),
        get: vi.fn((name?: string) =>
          sql.includes('edt_metadata') && name === 'ItemId' ? { reference_table: 'InventTable' } : undefined),
        run: vi.fn(),
      })),
    },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  },
} as any);

/** A menu item as IMetaMenuItemActionProvider.Create writes it: no OperationalDomain, no access level. */
const menuItemBridge = () => {
  const createObject = vi.fn(async (params: any) => {
    files.set(MI_PATH,
      '<?xml version="1.0" encoding="utf-8"?>\r\n' +
      '<AxMenuItemAction xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">\r\n' +
      `\t<Name>${params.objectName}</Name>\r\n\t<Label>@ContosoExt:Post</Label>\r\n` +
      '\t<Object>ContosoRentPostController</Object>\r\n\t<ObjectType>Class</ObjectType>\r\n</AxMenuItemAction>\r\n');
    return { success: true, filePath: MI_PATH, api: 'IMetaMenuItemActionProvider.Create', unsupportedProperties: [] };
  });
  return {
    createObject,
    bridge: {
      isReady: true,
      metadataAvailable: true,
      createObject,
      validateObject: vi.fn(async () => null),
      refreshProvider: vi.fn(async () => ({ success: true })),
    } as any,
  };
};

describe('menu item create: OperationalDomain and SubscriberAccessLevel', () => {
  it('bridge path: Action/Class gets Local and No Access on disk, and the response says why', async () => {
    const { bridge, createObject } = menuItemBridge();
    const result = await handleCreateD365File(req(createArgs('menu-item-action', 'ContosoRentPost', {
      label: '@ContosoExt:Post', object: 'ContosoRentPostController', objectType: 'Class',
    })), buildContext(bridge));
    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledOnce();
    const onDisk = files.get(MI_PATH)!.replace(/\r\n/g, '\n');
    expect(onDisk).toContain(
      '\t<ObjectType>Class</ObjectType>\n\t<OperationalDomain>Local</OperationalDomain>\n' +
      '\t<SubscriberAccessLevel>\n\t\t<Correct xmlns="">Deny</Correct>');
    expect(onDisk).toContain('\t\t<Update xmlns="">Deny</Update>\n\t</SubscriberAccessLevel>\n</AxMenuItemAction>');
    expect(result.content[0].text).toContain('because the menu item type is Action and ObjectType is Class');
  });

  it('bridge path: the caller\'s values are written after the create, not sent to a bridge that cannot set them', async () => {
    const { bridge, createObject } = menuItemBridge();
    await handleCreateD365File(req(createArgs('menu-item-action', 'ContosoRentPost', {
      label: '@ContosoExt:Post', object: 'ContosoRentPostController', operationalDomain: 'Company',
    })), buildContext(bridge));
    const sent = (createObject.mock.calls[0][0].properties ?? {}) as Record<string, string>;
    expect(Object.keys(sent).map(k => k.toLowerCase())).not.toContain('operationaldomain');
    expect(files.get(MI_PATH)).toContain('<OperationalDomain>Company</OperationalDomain>');
  });

  it('template path (no bridge): a Display item on a form gets Shared and Read', async () => {
    const result = await handleCreateD365File(req(createArgs('menu-item-display', 'ContosoRentTable', {
      label: '@ContosoExt:Rent', object: 'ContosoRentTable',
    })), buildContext(undefined));
    expect((result as any).isError).toBeFalsy();
    const written = [...files.entries()].find(([p]) => p.endsWith('ContosoRentTable.xml'))?.[1]?.replace(/\r\n/g, '\n') ?? '';
    expect(written).toContain(
      '\t<OperationalDomain>Shared</OperationalDomain>\n\t<SubscriberAccessLevel>\n\t\t<Read xmlns="">Allow</Read>\n\t</SubscriberAccessLevel>\n');
  });
});

describe('table create: structural BP defaults on a bridge-written table', () => {
  /** What CreateSmartTable writes: VS access level, a parent-pointing delete action, a bare relation. */
  const smartTable = (name: string) =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
    `\t<Name>${name}</Name>\n` +
    '\t<SourceCode>\n\t\t<Declaration><![CDATA[\npublic class X extends common\n{\n}\n]]></Declaration>\n\t\t<Methods />\n\t</SourceCode>\n' +
    '\t<Label>@ContosoExt:RentLine</Label>\n' +
    '\t<SubscriberAccessLevel>\n\t\t<Read>Allow</Read>\n\t</SubscriberAccessLevel>\n' +
    '\t<TableGroup>Transaction</TableGroup>\n\t<PrimaryIndex>RentIdx</PrimaryIndex>\n' +
    '\t<DeleteActions>\n\t\t<AxTableDeleteAction>\n\t\t\t<Name>ContosoRentTable</Name>\n\t\t\t<DeleteAction>Restricted</DeleteAction>\n' +
    '\t\t\t<Table>ContosoRentTable</Table>\n\t\t</AxTableDeleteAction>\n\t</DeleteActions>\n' +
    '\t<FieldGroups>\n\t\t<AxTableFieldGroup>\n\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields />\n\t\t</AxTableFieldGroup>\n\t</FieldGroups>\n' +
    '\t<Fields>\n' +
    '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldString">\n\t\t\t<Name>RentId</Name>\n' +
    '\t\t\t<ExtendedDataType>ContosoRentId</ExtendedDataType>\n\t\t</AxTableField>\n' +
    '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldString">\n\t\t\t<Name>ItemId</Name>\n' +
    '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n\t\t</AxTableField>\n' +
    '\t</Fields>\n\t<FullTextIndexes />\n' +
    '\t<Indexes>\n\t\t<AxTableIndex>\n\t\t\t<Name>RentIdx</Name>\n\t\t\t<Fields>\n\t\t\t\t<AxTableIndexField>\n' +
    '\t\t\t\t\t<DataField>RentId</DataField>\n\t\t\t\t</AxTableIndexField>\n\t\t\t</Fields>\n\t\t</AxTableIndex>\n\t</Indexes>\n' +
    '\t<Mappings />\n' +
    '\t<Relations>\n\t\t<AxTableRelation>\n\t\t\t<Name>ContosoRentTable</Name>\n\t\t\t<RelatedTable>ContosoRentTable</RelatedTable>\n' +
    '\t\t\t<Constraints>\n\t\t\t\t<AxTableRelationConstraint xmlns=""\n\t\t\t\t\ti:type="AxTableRelationConstraintField">\n' +
    '\t\t\t\t\t<Name>RentId</Name>\n\t\t\t\t\t<Field>RentId</Field>\n\t\t\t\t\t<RelatedField>RentId</RelatedField>\n' +
    '\t\t\t\t</AxTableRelationConstraint>\n\t\t\t</Constraints>\n\t\t</AxTableRelation>\n\t</Relations>\n' +
    '\t<StateMachines />\n</AxTable>\n';

  it('writes every default the checker asked for, and lists them', async () => {
    const createSmartTable = vi.fn(async (params: any) => {
      files.set(TABLE_PATH, smartTable(params.objectName));
      return { success: true, filePath: TABLE_PATH, api: 'IMetaTableProvider.Create (Smart)' };
    });
    const bridge = {
      isReady: true,
      metadataAvailable: true,
      createSmartTable,
      createObject: vi.fn(async () => { throw new Error('generic create must not be used'); }),
      validateObject: vi.fn(async () => null),
      refreshProvider: vi.fn(async () => ({ success: true })),
    } as any;
    const result = await handleCreateD365File(req(createArgs('table', 'ContosoRentLine', {
      label: '@ContosoExt:RentLine', tableGroup: 'Transaction',
    })), buildContext(bridge));
    expect((result as any).isError).toBeFalsy();
    expect(createSmartTable).toHaveBeenCalledOnce();
    const onDisk = files.get(TABLE_PATH)!.replace(/\r\n/g, '\n');

    expect(onDisk).toContain('\t<Label>@ContosoExt:RentLine</Label>\n\t<OperationalDomain>Company</OperationalDomain>\n');
    expect(onDisk).toContain(
      '\t\t\t<Name>RentId</Name>\n\t\t\t<AllowEdit>No</AllowEdit>\n' +
      '\t\t\t<ExtendedDataType>ContosoRentId</ExtendedDataType>\n\t\t\t<Mandatory>Yes</Mandatory>\n');
    expect(onDisk).toMatch(/<Name>AutoReport<\/Name>\n\t\t\t<Fields>\n[\s\S]*<DataField>RentId<\/DataField>[\s\S]*<DataField>ItemId<\/DataField>/);
    expect(onDisk).toContain('\t<DeleteActions />\n');
    expect(onDisk).toContain(
      '\t\t\t<Name>ContosoRentTable</Name>\n\t\t\t<Cardinality>ZeroMore</Cardinality>\n\t\t\t<OnDelete>Restricted</OnDelete>\n' +
      '\t\t\t<RelatedTable>ContosoRentTable</RelatedTable>\n\t\t\t<RelatedTableCardinality>ExactlyOne</RelatedTableCardinality>\n');
    expect(onDisk).toContain('\t\t\t<Name>InventTable</Name>');
    expect(onDisk).toContain('\t\t\t\t\t<Field>ItemId</Field>\n\t\t\t\t\t<RelatedField>ItemId</RelatedField>\n');

    const text = result.content[0].text;
    expect(text).toContain('📋 BP defaults written after the create:');
    expect(text).toContain('table relations for EDT relations: ItemId → InventTable.ItemId');
    expect(text).toContain('removed 1 delete action(s)');
  });
});
