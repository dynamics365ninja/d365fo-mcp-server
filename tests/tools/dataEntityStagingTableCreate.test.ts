/**
 * A data entity created with data management enabled gets its staging table.
 *
 * d365fo_file(action="create", objectType="data-entity") with
 * dataManagementEnabled=true wrote <DataManagementStagingTable> and no table, so
 * the next build failed. The create now writes the table too, through the same
 * handler: one field per public entity field with the type of the table field it
 * maps to, and never a guessed type.
 *
 * The harness (in-memory disk, config and package mocks) is the one
 * createBpDefaultsEndToEnd.test.ts uses, with a symbol index that answers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
import { lookupCreatedArtifact } from '../../src/workspace/createdArtifactLedger';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Keys are Windows paths. Separators are folded so that a path the code joined
// with POSIX separators (Linux CI) finds the same entry.
const { files, key } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  key: (p: string) => p.replaceAll('/', '\\'),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (files.has(key(p))) return files.get(key(p))!;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async (p: string, content: string) => { files.set(key(p), content); }),
  copyFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (p: string) => {
    if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/' || files.has(key(p))) return;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1024 })),
  readdir: vi.fn(async () => []),
  rename: vi.fn(async (from: string, to: string) => {
    const content = files.get(key(from));
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    files.set(key(to), content);
    files.delete(key(from));
  }),
  rm: vi.fn(async (p: string) => { files.delete(key(p)); }),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

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
    // The solution root project registration is bound to (pathContainment.getProjectRoots).
    getContext: vi.fn(() => ({ solutionPath: 'K:\\VSProjects\\ContosoExt' })),
    getConfiguredProjectPath: vi.fn(() => null),
    getServerDetectedProject: vi.fn(() => null),
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

const ROOT = 'K:\\PackagesLocalDirectory';
const ENTITY = 'ContosoCustomerGroupEntity';
const STAGING = `${ENTITY}Staging`;
const ENTITY_PATH = `${ROOT}\\ContosoExt\\ContosoExt\\AxDataEntityView\\${ENTITY}.xml`;
const STAGING_PATH = `${ROOT}\\ContosoExt\\ContosoExt\\AxTable\\${STAGING}.xml`;
/**
 * The index row holds the path relative to the packages root, a shape the lookup
 * joins onto the root on any platform. An absolute `K:\…` path is not absolute
 * on Linux, so such a row missed there.
 */
const CUSTGROUP_REL = 'ApplicationSuite\\Foundation\\AxTable\\CustGroup.xml';
const CUSTGROUP_PATH = `${ROOT}\\${CUSTGROUP_REL}`;

const tableField = (type: string, name: string, body: string) =>
  `\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableField${type}">\n\t\t\t<Name>${name}</Name>\n${body}\t\t</AxTableField>\n`;

/** The standard CustGroup table, cut down to the fields the entity maps. */
const CUSTGROUP_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
  '\t<Name>CustGroup</Name>\n\t<Fields>\n' +
  tableField('String', 'CustGroup', '\t\t\t<ExtendedDataType>CustGroupId</ExtendedDataType>\n') +
  tableField('String', 'Name', '\t\t\t<ExtendedDataType>Description</ExtendedDataType>\n') +
  tableField('Enum', 'PriceIncludeSalesTax', '\t\t\t<Label>@RET5093</Label>\n\t\t\t<EnumType>NoYes</EnumType>\n') +
  tableField('String', 'PaymTermId', '\t\t\t<ExtendedDataType>PaymTermId</ExtendedDataType>\n') +
  '\t</Fields>\n</AxTable>\n';

interface Symbol { name: string; type: string; model: string; file_path: string }

/** What the "index" holds. Each test fills it. */
const index = {
  symbols: [] as Symbol[],
  /** `Table.Field` → signature (the EDT, the enum, or the bare base type). */
  fields: new Map<string, string>(),
  /** EDT → its edt_metadata row. */
  edts: new Map<string, { extends?: string; enum_type?: string; string_size?: string; reference_table?: string }>(),
};

