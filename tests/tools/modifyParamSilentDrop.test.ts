/**
 * Regression tests — d365fo_file(modify) must never DISCARD a parameter in silence.
 *
 * Corpus evidence (2026-07-21 sweep, findings #5 / #6 / #27 / #35 "THE CLUSTER"):
 *   eval/corpus/runs/2026-07-21T18__L2-table-modify-lifecycle__c262b19.json
 *   eval/corpus/runs/2026-07-21T19__L2-performance-set-based__c262b19.json
 *   eval/corpus/runs/2026-07-21T20__L4-master-security-slice__c262b19.json
 *
 * The shared shape: a parameter is accepted, the op answers "✅ success", and the
 * value is absent from the written XML with no warning anywhere.
 *   • #5  add-relation dropped relationshipType / relationCardinality /
 *         relatedTableCardinality — all three documented WITH defaults in the op's
 *         own spec — and xppbp then raised
 *         BPErrorTableRelationshipPropertiesCompleteness naming exactly those three.
 *   • #6  modify-field {fieldName, mandatory:true} answered "✅ Field 'Description'
 *         modified via IMetaTableProvider.Update" while writing nothing (the key is
 *         fieldMandatory; the Zod schema strips unknown keys).
 *   • #27 indexAllowDuplicates is a boolean but the XML value is No/Yes, so the
 *         natural string spelling was rejected with a bare "expected boolean".
 *   • #35 add-data-source drops linkType (C#-side: CreateFormDataSourceRoot sets
 *         Name/Table/JoinSource only) — it can only be reported, not fixed, in-repo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool, coerceNoYesFlag } from '../../src/tools/modifyD365File';
import {
  findIgnoredParams,
  findMissingMutationParams,
  renderIgnoredParamsWarning,
} from '../../src/tools/d365foFileOpSpecs';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Bridge mock ──────────────────────────────────────────────────────────────

const {
  mockBridgeModifyField, mockBridgeAddRelation, mockBridgeAddIndex,
  mockBridgeAddDataSource, mockBridgeRefreshProvider,
} = vi.hoisted(() => ({
  mockBridgeModifyField: vi.fn(),
  mockBridgeAddRelation: vi.fn(),
  mockBridgeAddIndex: vi.fn(),
  mockBridgeAddDataSource: vi.fn(),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeModifyField: mockBridgeModifyField,
    bridgeAddRelation: mockBridgeAddRelation,
    bridgeAddIndex: mockBridgeAddIndex,
    bridgeAddDataSource: mockBridgeAddDataSource,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A table exactly as the bridge leaves it after add-relation: the relation carries
 * Name / RelatedTable / Constraints and NOTHING else. Copied from the captured
 * golden eval/goldens/L2-table-modify-lifecycle/ConDemoModLifecycle.metadata.xml,
 * which enshrines the defect.
 */
const TABLE_WITH_BARE_RELATION = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoModLifecycle</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoModLifecycle extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>CustAccount</Name>
\t\t\t<ExtendedDataType>CustAccount</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations>
\t\t<AxTableRelation>
\t\t\t<Name>CustTable</Name>
\t\t\t<RelatedTable>CustTable</RelatedTable>
\t\t\t<Constraints>
\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">
\t\t\t\t\t<Name>CustAccount</Name>
\t\t\t\t\t<Field>CustAccount</Field>
\t\t\t\t\t<RelatedField>AccountNum</RelatedField>
\t\t\t\t</AxTableRelationConstraint>
\t\t\t</Constraints>
\t\t</AxTableRelation>
\t</Relations>
\t<StateMachines />
</AxTable>`;

const FORM_EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustTable.ConDemoExt</Name>
\t<Controls />
\t<DataSources />
</AxFormExtension>`;

const { mockWriteFile, currentXml } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => {}),
  currentXml: { value: '' },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return currentXml.value;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
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
}));

const TABLE_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConDemoModLifecycle.xml';
const FORM_EXT_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxFormExtension\\CustTable.ConDemoExt.xml';

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

/** XML of the last write to the object file. */
function writtenXml(): string | undefined {
  const calls = mockWriteFile.mock.calls as unknown as Array<[string, string, string]>;
  const hit = [...calls].reverse().find(c => typeof c[0] === 'string' && c[0].endsWith('.xml') && !c[0].includes('.backup'));
  return hit?.[1];
}

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  currentXml.value = TABLE_WITH_BARE_RELATION;
  mockBridgeModifyField.mockResolvedValue({ success: true, message: '✅ Field modified via IMetaTableProvider.Update' });
  mockBridgeAddRelation.mockResolvedValue({ success: true, message: "✅ Relation 'CustTable' added via IMetaTableProvider.Update" });
  mockBridgeAddIndex.mockResolvedValue({ success: true, message: "✅ Index added via IMetaTableProvider.Update" });
  mockBridgeAddDataSource.mockResolvedValue({ success: true, message: '✅ Data source added via IMetaFormProvider.Update' });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('#6 — a mutation op with no recognised mutation param must not claim success', () => {
  it('rejects modify-field {fieldName, mandatory:true} instead of answering ✅', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'modify-field',
        fieldName: 'Description',
        mandatory: true, // WRONG KEY — the real one is fieldMandatory
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    // It must name the correct parameter, not just fail.
    expect(text).toContain('fieldMandatory');
    // And it must not have pretended to write anything.
    expect(text).not.toContain('IMetaTableProvider.Update');
    expect(mockBridgeModifyField).not.toHaveBeenCalled();
    expect(writtenXml()).toBeUndefined();
  });

  it('still accepts modify-field with a real mutation param', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'modify-field',
        fieldName: 'Description',
        fieldMandatory: true,
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeModifyField).toHaveBeenCalled();
  });
});

