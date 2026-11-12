/**
 * add-control and reference groups, through modify_d365fo_file.
 *
 * A VM run asked for controlType="ReferenceGroup" on a form extension and got an
 * AxFormStringControl under a ✅: the XML writer had no such type and fell back to
 * String. And without a controlType, a surrogate foreign key such as
 * SalesTable.WorkerSalesTaker became an Int64 control, where dragging the field onto
 * the form in Visual Studio adds a reference group.
 *
 * Metadata shapes follow the shipped SalesTable, HcmWorker and their EDTs; the
 * Contoso fields cover the cases the shipped tables do not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddControl, store } = vi.hoisted(() => ({
  mockBridgeAddControl: vi.fn(),
  store: { files: new Map<string, string>(), extensionRows: [] as Array<{ name: string }>, noIndex: false },
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddControl: mockBridgeAddControl,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const tableField = (name: string, edt: string) => [
  `\t\t<AxTableField xmlns="" i:type="AxTableFieldInt64">`,
  `\t\t\t<Name>${name}</Name>`,
  `\t\t\t<ExtendedDataType>${edt}</ExtendedDataType>`,
  `\t\t</AxTableField>`,
].join('\n');

const recIdRelation = (name: string, field: string, related: string) => [
  `\t\t<AxTableRelation>`,
  `\t\t\t<Name>${name}</Name>`,
  `\t\t\t<RelatedTable>${related}</RelatedTable>`,
  `\t\t\t<Constraints>`,
  `\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">`,
  `\t\t\t\t\t<Name>${field}</Name>`,
  `\t\t\t\t\t<Field>${field}</Field>`,
  `\t\t\t\t\t<RelatedField>RecId</RelatedField>`,
  `\t\t\t\t</AxTableRelationConstraint>`,
  `\t\t\t</Constraints>`,
  `\t\t</AxTableRelation>`,
].join('\n');

const table = (root: string, name: string, fields: string[], relations: string[], extra = '') => [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<${root} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`,
  `\t<Name>${name}</Name>${extra}`,
  `\t<Fields>`, ...fields, `\t</Fields>`,
  `\t<Relations>`, ...relations, `\t</Relations>`,
  `</${root}>`,
].join('\n');

const edt = (name: string, links: { extends?: string; referenceTable?: string }) =>
  `<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:type="AxEdtInt64"><Name>${name}</Name>` +
  (links.extends ? `<Extends>${links.extends}</Extends>` : '') +
  (links.referenceTable ? `<ReferenceTable>${links.referenceTable}</ReferenceTable>` : '') +
  `</AxEdt>`;

/** What findBaseObjectXml finds, by "<type>:<name>". */
const METADATA: Record<string, string> = {
  'table:salestable': table('AxTable', 'SalesTable', [
    tableField('WorkerSalesTaker', 'SalesTaker'),
    tableField('ContosoNoKeyRef', 'ContosoNoKeyRecId'),
    tableField('ContosoEdtOnlyRef', 'ContosoEdtRecId'),
    tableField('ContosoQuantity', 'ContosoQuantity'),
  ], [
    recIdRelation('WorkerSalesTaker_FK', 'WorkerSalesTaker', 'HcmWorker'),
    recIdRelation('ContosoNoKeyRef_FK', 'ContosoNoKeyRef', 'ContosoNoKeyTable'),
  ]),
  'table-extension:salestable.contosoext': table('AxTableExtension', 'SalesTable.ContosoExt', [
    tableField('ContosoApprover', 'HcmWorkerRecId'),
  ], [
    recIdRelation('ContosoApprover_FK', 'ContosoApprover', 'HcmWorker'),
  ]),
  'table:hcmworker': table('AxTable', 'HcmWorker', [], [], '\n\t<ReplacementKey>HcmWorker_AK2</ReplacementKey>'),
  'table:contosonokeytable': table('AxTable', 'ContosoNoKeyTable', [], []),
  'edt:salestaker': edt('SalesTaker', { extends: 'HcmWorkerRecId' }),
  'edt:hcmworkerrecid': edt('HcmWorkerRecId', { extends: 'RefRecId', referenceTable: 'HcmWorker' }),
  'edt:contosonokeyrecid': edt('ContosoNoKeyRecId', { extends: 'RefRecId' }),
  'edt:contosoedtrecid': edt('ContosoEdtRecId', { extends: 'RefRecId', referenceTable: 'HcmWorker' }),
  'edt:contosoquantity': edt('ContosoQuantity', {}),
};

