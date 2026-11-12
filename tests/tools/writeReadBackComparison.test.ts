/**
 * Read-back comparison through the tools (#1161, item 10).
 *
 * The shape of the defect: d365fo_file answers "✅ applied" and the saved XML does
 * not hold what was asked for. Nothing fails at that point. It surfaces much later
 * as a build or data-management error that names something else.
 *
 * Data entities and their extensions are the motivating types: the bridge's own
 * post-write validation cannot read them at all, so until this check they had no
 * read-back of any kind. The bridge is mocked here to do exactly what the defect
 * does: report success and leave the file as it was.
 *
 * The contract asserted, both ways: a miss is named in ONE warning block and the
 * write is still a success (`isError` unchanged), and a write that did land earns
 * no warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── In-memory filesystem ────────────────────────────────────────────────────
// The comparison re-reads what the writer produced, so the mock has to behave
// like a disk: a write (and the rename writeFileAtomic ends with) must be what
// the next read returns.

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (files.has(p)) return files.get(p)!;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup /></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async (p: string, content: string) => { files.set(p, String(content)); }),
  copyFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (p: string) => {
    if (files.has(p) || /^[A-Za-z]:[\\/]?$/.test(p) || p === '/') return;
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
  unlink: vi.fn(async (p: string) => { files.delete(p); }),
}));

// ─── Bridge mock ─────────────────────────────────────────────────────────────

const {
  mockAddField, mockRemoveField, mockAddMethod, mockAddIndex, mockSetProperty, mockRefresh,
} = vi.hoisted(() => ({
  mockAddField: vi.fn(),
  mockRemoveField: vi.fn(),
  mockAddMethod: vi.fn(),
  mockAddIndex: vi.fn(),
  mockSetProperty: vi.fn(),
  mockRefresh: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddField: mockAddField,
    bridgeRemoveField: mockRemoveField,
    bridgeAddMethod: mockAddMethod,
    bridgeAddIndex: mockAddIndex,
    bridgeSetProperty: mockSetProperty,
    bridgeRefreshProvider: mockRefresh,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
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
  isAsGivenNamingMode: vi.fn(() => false),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  getExtensionNamingStyle: vi.fn(() => 'prefix'),
  getExtensionClassNamingStyle: vi.fn(() => 'prefix'),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ROOT = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt';
const ENTITY_PATH = `${ROOT}\\AxDataEntityView\\ContosoRentEquipmentEntity.xml`;
const ENTITY_EXT_PATH = `${ROOT}\\AxDataEntityViewExtension\\CustCustomerV3Entity.ContosoExtension.xml`;
const TABLE_PATH = `${ROOT}\\AxTable\\ContosoRentEquipmentTable.xml`;

const ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoRentEquipmentEntity</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ContosoRentEquipmentEntity extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>@ContosoExt:RentEquipment</Label>
\t<EntityCategory>Master</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PrimaryKey>EntityKey</PrimaryKey>
\t<PublicCollectionName>ContosoRentEquipments</PublicCollectionName>
\t<PublicEntityName>ContosoRentEquipment</PublicEntityName>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>EquipmentId</Name>
\t\t\t<Label>@ContosoExt:EquipmentId</Label>
\t\t\t<DataField>EquipmentId</DataField>
\t\t\t<DataSource>ContosoRentEquipmentTable</DataSource>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<StateMachines />
\t<ViewMetadata />
</AxDataEntityView>`;

const ENTITY_EXT_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityViewExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustCustomerV3Entity.ContosoExtension</Name>
\t<DataSources />
\t<FieldGroupExtensions />
\t<FieldGroups />
\t<FieldModifications />
\t<Fields />
\t<Mappings />
\t<PropertyModifications />
\t<Relations />
</AxDataEntityViewExtension>`;

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoRentEquipmentTable</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ContosoRentEquipmentTable extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>EquipmentId</Name>
\t\t\t<ExtendedDataType>Name</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>`;

/** The mapped field a real add-field leaves in a data entity extension. */
const MAPPED_FIELD = (name: string) =>
  `\t<Fields>\n\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewMappedField">\n` +
  `\t\t\t<Name>${name}</Name>\n\t\t\t<DataField>${name}</DataField>\n\t\t\t<DataSource>CustTable</DataSource>\n` +
  `\t\t</AxDataEntityViewField>\n\t</Fields>`;

const METHOD = (name: string) =>
  `\t\t<Methods>\n\t\t\t<Method>\n\t\t\t\t<Name>${name}</Name>\n\t\t\t\t<Source><![CDATA[\n` +
  `    public boolean ${name}()\n    {\n        return true;\n    }\n]]></Source>\n\t\t\t</Method>\n\t\t</Methods>`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const modifyReq = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});
const createReq = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