const db = {
  prepare: (sql: string) => ({
    run: () => undefined,
    all: (...params: unknown[]) => {
      if (sql.includes('symbols_fts')) return [];
      if (sql.includes('SELECT file_path, model FROM symbols')) {
        return index.symbols.filter(s => s.type === params[0] && s.name === params[1]);
      }
      if (sql.includes('FROM symbols s')) {
        const types = params.slice(1, -1) as string[];
        return index.symbols
          .filter(s => s.name === params[0] && (types.length === 0 || types.includes(s.type)))
          .map(s => ({ ...s, extends_class: null }));
      }
      return [];
    },
    get: (...params: unknown[]) => {
      if (sql.includes(`type = 'field'`)) {
        const signature = index.fields.get(`${params[0]}.${params[1]}`);
        return signature ? { signature } : undefined;
      }
      if (sql.includes('edt_metadata')) {
        const row = index.edts.get(String(params[0]));
        if (!row) return undefined;
        if (sql.includes('reference_table')) return row.reference_table ? { reference_table: row.reference_table } : undefined;
        return { extends: row.extends ?? null, enum_type: row.enum_type ?? null, string_size: row.string_size ?? null };
      }
      return undefined;
    },
  }),
};

const context = () => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => ['ContosoExt']),
    db,
    getReadDb: vi.fn(() => db),
  },
} as any);

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

const entityArgs = (properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  objectType: 'data-entity', objectName: ENTITY, modelName: 'ContosoExt', packageName: 'ContosoExt',
  packagePath: ROOT, addToProject: false,
  properties: {
    label: '@SYS16445', configurationKey: 'LedgerBasic', primaryTable: 'CustGroup', primaryKey: 'CustomerGroupKey',
    fields: [
      { name: 'CustomerGroupId', dataField: 'CustGroup' },
      { name: 'Description', dataField: 'Name' },
      { name: 'IsSalesTaxIncludedInPrice', dataField: 'PriceIncludeSalesTax' },
      { name: 'PaymentTermId', dataField: 'PaymTermId' },
    ],
    dataManagementEnabled: true,
    ...properties,
  },
  ...extra,
});

const text = (r: { content: Array<{ text: string }> }) => r.content.map(c => c.text).join('\n');
const stagingXml = () => (files.get(STAGING_PATH) ?? '').replace(/\r\n/g, '\n');
const stagingFields = () =>
  [...stagingXml().matchAll(/i:type="(AxTableField\w+)">\n\t\t\t<Name>(\w+)<\/Name>/g)].map(m => `${m[2]}:${m[1]}`);

/** The index knows CustGroup and where its file is, and the file is on disk. */
function custGroupOnDisk() {
  index.symbols.push({ name: 'CustGroup', type: 'table', model: 'Foundation', file_path: CUSTGROUP_REL });
  files.set(CUSTGROUP_PATH, CUSTGROUP_XML);
}

beforeEach(() => {
  files.clear();
  index.symbols = [];
  index.fields.clear();
  index.edts.clear();
  vi.clearAllMocks();
});