/** The base form: data source SalesTableDs binds table SalesTable. */
const BASE_FORM = [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">`,
  `\t<Name>SalesTable</Name>`,
  `\t<SourceCode>`,
  `\t\t<Methods xmlns="" />`,
  `\t</SourceCode>`,
  `\t<DataSources>`,
  `\t\t<AxFormDataSource xmlns="">`,
  `\t\t\t<Name>SalesTableDs</Name>`,
  `\t\t\t<Table>SalesTable</Table>`,
  `\t\t</AxFormDataSource>`,
  `\t</DataSources>`,
  `\t<Design>`,
  `\t\t<Controls xmlns="">`,
  `\t\t\t<AxFormControl xmlns="" i:type="AxFormGroupControl">`,
  `\t\t\t\t<Name>ContosoHeaderGroup</Name>`,
  `\t\t\t\t<Type>Group</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t\t<Controls />`,
  `\t\t\t</AxFormControl>`,
  `\t\t</Controls>`,
  `\t</Design>`,
  `</AxForm>`,
].join('\n');

// The base form is in the package folders too; data source SalesTableDs is not named after its table.
METADATA['form:salestable'] = BASE_FORM;

const EXTENSION = [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">`,
  `\t<Name>SalesTable.ContosoExt</Name>`,
  `\t<ControlModifications />`,
  `\t<Controls />`,
  `\t<DataSourceModifications />`,
  `\t<DataSources />`,
  `</AxFormExtension>`,
].join('\n');

// store.noIndex: a write-only companion, where findBaseObjectXml finds no standard object.
vi.mock('../../src/utils/baseObjectXml', () => ({
  findBaseFormXml: vi.fn(async (name: string) => (!store.noIndex && name.toLowerCase() === 'salestable' ? BASE_FORM : null)),
  findBaseObjectXml: vi.fn(async (type: string, name: string) => {
    if (store.noIndex) return null;
    return type === 'form' && name.toLowerCase() === 'salestable' ? BASE_FORM : METADATA[`${type}:${name.toLowerCase()}`] ?? null;
  }),
}));

const AOT_FOLDER_TYPES: Record<string, string> = { AxForm: 'form', AxTable: 'table', AxEdt: 'edt', AxTableExtension: 'table-extension' };

/** The package folders, as the companion sees them: every METADATA object under its Ax* folder. */
vi.mock('../../src/utils/objectFileLookup', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/objectFileLookup')>()),
  findAotFilesInAllPackages: vi.fn(async (folder: string, match: (fileName: string) => boolean) => {
    const type = AOT_FOLDER_TYPES[folder];
    return Object.keys(METADATA)
      .filter(k => k.startsWith(`${type}:`))
      .map(k => `${METADATA[k].match(/<Name>([^<]+)<\/Name>/)![1]}.xml`)
      .filter(match)
      .map(f => `K:\\PackagesLocalDirectory\\ApplicationSuite\\Foundation\\${folder}\\${f}`);
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const file = store.files.get(String(p));
    if (file !== undefined) return file;
    const inPackage = /\\(AxForm|AxTable|AxEdt|AxTableExtension)\\([^\\]+)\.xml$/.exec(String(p));
    if (inPackage) {
      const content = METADATA[`${AOT_FOLDER_TYPES[inPackage[1]]}:${inPackage[2].toLowerCase()}`];
      if (content) return content;
    }
    if (String(p).endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  // writeFileAtomic writes a temp sibling and renames it over the target.
  writeFile: vi.fn(async (p: string, data: string) => {
    for (const key of store.files.keys()) if (String(p).startsWith(key)) store.files.set(key, String(data));
  }),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1 })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
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
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const EXT_PATH = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxFormExtension\\SalesTable.ContosoExt.xml';
const FORM_PATH = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxForm\\ContosoOrderForm.xml';

const addControl = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'form-extension',
      objectName: 'SalesTable.ContosoExt',
      operation: 'add-control',
      parentControl: 'ContosoHeaderGroup',
      controlName: 'ContosoSalesTakerRef',
      controlDataSource: 'SalesTableDs',
      filePath: EXT_PATH,
      ...args,
    },
  },
});

const buildContext = (): XppServerContext => {
  const stmt = {
    all: vi.fn((..._: unknown[]) => store.extensionRows),
    get: vi.fn(() => undefined),
    run: vi.fn(),
  };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['ContosoExt']),
      db: { prepare: vi.fn((sql: string) => (/table-extension/.test(sql) ? stmt : { ...stmt, all: vi.fn(() => []) })) },
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