describe('#35 — an accepted-but-dropped parameter must be reported, never silent', () => {
  it('warns about off-op index params (allowDuplicates / alternateKey) and suggests the real names', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'add-index',
        indexName: 'TicketIdx',
        indexFields: [{ fieldName: 'CustAccount' }],
        allowDuplicates: false, // dropped: the param is indexAllowDuplicates
        alternateKey: true,     // dropped: the param is indexAlternateKey
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    const text = textOf(result);
    expect(text).toContain('allowDuplicates');
    expect(text).toContain('indexAllowDuplicates');
    expect(text).toContain('alternateKey');
    expect(text).toContain('indexAlternateKey');
    expect(text).toMatch(/did not reach the written XML/);
  });

  it('no longer warns about linkType — the bridge writes it now', async () => {
    // Was: "add-data-source drops linkType (C#-side)". The bridge's
    // CreateFormDataSourceRoot now sets LinkType, verified on the VM against
    // AxFormDataSourceRoot.LinkType (DataSourceLinkType_ITxt) — a real
    // <LinkType>InnerJoin</LinkType> lands in the form XML. Flagging it as
    // not-honoured would now itself be the lie.
    currentXml.value = FORM_EXTENSION_XML;
    const result = await modifyD365FileTool(
      req({
        objectType: 'form-extension',
        objectName: 'CustTable.ConDemoExt',
        operation: 'add-data-source',
        dataSourceName: 'CustTrans',
        dataSourceTable: 'CustTrans',
        joinSource: 'CustTable',
        linkType: 'Active',
        filePath: FORM_EXT_FILE_PATH,
      }),
      buildContext(),
    );

    expect(textOf(result)).not.toMatch(/linkType[\s\S]*NOT WRITTEN/);
  });

  it('does not warn when every parameter is consumed', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'add-index',
        indexName: 'TicketIdx',
        indexFields: [{ fieldName: 'CustAccount' }],
        indexAlternateKey: true,
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );
    expect(textOf(result)).not.toContain('did not reach the written XML');
  });
});

describe('#5 — add-relation must write the relation properties it documents', () => {
  it('writes Cardinality / RelatedTableCardinality / RelationshipType with the documented defaults', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'add-relation',
        relationName: 'CustTable',
        relatedTable: 'CustTable',
        relationConstraints: [{ fieldName: 'CustAccount', relatedFieldName: 'AccountNum' }],
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const xml = writtenXml();
    expect(xml).toBeDefined();
    expect(xml).toContain('<Cardinality>ZeroMore</Cardinality>');
    expect(xml).toContain('<RelatedTableCardinality>ExactlyOne</RelatedTableCardinality>');
    expect(xml).toContain('<RelationshipType>Association</RelationshipType>');
  });

  it('writes the explicitly supplied values', async () => {
    await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'add-relation',
        relationName: 'CustTable',
        relatedTable: 'CustTable',
        relationCardinality: 'ZeroOne',
        relatedTableCardinality: 'ZeroOne',
        relationshipType: 'Composition',
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    const xml = writtenXml()!;
    expect(xml).toContain('<Cardinality>ZeroOne</Cardinality>');
    expect(xml).toContain('<RelatedTableCardinality>ZeroOne</RelatedTableCardinality>');
    expect(xml).toContain('<RelationshipType>Composition</RelationshipType>');
  });

  it('emits the SDK element order (misordered AxTable properties are silently dropped — #13)', async () => {
    await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'add-relation',
        relationName: 'CustTable',
        relatedTable: 'CustTable',
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    const xml = writtenXml()!;
    const relation = /<AxTableRelation>[\s\S]*?<\/AxTableRelation>/.exec(xml)![0];
    const order = [...relation.matchAll(/<(Name|Cardinality|RelatedTable|RelatedTableCardinality|RelationshipType|Constraints)>/g)]
      .map(m => m[1])
      // <Name> also appears inside a constraint — keep only the first occurrence of each.
      .filter((v, i, a) => a.indexOf(v) === i);
    expect(order).toEqual([
      'Name', 'Cardinality', 'RelatedTable', 'RelatedTableCardinality', 'RelationshipType', 'Constraints',
    ]);
  });

  it('is idempotent — a relation that already carries the properties is not rewritten', async () => {
    // First call writes them…
    await modifyD365FileTool(
      req({
        objectType: 'table', objectName: 'ConDemoModLifecycle', operation: 'add-relation',
        relationName: 'CustTable', relatedTable: 'CustTable', filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );
    currentXml.value = writtenXml()!;
    mockWriteFile.mockClear();

    // …the second call finds nothing to add.
    await modifyD365FileTool(
      req({
        objectType: 'table', objectName: 'ConDemoModLifecycle', operation: 'add-relation',
        relationName: 'CustTable', relatedTable: 'CustTable', filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );
    expect(writtenXml()).toBeUndefined();
  });
});

describe('#27 — NoYes-shaped index flags accept the XML spelling', () => {
  it('coerceNoYesFlag maps Yes/No and true/false, and ignores anything else', () => {
    expect(coerceNoYesFlag('Yes')).toBe(true);
    expect(coerceNoYesFlag('no')).toBe(false);
    expect(coerceNoYesFlag(true)).toBe(true);
    expect(coerceNoYesFlag('true')).toBe(true);
    expect(coerceNoYesFlag(undefined)).toBeUndefined();
    expect(coerceNoYesFlag('Maybe')).toBeUndefined();
  });

  it('accepts indexAllowDuplicates="No" instead of rejecting it with "expected boolean"', async () => {
    // Bridge cannot resolve the same-session table → direct-XML fallback writes it,
    // so the flag value is observable in the file.
    mockBridgeAddIndex.mockResolvedValue({ success: false, message: "Table 'ConDemoModLifecycle' not found" });

    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoModLifecycle',
        operation: 'add-index',
        indexName: 'CustAccountIdx',
        indexFields: [{ fieldName: 'CustAccount' }],
        indexAllowDuplicates: 'No',
        indexAlternateKey: 'Yes',
        filePath: TABLE_FILE_PATH,
      }),
      buildContext(),
    );

    expect(textOf(result)).not.toMatch(/expected boolean/i);
    expect(result.isError).toBeFalsy();
    const xml = writtenXml()!;
    expect(xml).toContain('<AllowDuplicates>No</AllowDuplicates>');
    expect(xml).toContain('<AlternateKey>Yes</AlternateKey>');
  });
});