describe('data entity create with dataManagementEnabled', () => {
  it('creates the staging table with the types of the mapped table fields', async () => {
    custGroupOnDisk();
    index.edts.set('CustGroupId', { string_size: '10', reference_table: 'CustGroup' });

    const result = await handleCreateD365File(req(entityArgs()), context());

    expect(result.isError).toBeFalsy();
    expect(files.get(ENTITY_PATH)).toContain(`<DataManagementStagingTable>${STAGING}</DataManagementStagingTable>`);
    const xml = stagingXml();
    expect(xml).toContain(`<Name>${STAGING}</Name>`);
    expect(xml).toContain('<TableGroup>Staging</TableGroup>');
    expect(xml).not.toContain('<TableType>');
    expect(xml).toContain('<Label>@SYS16445</Label>');
    expect(xml).toContain('<ConfigurationKey>LedgerBasic</ConfigurationKey>');
    expect(stagingFields()).toEqual([
      'DefinitionGroup:AxTableFieldString', 'ExecutionId:AxTableFieldString',
      'IsSelected:AxTableFieldEnum', 'TransferStatus:AxTableFieldEnum',
      'CustomerGroupId:AxTableFieldString', 'Description:AxTableFieldString',
      'IsSalesTaxIncludedInPrice:AxTableFieldEnum', 'PaymentTermId:AxTableFieldString',
    ]);
    expect(xml).toMatch(/<Name>CustomerGroupId<\/Name>\n\t\t\t<AllowEdit>No<\/AllowEdit>\n\t\t\t<ExtendedDataType>CustGroupId<\/ExtendedDataType>/);
    expect(xml).toMatch(/<Name>Description<\/Name>\n\t\t\t<ExtendedDataType>Description<\/ExtendedDataType>/);
    expect(xml).toMatch(/<Name>IsSalesTaxIncludedInPrice<\/Name>\n\t\t\t<IsSystemGenerated>Yes<\/IsSystemGenerated>\n\t\t\t<Label>@RET5093<\/Label>\n\t\t\t<EnumType>NoYes<\/EnumType>/);
    expect(xml).toMatch(/<Name>PaymentTermId<\/Name>\n\t\t\t<ExtendedDataType>PaymTermId<\/ExtendedDataType>/);
    // Index and relation on the entity key the create wrote.
    expect(xml).toMatch(/<Name>StagingIdx<\/Name>[\s\S]*?<DataField>DefinitionGroup<\/DataField>[\s\S]*?<DataField>ExecutionId<\/DataField>[\s\S]*?<DataField>CustomerGroupId<\/DataField>/);
    expect(xml).toMatch(new RegExp(`<Name>DataEntity</Name>[\\s\\S]*?<RelatedTable>${ENTITY}</RelatedTable>[\\s\\S]*?<Field>CustomerGroupId</Field>`));
    // Written by the table path, so it carries that path's access defaults for a staging table.
    expect([...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1])).toEqual([
      'Name', 'SourceCode', 'ConfigurationKey', 'DeveloperDocumentation', 'Label', 'OperationalDomain',
      'SubscriberAccessLevel', 'TableGroup', 'TitleField1', 'TitleField2', 'PrimaryIndex', 'ReplacementKey',
      'SaveDataPerCompany', 'DeleteActions', 'FieldGroups', 'Fields', 'FullTextIndexes', 'Indexes', 'Mappings',
      'Relations', 'StateMachines',
    ]);
    expect(xml).toContain('<OperationalDomain>Local</OperationalDomain>');
    // The table path's own defaults did not add a relation for the CustGroupId EDT, nor an OnDelete.
    expect([...xml.matchAll(/<AxTableRelation /g)]).toHaveLength(1);
    expect(xml).not.toContain('<OnDelete>');
    // The staging table is tracked for undo like the entity.
    expect(lookupCreatedArtifact(STAGING_PATH)).toMatchObject({ objectType: 'table', objectName: STAGING });
    expect(lookupCreatedArtifact(ENTITY_PATH)).toMatchObject({ objectType: 'data-entity' });
  });

  it('says what was created instead of the old warning', async () => {
    custGroupOnDisk();
    const reply = text(await handleCreateD365File(req(entityArgs()), context()));
    expect(reply).toContain(`✅ Created data-entity ${ENTITY}`);
    expect(reply).toContain(
      `✅ Staging table ${STAGING} created: 8 fields (the 4 DMF fields and 4 of 4 public entity fields), ` +
      `index StagingIdx on DefinitionGroup, ExecutionId, CustomerGroupId, relation DataEntity to ${ENTITY}.`);
    expect(reply).toContain(`📁 ${STAGING_PATH}`);
    expect(reply).not.toMatch(/does NOT create/);
    expect(reply).not.toContain('left out');
  });

  it('adds the staging table to the same project as the entity', async () => {
    custGroupOnDisk();
    const projectPath = 'K:\\VSProjects\\ContosoExt\\ContosoExt.rnrproj';
    files.set(projectPath, '<Project>\n  <PropertyGroup>\n    <Model>ContosoExt</Model>\n  </PropertyGroup>\n  <ItemGroup />\n</Project>\n');
    const reply = text(await handleCreateD365File(req(entityArgs({}, { addToProject: true, projectPath })), context()));
    expect(reply).toContain('relation DataEntity to ContosoCustomerGroupEntity, added to the project.');
    const project = files.get(projectPath)!;
    expect(project).toContain(`AxDataEntityView\\${ENTITY}`);
    expect(project).toContain(`AxTable\\${STAGING}`);
  });

  it('resolves types from the index when the table file cannot be read, and never guesses', async () => {
    index.symbols.push(
      { name: 'CustGroup', type: 'table', model: 'Foundation', file_path: CUSTGROUP_REL }, // not on disk
      { name: 'CustGroupId', type: 'edt', model: 'Foundation', file_path: '' },
      { name: 'PaymTermId', type: 'edt', model: 'Foundation', file_path: '' },
      { name: 'NoYes', type: 'enum', model: 'Foundation', file_path: '' },
    );
    index.fields.set('CustGroup.CustGroup', 'CustGroupId');
    index.fields.set('CustGroup.Name', 'String');              // no EDT in the index: the size is unknown
    index.fields.set('CustGroup.PriceIncludeSalesTax', 'NoYes');
    index.fields.set('CustGroup.PaymTermId', 'PaymTermId');
    index.edts.set('CustGroupId', { string_size: '10' });
    index.edts.set('PaymTermId', {});                          // a root EDT whose base type the index does not hold

    const reply = text(await handleCreateD365File(req(entityArgs()), context()));

    expect(stagingFields().slice(4)).toEqual([
      'CustomerGroupId:AxTableFieldString', 'IsSalesTaxIncludedInPrice:AxTableFieldEnum',
    ]);
    expect(stagingXml()).toMatch(/<Name>IsSalesTaxIncludedInPrice<\/Name>\n\t\t\t<IsSystemGenerated>Yes<\/IsSystemGenerated>\n\t\t\t<EnumType>NoYes<\/EnumType>/);
    expect(reply).toContain('6 fields (the 4 DMF fields and 2 of 4 public entity fields)');
    expect(reply).toContain('2 entity fields were left out');
    expect(reply).toContain('Description (CustGroup.Name is a string without an EDT, so its size is unknown)');
    expect(reply).toContain('PaymentTermId (CustGroup.PaymTermId: the base type of EDT PaymTermId is not in the symbol index)');
  });

  it('leaves an unresolved key field out of the index and the relation, and says so', async () => {
    const reply = text(await handleCreateD365File(req(entityArgs()), context()));
    const xml = stagingXml();
    expect(stagingFields()).toHaveLength(4);
    expect(xml).not.toContain('<DataField>CustomerGroupId</DataField>');
    expect(xml).toContain('<Constraints />');
    expect(reply).toContain('4 fields (the 4 DMF fields and 0 of 4 public entity fields), index StagingIdx on DefinitionGroup, ExecutionId, relation');
    expect(reply).toContain('CustomerGroupId is an entity key field');
    expect(reply).toContain('also add it to the index StagingIdx and to the DataEntity relation');
  });

  it('does not overwrite a staging table that is already on disk', async () => {
    custGroupOnDisk();
    files.set(STAGING_PATH, '<AxTable><Name>mine</Name></AxTable>');
    const result = await handleCreateD365File(req(entityArgs()), context());
    expect(result.isError).toBeFalsy();
    expect(files.get(ENTITY_PATH)).toContain('<DataManagementEnabled>Yes</DataManagementEnabled>');
    expect(files.get(STAGING_PATH)).toBe('<AxTable><Name>mine</Name></AxTable>');
    expect(text(result)).toContain(`Staging table ${STAGING} already exists on disk (${STAGING_PATH}) and was left as is`);
    expect(text(result)).not.toContain(`✅ Staging table`);
  });

  it('does not create a staging table the index already has, under the name the caller gave', async () => {
    custGroupOnDisk();
    index.symbols.push({ name: 'ContosoGroupStaging', type: 'table', model: 'ContosoCore', file_path: '' });
    const result = await handleCreateD365File(
      req(entityArgs({ dataManagementStagingTable: 'ContosoGroupStaging' })), context());
    expect(files.get(ENTITY_PATH)).toContain('<DataManagementStagingTable>ContosoGroupStaging</DataManagementStagingTable>');
    expect([...files.keys()].filter(p => p.includes('\\AxTable\\') && p.includes('ContosoExt'))).toEqual([]);
    expect(text(result)).toContain('Staging table ContosoGroupStaging already exists (model ContosoCore) and was left as is');
  });

  it('creates nothing when data management is off', async () => {
    custGroupOnDisk();
    const result = await handleCreateD365File(req(entityArgs({ dataManagementEnabled: false })), context());
    expect(files.has(ENTITY_PATH)).toBe(true);
    expect(files.has(STAGING_PATH)).toBe(false);
    expect(text(result)).not.toMatch(/staging/i);
  });

  it('autoCorrect=false keeps the create to the entity and keeps the warning', async () => {
    custGroupOnDisk();
    const result = await handleCreateD365File(req(entityArgs({}, { autoCorrect: false })), context());
    expect(files.has(ENTITY_PATH)).toBe(true);
    expect(files.has(STAGING_PATH)).toBe(false);
    expect(text(result)).toMatch(/does NOT create that table/);
    expect(text(result)).toContain('It was not created for you: autoCorrect=false keeps this create to the entity.');
  });
});