const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text as string;
const ext = () => store.files.get(EXT_PATH)!;

describe('add-control on a form extension: reference groups', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    mockBridgeAddControl.mockReset();
    store.files = new Map([[EXT_PATH, EXTENSION]]);
    store.extensionRows = [{ name: 'SalesTable.ContosoExt' }];
    store.noIndex = false;
    ctx = buildContext();
  });

  it('writes a reference group for a surrogate foreign key when no controlType is given', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'WorkerSalesTaker' }), ctx);
    expect(text(r)).toContain('🔗 controlType "ReferenceGroup": SalesTable.WorkerSalesTaker is a surrogate foreign key to HcmWorker');
    expect(text(r)).toContain('relation WorkerSalesTaker_FK');
    expect(text(r)).toContain('replacement key HcmWorker_AK2');
    expect(ext()).toMatch(
      /i:type="AxFormReferenceGroupControl">\s*<Name>ContosoSalesTakerRef<\/Name>\s*<Type>ReferenceGroup<\/Type>\s*<FormControlExtension i:nil="true" \/>\s*<Controls \/>\s*<DataSource>SalesTableDs<\/DataSource>\s*<ReferenceField>WorkerSalesTaker<\/ReferenceField>/,
    );
    expect(ext()).not.toContain('<DataField>');
  });

  it('finds a field a table extension adds', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'ContosoApprover' }), ctx);
    expect(text(r)).toContain('SalesTable.ContosoApprover is a surrogate foreign key to HcmWorker');
    expect(ext()).toContain('<ReferenceField>ContosoApprover</ReferenceField>');
  });

  it('takes the related table from the EDT when the table has no relation for the field', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'ContosoEdtOnlyRef' }), ctx);
    expect(text(r)).toContain('(EDT ContosoEdtRecId, ReferenceTable of EDT ContosoEdtRecId)');
    expect(ext()).toContain('<ReferenceField>ContosoEdtOnlyRef</ReferenceField>');
  });

  it('writes an Int64 control, and says why, when the related table has no replacement key', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'ContosoNoKeyRef' }), ctx);
    expect(text(r)).toContain('ContosoNoKeyTable has no replacement key, so it was added as an Int64 control');
    expect(ext()).toMatch(/i:type="AxFormInt64Control">\s*<Name>ContosoSalesTakerRef<\/Name>/);
    expect(ext()).toContain('<DataField>ContosoNoKeyRef</DataField>');
  });

  it('leaves an Int64 field whose EDT does not derive from RefRecId alone', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'ContosoQuantity', controlType: undefined }), ctx);
    expect(text(r)).not.toMatch(/surrogate foreign key/);
    expect(ext()).not.toContain('AxFormReferenceGroupControl');
  });

  it('keeps an explicit controlType over the automatic choice', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'WorkerSalesTaker', controlType: 'Int64' }), ctx);
    expect(text(r)).not.toMatch(/surrogate foreign key/);
    expect(ext()).toMatch(/i:type="AxFormInt64Control">/);
    expect(ext()).toContain('<DataField>WorkerSalesTaker</DataField>');
  });

  it('writes an explicit ReferenceGroup without checking the field', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'ContosoNoKeyRef', controlType: 'ReferenceGroup' }), ctx);
    expect(r.isError).toBeFalsy();
    expect(ext()).toContain('i:type="AxFormReferenceGroupControl"');
    expect(ext()).toContain('<ReferenceField>ContosoNoKeyRef</ReferenceField>');
  });

  it('finds the standard table, EDTs and related table in the package folders on a companion without an index', async () => {
    // The VM run: d365fo-local has no index, so findBaseObjectXml found none of them and
    // WorkerSalesTaker came out as a String control with no word about why.
    store.noIndex = true;
    store.extensionRows = [];
    const r = await modifyD365FileTool(addControl({ controlDataField: 'WorkerSalesTaker' }), ctx);
    expect(text(r)).toContain('🔗 controlType "ReferenceGroup": SalesTable.WorkerSalesTaker is a surrogate foreign key to HcmWorker');
    expect(text(r)).toContain('replacement key HcmWorker_AK2');
    expect(ext()).toContain('<ReferenceField>WorkerSalesTaker</ReferenceField>');
  });

  it('finds a table extension\'s field in the package folders on a companion without an index', async () => {
    store.noIndex = true;
    store.extensionRows = [];
    const r = await modifyD365FileTool(addControl({ controlDataField: 'ContosoApprover' }), ctx);
    expect(text(r)).toContain('SalesTable.ContosoApprover is a surrogate foreign key to HcmWorker');
  });

  it('refuses a controlType it cannot write instead of writing a String control', async () => {
    const r = await modifyD365FileTool(addControl({ controlDataField: 'WorkerSalesTaker', controlType: 'SegmentedEntry' }), ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('controlType "SegmentedEntry" cannot be written into a form extension — nothing was written');
    expect(text(r)).toContain('ReferenceGroup');
    expect(ext()).toBe(EXTENSION);
  });
});