const buildContext = (withBridge = true): XppServerContext => {
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
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((q: string) => `k:${q}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: withBridge ? ({ isReady: true, metadataAvailable: true } as any) : undefined,
  } as XppServerContext;
};

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');
const READ_BACK = '⚠️ Read-back:';
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const OK = (message: string) => ({ success: true, message });

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  files.set(ENTITY_PATH, ENTITY_XML);
  files.set(ENTITY_EXT_PATH, ENTITY_EXT_XML);
  files.set(TABLE_PATH, TABLE_XML);
  process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'ContosoExt';
});
afterEach(() => { delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS; });

// ─── modify: a child the reply says was added ────────────────────────────────

describe('modify: an added child that is not in the saved file', () => {
  const addExtensionField = () => modifyD365FileTool(
    modifyReq({
      objectType: 'data-entity-extension',
      objectName: 'CustCustomerV3Entity.ContosoExtension',
      operation: 'add-field',
      fieldName: 'ContosoLoyaltyTier',
      dataField: 'ContosoLoyaltyTier',
      dataSource: 'CustTable',
      filePath: ENTITY_EXT_PATH,
    }),
    buildContext(),
  );

  it('warns when add-field on a data entity extension reports success and writes nothing', async () => {
    mockAddField.mockResolvedValue(OK("✅ Field 'ContosoLoyaltyTier' added"));

    const result = await addExtensionField();
    const text = textOf(result);

    // Still a success: the warning does not change the outcome or roll anything back.
    expect((result as any).isError).toBeFalsy();
    expect(text).toContain('✅ add-field');
    expect(occurrences(text, READ_BACK)).toBe(1);
    expect(text).toContain('field "ContosoLoyaltyTier"');
    expect(text).toContain('NOT in the file');
    expect(files.get(ENTITY_EXT_PATH)).toBe(ENTITY_EXT_XML);
  });

  it('stays silent when the field is in the file', async () => {
    mockAddField.mockImplementation(async () => {
      files.set(ENTITY_EXT_PATH, ENTITY_EXT_XML.replace('\t<Fields />', MAPPED_FIELD('ContosoLoyaltyTier')));
      return OK("✅ Field 'ContosoLoyaltyTier' added");
    });

    const result = await addExtensionField();

    expect((result as any).isError).toBeFalsy();
    expect(textOf(result)).not.toContain(READ_BACK);
    expect(textOf(result)).not.toContain('NOT in the file');
  });

  it('warns when add-method on a data entity reports success and the method is not there', async () => {
    mockAddMethod.mockResolvedValue(OK("✅ Method 'validateWrite' added"));
    const call = () => modifyD365FileTool(
      modifyReq({
        objectType: 'data-entity',
        objectName: 'ContosoRentEquipmentEntity',
        operation: 'add-method',
        sourceCode: 'public boolean validateWrite()\n{\n    return true;\n}',
        filePath: ENTITY_PATH,
      }),
      buildContext(),
    );

    const missed = await call();
    expect((missed as any).isError).toBeFalsy();
    expect(textOf(missed)).toContain(READ_BACK);
    expect(textOf(missed)).toContain('method "validateWrite"');

    mockAddMethod.mockImplementation(async () => {
      files.set(ENTITY_PATH, ENTITY_XML.replace('\t\t<Methods />', METHOD('validateWrite')));
      return OK("✅ Method 'validateWrite' added");
    });
    files.set(ENTITY_PATH, ENTITY_XML);
    expect(textOf(await call())).not.toContain(READ_BACK);
  });

  it('warns when add-index on a table reports success and the index is not there', async () => {
    mockAddIndex.mockResolvedValue(OK('✅ Index added via IMetaTableProvider.Update'));

    const result = await modifyD365FileTool(
      modifyReq({
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'EquipmentId' }],
        filePath: TABLE_PATH,
      }),
      buildContext(),
    );

    expect((result as any).isError).toBeFalsy();
    expect(textOf(result)).toContain(READ_BACK);
    expect(textOf(result)).toContain('index "EquipmentIdx"');
  });
});

// ─── modify: a child the reply says was removed ──────────────────────────────

describe('modify: a removed child that is still in the saved file', () => {
  const removeField = () => modifyD365FileTool(
    modifyReq({
      objectType: 'data-entity',
      objectName: 'ContosoRentEquipmentEntity',
      operation: 'remove-field',
      fieldName: 'EquipmentId',
      filePath: ENTITY_PATH,
    }),
    buildContext(),
  );

  it('warns when remove-field reports success and the field is still there', async () => {
    mockRemoveField.mockResolvedValue(OK("✅ Field 'EquipmentId' removed"));

    const result = await removeField();

    expect((result as any).isError).toBeFalsy();
    expect(occurrences(textOf(result), READ_BACK)).toBe(1);
    expect(textOf(result)).toContain('removal of field "EquipmentId"');
  });

  it('stays silent when the field is gone', async () => {
    mockRemoveField.mockImplementation(async () => {
      files.set(ENTITY_PATH, ENTITY_XML.replace(/\t<Fields>[\s\S]*?<\/Fields>/, '\t<Fields />'));
      return OK("✅ Field 'EquipmentId' removed");
    });

    expect(textOf(await removeField())).not.toContain(READ_BACK);
  });
});

// ─── modify-property ─────────────────────────────────────────────────────────

describe('modify-property on a data entity', () => {
  const setProperty = (propertyPath: string, propertyValue: unknown) => modifyD365FileTool(
    modifyReq({
      objectType: 'data-entity',
      objectName: 'ContosoRentEquipmentEntity',
      operation: 'modify-property',
      propertyPath,
      propertyValue,
      filePath: ENTITY_PATH,
    }),
    buildContext(),
  );

  it('warns when the top-level property keeps its old value', async () => {
    // The requested label id IS in the file, on a field, which is what the
    // whole-document claim check accepts. The entity's own Label did not change.
    mockSetProperty.mockResolvedValue(OK('✅ Property Label set'));

    const result = await setProperty('Label', '@ContosoExt:EquipmentId');
    const text = textOf(result);

    expect((result as any).isError).toBeFalsy();
    expect(occurrences(text, READ_BACK)).toBe(1);
    expect(text).toContain('Label=@ContosoExt:EquipmentId: the file holds "@ContosoExt:RentEquipment"');
  });

  it('reports a value that is nowhere in the file once, not twice', async () => {
    mockSetProperty.mockResolvedValue(OK('✅ Property EntityCategory set'));

    const text = textOf(await setProperty('EntityCategory', 'Document'));

    // The existing claim check owns this case. The read-back does not repeat it.
    expect(occurrences(text, 'NOT in the file')).toBe(1);
    expect(text).not.toContain(READ_BACK);
  });

  it('stays silent when the property holds the value, in any boolean spelling', async () => {
    mockSetProperty.mockImplementation(async () => {
      files.set(ENTITY_PATH, ENTITY_XML.replace('<EntityCategory>Master</EntityCategory>', '<EntityCategory>Document</EntityCategory>'));
      return OK('✅ Property EntityCategory set');
    });
    expect(textOf(await setProperty('EntityCategory', 'Document'))).not.toContain('NOT in the file');
  });
});

// ─── create ──────────────────────────────────────────────────────────────────

describe('create: a requested top-level property that is not in the file', () => {
  const createEntity = (properties: Record<string, unknown>) => handleCreateD365File(
    createReq({
      objectType: 'data-entity',
      objectName: 'ContosoRentEquipmentEntity',
      modelName: 'ContosoExt',
      packageName: 'ContosoExt',
      packagePath: 'K:\\PackagesLocalDirectory',
      addToProject: false,
      properties: {
        primaryTable: 'ContosoRentEquipmentTable',
        fields: [{ name: 'EquipmentId' }],
        ...properties,
      },
    }),
    buildContext(false),
  );

  beforeEach(() => { files.delete(ENTITY_PATH); });

  it('warns about a data entity staging table that the create did not write', async () => {
    // dataManagementStagingTable without dataManagementEnabled: the generator
    // writes neither element, and the reply used to be a bare ✅.
    const result = await createEntity({ dataManagementStagingTable: 'ContosoRentEquipmentStaging' });
    const text = textOf(result);

    expect((result as any).isError).toBeFalsy();
    expect(text).toContain('✅ Created data-entity');
    expect(files.get(ENTITY_PATH)).not.toContain('DataManagementStagingTable');
    expect(occurrences(text, READ_BACK)).toBe(1);
    expect(text).toContain('dataManagementStagingTable=ContosoRentEquipmentStaging');
    expect(text).toContain('<DataManagementStagingTable>');
  });

  it('stays silent when every requested property is in the file', async () => {
    const result = await createEntity({
      label: '@ContosoExt:RentEquipment',
      configurationKey: 'ContosoRentKey',
      dataManagementEnabled: true,
      dataManagementStagingTable: 'ContosoRentEquipmentStaging',
      entityCategory: 'Master',
      isPublic: true,
      publicEntityName: 'ContosoRentEquipment',
      publicCollectionName: 'ContosoRentEquipments',
      primaryCompanyContext: 'DataAreaId',
    });

    expect((result as any).isError).toBeFalsy();
    const onDisk = files.get(ENTITY_PATH)!;
    expect(onDisk).toContain('<ConfigurationKey>ContosoRentKey</ConfigurationKey>');
    expect(onDisk).toContain('<DataManagementStagingTable>ContosoRentEquipmentStaging</DataManagementStagingTable>');
    expect(textOf(result)).not.toContain(READ_BACK);
  });

  it('does not report a serializer-omitted default as missing', async () => {
    // isPublic=false writes no <IsPublic> at all: absence IS the value.
    const result = await createEntity({ isPublic: false, isReadOnly: false });

    expect((result as any).isError).toBeFalsy();
    expect(files.get(ENTITY_PATH)).not.toContain('<IsPublic>');
    expect(textOf(result)).not.toContain(READ_BACK);
  });

  it('leaves a key the data-entity note already names to that note', async () => {
    const text = textOf(await createEntity({ formRef: 'ContosoRentEquipmentForm' }));

    expect(text).toMatch(/NOT written/);
    expect(text).toContain('formRef');
    expect(text).not.toContain(READ_BACK);
  });
});