describe('parameter-accounting helpers', () => {
  it('classifies an unknown key, an off-op key and a not-honoured key', () => {
    expect(findIgnoredParams('modify-field', ['fieldName', 'mandatory'])).toEqual([
      { name: 'mandatory', reason: 'unknown', suggestion: 'fieldMandatory' },
    ]);
    expect(findIgnoredParams('add-relation', ['relationName', 'relatedTable', 'indexName'])).toEqual([
      { name: 'indexName', reason: 'other-op', suggestion: undefined },
    ]);
    // linkType used to be the third case here; it is honoured now, so the
    // not-honoured example is the one the metamodel genuinely cannot express.
    expect(findIgnoredParams('add-data-source', ['dataSourceName', 'dataSourceTable', 'linkType'])).toEqual([]);
    expect(findIgnoredParams('add-enum-value', ['enumValueName', 'enumValueHelpText'])).toEqual([
      { name: 'enumValueHelpText', reason: 'not-honoured', detail: expect.stringContaining('AxEnumValue') },
    ]);
  });

  it('never flags core params or params the op consumes', () => {
    expect(findIgnoredParams('add-relation', [
      'objectType', 'objectName', 'operation', 'filePath', 'modelName', 'createBackup',
      'relationName', 'relatedTable', 'relationConstraints',
      'relationCardinality', 'relatedTableCardinality', 'relationshipType',
    ])).toEqual([]);
  });

  it('accepts an alias of a required param (methodCode for sourceCode)', () => {
    expect(findIgnoredParams('add-method', ['methodName', 'methodCode'])).toEqual([]);
  });

  it('reports the two enum-value drops the audit turned up', () => {
    // add-enum-value advertises enumValueHelpText, but an enum VALUE has no help
    // text in the metamodel at all — AxEnumValue exposes Name/Tags/Label/
    // ConfigurationKey/Value/CountryRegionCodes/FeatureClass and nothing else
    // (reflected on platform 7.0.7858.27). This one can never become honoured,
    // so the detail must say that rather than promise a C# fix.
    expect(findIgnoredParams('add-enum-value', ['enumValueName', 'enumValueHelpText'])).toEqual([
      { name: 'enumValueHelpText', reason: 'not-honoured', detail: expect.stringContaining('AxEnumValue') },
    ]);
    // enumValueNewName IS honoured by modify-enum-value (it was simply missing
    // from the op-spec registry) — it must not be flagged.
    expect(findIgnoredParams('modify-enum-value', ['enumValueName', 'enumValueNewName'])).toEqual([]);
  });

  it('says nothing for an unknown operation rather than guessing', () => {
    expect(findIgnoredParams('teleport-object', ['whatever'])).toEqual([]);
    expect(renderIgnoredParamsWarning('teleport-object', [])).toBe('');
  });

  it('flags a mutation op called with no mutation param', () => {
    expect(findMissingMutationParams('modify-field', ['fieldName'])).toContain('fieldMandatory');
    expect(findMissingMutationParams('modify-field', ['fieldName', 'fieldLabel'])).toEqual([]);
    // Ops without a mutationOneOf list are unaffected.
    expect(findMissingMutationParams('remove-field', ['fieldName'])).toEqual([]);
  });
});