describe('add-control on a plain form: a reference group through the bridge', () => {
  let ctx: XppServerContext;

  /** A form like BASE_FORM, under a custom name, with or without the control the bridge saved. */
  const plainForm = (savedControl: string[] = []) => BASE_FORM
    .replace('<Name>SalesTable</Name>', '<Name>ContosoOrderForm</Name>')
    .replace('\t\t\t\t<Controls />', savedControl.length ? ['\t\t\t\t<Controls>', ...savedControl, '\t\t\t\t</Controls>'].join('\n') : '\t\t\t\t<Controls />');

  /** What the bridge saves for a new reference group: bound to the data source only. */
  const savedByBridge = [
    `\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormReferenceGroupControl">`,
    `\t\t\t\t\t\t<Name>ContosoSalesTakerRef</Name>`,
    `\t\t\t\t\t\t<Type>ReferenceGroup</Type>`,
    `\t\t\t\t\t\t<FormControlExtension i:nil="true" />`,
    `\t\t\t\t\t\t<Controls />`,
    `\t\t\t\t\t\t<DataSource>SalesTableDs</DataSource>`,
    `\t\t\t\t\t</AxFormControl>`,
  ];

  const onForm = (args: Record<string, unknown>) =>
    addControl({ objectType: 'form', objectName: 'ContosoOrderForm', filePath: FORM_PATH, ...args });

  beforeEach(() => {
    mockBridgeAddControl.mockReset();
    store.files = new Map([[FORM_PATH, plainForm()]]);
    store.extensionRows = [];
    ctx = buildContext();
  });

  it('creates the control without a DataField, then writes its ReferenceField', async () => {
    mockBridgeAddControl.mockImplementation(async () => {
      store.files.set(FORM_PATH, plainForm(savedByBridge));
      return { success: true, message: "✅ Control 'ContosoSalesTakerRef' added to 'ContosoHeaderGroup' via IMetaFormProvider.Update" };
    });
    const r = await modifyD365FileTool(onForm({ controlDataField: 'WorkerSalesTaker' }), ctx);

    const [, , , , controlType, dataSource, dataField] = mockBridgeAddControl.mock.calls[0];
    expect(controlType).toBe('ReferenceGroup');
    expect(dataSource).toBe('SalesTableDs');
    expect(dataField).toBeUndefined();
    expect(text(r)).toContain('🔗 controlType "ReferenceGroup"');
    expect(store.files.get(FORM_PATH)).toMatch(
      /<DataSource>SalesTableDs<\/DataSource>\s*<ReferenceField>WorkerSalesTaker<\/ReferenceField>\s*<\/AxFormControl>/,
    );
  });

  it('reports the control as added, with a warning, when ReferenceField cannot be written', async () => {
    // The bridge says it saved the control, but the file does not hold it.
    mockBridgeAddControl.mockResolvedValue({ success: true, message: "✅ Control 'ContosoSalesTakerRef' added" });
    const r = await modifyD365FileTool(onForm({ controlDataField: 'WorkerSalesTaker', controlType: 'ReferenceGroup' }), ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('⚠️ Not bound to a field: ReferenceField could not be set');
    expect(text(r)).toContain('propertyPath="ReferenceField"');
  });

  it('passes the DataField on for every other control type', async () => {
    mockBridgeAddControl.mockResolvedValue({ success: true, message: '✅ added' });
    await modifyD365FileTool(onForm({ controlDataField: 'WorkerSalesTaker', controlType: 'Int64' }), ctx);
    const [, , , , controlType, , dataField] = mockBridgeAddControl.mock.calls[0];
    expect(controlType).toBe('Int64');
    expect(dataField).toBe('WorkerSalesTaker');
  });
});
