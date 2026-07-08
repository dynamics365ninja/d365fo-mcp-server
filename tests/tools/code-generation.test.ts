/**
 * Code Generation Tools Tests
 * Covers: generate_code, code_completion, generate_d365fo_xml,
 *         generate_smart_table, generate_smart_form, suggest_edt,
 *         analyze_code_patterns, suggest_method_implementation,
 *         analyze_class_completeness, get_api_usage_patterns,
 *         get_table_patterns, get_form_patterns
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { codeGenTool } from '../../src/tools/codeGen';
import { completionTool } from '../../src/tools/completion';
import { handleGenerateD365Xml } from '../../src/tools/generateD365Xml';
import { XmlTemplateGenerator } from '../../src/tools/createD365File';
import { handleGenerateSmartTable, selectUnbuildableEdts } from '../../src/tools/generateSmartTable';
import { handleGenerateSmartForm } from '../../src/tools/generateSmartForm';
import { handleSuggestEdt } from '../../src/tools/suggestEdt';
import { analyzeCodePatternsTool } from '../../src/tools/analyzePatterns';
import { suggestMethodImplementationTool } from '../../src/tools/suggestImplementation';
import { analyzeClassCompletenessTool } from '../../src/tools/analyzeCompleteness';
import { getApiUsagePatternsTool } from '../../src/tools/apiUsagePatterns';
import { handleGetTablePatterns } from '../../src/tools/getTablePatterns';
import { handleGetFormPatterns } from '../../src/tools/getFormPatterns';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const makeSymbol = (overrides: Partial<any> = {}) => ({
  id: 1, name: 'TestClass', type: 'class' as const,
  parentName: undefined, signature: undefined,
  filePath: '/Classes/TestClass.xml', model: 'MyModel',
  ...overrides,
});

const buildContext = (overrides: Partial<XppServerContext> = {}): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getClassMethods: vi.fn(() => []),
    getTableFields: vi.fn(() => []),
    searchLabels: vi.fn(() => []),
    getCustomModels: vi.fn(() => ['MyModel']),
    getAllSymbolNames: vi.fn(() => []),
    getCompletions: vi.fn(() => []),
    analyzeCodePatterns: vi.fn(() => ({ scenario: '', totalMatches: 0, patterns: [], exampleClasses: [] })),
    findSimilarMethods: vi.fn(() => []),
    suggestMissingMethods: vi.fn(() => []),
    getApiUsagePatterns: vi.fn(() => []),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn((...args: any[]) => typeof args[0] === 'string' ? { name: args[0] } : undefined), run: vi.fn() })) },
    getReadDb: vi.fn(function(this: any) { return this.db; }),
  } as any,
  parser: {
    parseClassFile: vi.fn(async () => ({ success: false })),
    parseTableFile: vi.fn(async () => ({ success: false })),
  } as any,
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    generateSearchKey: vi.fn((q: string) => `k:${q}`),
  } as any,
  workspaceScanner: {} as any,
  hybridSearch: { searchWorkspace: vi.fn(async () => []) } as any,
  ...overrides,
});

// ─── generate_code ───────────────────────────────────────────────────────────

describe('generate_code', () => {
  it('generates a class template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'class', name: 'MyHelper', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('class');
    expect(text).toContain('MyHelper');
  });

  it('generates a runnable class template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'runnable', name: 'MyRunnable', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/static void main|RunBaseBatch|runnable/i);
  });

  it('generates a SysOperation batch job (all three classes)', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'sysoperation', name: 'VendPaymCalc', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/DataContract|Controller|Service/);
  });

  it('generates a table-extension template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'table-extension', name: 'CustTable', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/ExtensionOf.*tableStr.*CustTable|CustTable.*Extension/i);
  });

  it('generates an event-handler class', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'event-handler', name: 'SalesLine', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/SubscribesTo|static void/);
  });

  it('generates a security-privilege XML', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'security-privilege', name: 'MyPrivilege', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/<AxSecurityPrivilege|security.*privilege/i);
  });

  it('returns error on missing name', async () => {
    const result = await codeGenTool(req('generate_code', { pattern: 'class' }));
    expect(result.isError).toBe(true);
  });

  it('returns error on invalid pattern', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'invalid-pattern', name: 'Foo', modelName: 'MyModel' }),
    );
    expect(result.isError).toBe(true);
  });

  it('rejects extension pattern when GROUNDING_ENFORCE=true and no token', async () => {
    const original = process.env.GROUNDING_ENFORCE;
    process.env.GROUNDING_ENFORCE = 'true';
    try {
      const result = await codeGenTool(
        req('generate_code', { pattern: 'table-extension', name: 'CustTable', modelName: 'MyModel' }),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/grounding|prepare_change/i);
    } finally {
      if (original === undefined) delete process.env.GROUNDING_ENFORCE;
      else process.env.GROUNDING_ENFORCE = original;
    }
  });

  it('generates a business-event template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'business-event', name: 'OrderConfirmed', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/BusinessEventsBase|BusinessEventsContract/);
  });

  it('generates a custom-telemetry template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'custom-telemetry', name: 'OrderProcessing', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/ApplicationInsights|logCustomEvent|emitEvent/);
  });

  it('generates a feature-class template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'feature-class', name: 'EnhancedValidation', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/FeatureClassAttribute|isEnabledByDefault/);
  });

  it('generates a composite-entity template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'composite-entity', name: 'SalesOrder', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/HeaderEntity|LineEntity|Composite/);
  });

  it('generates a custom-service template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'custom-service', name: 'Inventory', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/ServiceRequest|ServiceResponse|SysEntryPointAttribute|ServiceGroup/);
  });

  it('generates an er-custom-function template', async () => {
    const result = await codeGenTool(
      req('generate_code', { pattern: 'er-custom-function', name: 'CustomFormats', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/ERExpressionCustomFunction|FormatValue|formula designer/i);
  });
});

// ─── code_completion ─────────────────────────────────────────────────────────

describe('code_completion', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns completions for a partial method call', async () => {
    (ctx.symbolIndex.getCompletions as any).mockReturnValueOnce([
      { kind: 'Method', label: 'CustTable_find', detail: 'CustTable find()' },
    ]);

    const result = await completionTool(
      req('code_completion', { className: 'InvoiceService' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Cust');
  });

  it('returns empty completions on no match', async () => {
    // Make the class exist but have no methods
    (ctx.symbolIndex.getSymbolByName as any).mockImplementation((_name: string, type: string) =>
      type === 'class' ? makeSymbol({ name: 'ZZZNothing', type: 'class' }) : null
    );
    const result = await completionTool(
      req('code_completion', { className: 'ZZZNothing' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when code is missing', async () => {
    const result = await completionTool(req('code_completion', {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ─── generate_d365fo_xml ─────────────────────────────────────────────────────

describe('generate_d365fo_xml', () => {
  it('generates class XML', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', { objectType: 'class', objectName: 'MyClass', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('MyClass');
  });

  it('generates table XML', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', { objectType: 'table', objectName: 'MyTable', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/<AxTable|MyTable/i);
  });

  it('generates enum XML', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', { objectType: 'enum', objectName: 'MyStatus', modelName: 'MyModel' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/<AxEnum|MyStatus/i);
  });

  it('extensible enum gets UseEnumValue=No and no <Value> elements (xppc requirement)', async () => {
    // Regression for eval/corpus L0-enum-basic: IsExtensible=true + explicit values caused
    // "UseEnumValue property must be set to 'No'" build failure.
    const xml = XmlTemplateGenerator.generateAxEnumXml('MyStatus', {
      isExtensible: true,
      enumValues: [
        { name: 'Draft', value: 0, label: 'Draft' },
        { name: 'Active', value: 1, label: 'Active' },
        { name: 'Archived', value: 2, label: 'Archived' },
      ],
    });
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).toContain('<IsExtensible>true</IsExtensible>');
    expect(xml).not.toContain('<Value>1</Value>');
    expect(xml).not.toContain('<Value>2</Value>');
  });

  it('returns error on missing objectType', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', { objectName: 'Foo', modelName: 'MyModel' }),
    );
    expect(result.isError).toBe(true);
  });

  it('generates security-duty-extension XML (Azure/Linux fallback for the create gap)', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', {
        objectType: 'security-duty-extension',
        objectName: 'SalesOrderProgressInquire.MyExtension',
        modelName: 'MyModel',
        properties: { privileges: ['MyAuditLogView'] },
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('<AxSecurityDutyExtension');
    expect(result.content[0].text).toContain('<Name>MyAuditLogView</Name>');
  });

  it('generates security-role-extension XML (Azure/Linux fallback for the create gap)', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', {
        objectType: 'security-role-extension',
        objectName: 'SystemUser.MyExtension',
        modelName: 'MyModel',
        properties: { duties: ['MyAuditInquireDuty'] },
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('<AxSecurityRoleExtension');
    expect(result.content[0].text).toContain('<Name>MyAuditInquireDuty</Name>');
  });
});

// ─── XmlTemplateGenerator.generateAxDataEntityXml ───────────────────────────

describe('XmlTemplateGenerator.generateAxDataEntityXml', () => {
  it('emits an inert skeleton (no query) when primaryTable/fields are omitted — backward compat', () => {
    const xml = XmlTemplateGenerator.generateAxDataEntityXml('MyEntity', { label: 'My entity' });
    expect(xml).toContain('<Fields />');
    expect(xml).toContain('<ViewMetadata />');
    expect(xml).not.toContain('AxQuerySimpleRootDataSource');
  });

  it('populates Fields/Keys/ViewMetadata when primaryTable + fields are given (TOOL_DEFECT fix)', () => {
    // Regression for eval/corpus/runs/2026-06-30T19__L4-entity-security__fc090d0.json:
    // the entity previously came out empty with no query at all — non-functional.
    const xml = XmlTemplateGenerator.generateAxDataEntityXml('MyNoteHeaderEntity', {
      label: '@MyModel:MyLabel',
      primaryTable: 'MyNoteHeader',
      fields: [{ name: 'NoteId' }, { name: 'Subject' }],
    });

    expect(xml).toContain('<PrimaryKey>EntityKey</PrimaryKey>');
    expect(xml).toContain('<Name>NoteId</Name>');
    expect(xml).toContain('<DataSource>MyNoteHeader</DataSource>');
    expect(xml).toMatch(/<AxDataEntityViewKeyField>\s*<DataField>NoteId<\/DataField>/);
    expect(xml).toContain('AxQuerySimpleRootDataSource');
    expect(xml).toContain('<Table>MyNoteHeader</Table>');
    // Both entity fields must also appear as query datasource fields.
    expect(xml).toMatch(/<AxQuerySimpleDataSourceField>\s*<Name>NoteId<\/Name>\s*<Field>NoteId<\/Field>/);
    expect(xml).toMatch(/<AxQuerySimpleDataSourceField>\s*<Name>Subject<\/Name>\s*<Field>Subject<\/Field>/);
  });

  it('honors an explicit primaryKeyField instead of defaulting to the first field', () => {
    const xml = XmlTemplateGenerator.generateAxDataEntityXml('MyEntity', {
      primaryTable: 'MyTable',
      fields: [{ name: 'A' }, { name: 'B' }],
      primaryKeyField: 'B',
    });
    expect(xml).toMatch(/<AxDataEntityViewKeyField>\s*<DataField>B<\/DataField>/);
  });

  it('maps a field with a distinct dataField name (alias) correctly', () => {
    const xml = XmlTemplateGenerator.generateAxDataEntityXml('MyEntity', {
      primaryTable: 'MyTable',
      fields: [{ name: 'DisplayName', dataField: 'Txt' }],
    });
    expect(xml).toMatch(/<Name>DisplayName<\/Name>\s*<DataField>Txt<\/DataField>/);
    expect(xml).toMatch(/<Name>Txt<\/Name>\s*<Field>Txt<\/Field>/);
  });
});

// ─── XmlTemplateGenerator.generateAxQueryXml / generateAxViewXml ────────────

describe('XmlTemplateGenerator.generateAxQueryXml', () => {
  it('emits an inert skeleton (no datasource) when dataSource is omitted — backward compat', () => {
    const xml = XmlTemplateGenerator.generateAxQueryXml('MyQuery', { title: 'My query' });
    expect(xml).toContain('<DataSources />');
  });

  it('populates a real AxQuerySimpleRootDataSource when dataSource is given (TOOL_DEFECT fix)', () => {
    const xml = XmlTemplateGenerator.generateAxQueryXml('MyNoteHeaderQuery', {
      title: 'My note header query',
      dataSource: 'MyNoteHeader',
    });
    expect(xml).toContain('AxQuerySimpleRootDataSource');
    expect(xml).toContain('<Table>MyNoteHeader</Table>');
    expect(xml).toContain('<Title>My note header query</Title>');
    expect(xml).toContain('i:type="AxQuerySimple"');
  });

  it('includes explicit query fields when given', () => {
    const xml = XmlTemplateGenerator.generateAxQueryXml('MyQuery', {
      dataSource: 'MyTable',
      fields: [{ name: 'NoteId' }, { name: 'Subject' }],
    });
    expect(xml).toMatch(/<AxQuerySimpleDataSourceField>\s*<Name>NoteId<\/Name>\s*<Field>NoteId<\/Field>/);
    expect(xml).toMatch(/<AxQuerySimpleDataSourceField>\s*<Name>Subject<\/Name>\s*<Field>Subject<\/Field>/);
  });
});

describe('XmlTemplateGenerator.generateAxViewXml', () => {
  it('emits an inert skeleton (no query reference) when query/fields are omitted — backward compat', () => {
    const xml = XmlTemplateGenerator.generateAxViewXml('MyView', { label: 'My view' });
    expect(xml).toContain('<Fields />');
    expect(xml).not.toContain('<Query>');
  });

  it('references the query and populates bound fields when query + fields are given (TOOL_DEFECT fix)', () => {
    const xml = XmlTemplateGenerator.generateAxViewXml('MyNoteHeaderView', {
      query: 'MyNoteHeaderQuery',
      fields: [{ name: 'NoteId' }, { name: 'Subject' }],
    });
    expect(xml).toContain('<Query>MyNoteHeaderQuery</Query>');
    expect(xml).toContain('AxViewFieldBound');
    expect(xml).toMatch(/<Name>NoteId<\/Name>\s*<DataField>NoteId<\/DataField>\s*<DataSource>MyNoteHeaderQuery<\/DataSource>/);
  });

  it('honors an explicit dataSource distinct from the query name', () => {
    const xml = XmlTemplateGenerator.generateAxViewXml('MyView', {
      query: 'MyQuery',
      dataSource: 'CustomAlias',
      fields: [{ name: 'A' }],
    });
    expect(xml).toMatch(/<DataSource>CustomAlias<\/DataSource>/);
  });
});

// ─── XmlTemplateGenerator.generateAxMapXml ──────────────────────────────────

describe('XmlTemplateGenerator.generateAxMapXml', () => {
  it('emits an empty map (no mappings) when mappingTable is omitted', () => {
    const xml = XmlTemplateGenerator.generateAxMapXml('MyMap', {
      label: 'My map',
      fields: [{ name: 'Id', type: 'Int' }],
    });
    expect(xml).toContain('<Mappings />');
    expect(xml).toContain('i:type="AxMapFieldInt"');
    expect(xml).toContain('<Name>Id</Name>');
  });

  it('wires an AxTableMapping with per-field connections when mappingTable is given', () => {
    const xml = XmlTemplateGenerator.generateAxMapXml('MyLogMap', {
      fields: [
        { name: 'RefRecId', type: 'Int64', extendedDataType: 'RefRecId' },
        { name: 'Data', type: 'Container' },
      ],
      mappingTable: 'MyLogTable',
    });
    expect(xml).toContain('<MappingTable>MyLogTable</MappingTable>');
    expect(xml).toMatch(/<MapField>RefRecId<\/MapField>\s*<MapFieldTo>RefRecId<\/MapFieldTo>/);
    expect(xml).toMatch(/<MapField>Data<\/MapField>\s*<MapFieldTo>Data<\/MapFieldTo>/);
    expect(xml).toContain('i:type="AxMapFieldInt64"');
    expect(xml).toContain('<ExtendedDataType>RefRecId</ExtendedDataType>');
  });

  it('honors explicit mappings distinct from field names', () => {
    const xml = XmlTemplateGenerator.generateAxMapXml('MyMap', {
      fields: [{ name: 'CudTableId', type: 'Int' }],
      mappingTable: 'SysDataBaseLog',
      mappings: [{ mapField: 'CudTableId', mapFieldTo: 'table' }],
    });
    expect(xml).toMatch(/<MapField>CudTableId<\/MapField>\s*<MapFieldTo>table<\/MapFieldTo>/);
  });
});

// ─── XmlTemplateGenerator.generateAxSecurityPrivilegeXml ────────────────────

describe('XmlTemplateGenerator.generateAxSecurityPrivilegeXml', () => {
  it('emits empty DataEntityPermissions when no dataEntity is provided (backward compat)', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityPrivilegeXml('MyPrivilegeMaintain', {
      label: '@MyModel:MyLabel',
      targetObject: 'MyMenuItem',
      accessLevel: 'maintain',
    });
    expect(xml).toContain('<DataEntityPermissions />');
    expect(xml).not.toContain('AxSecurityDataEntityPermission');
  });

  it('generates DataEntityPermissions with Read-only Grant for view privilege', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityPrivilegeXml('MyPrivilegeView', {
      label: '@MyModel:MyLabel',
      dataEntity: 'MyEntityView',
      accessLevel: 'view',
    });
    expect(xml).toContain('<AxSecurityDataEntityPermission>');
    expect(xml).toContain('<Name>MyEntityView</Name>');
    expect(xml).toContain('<Grant>');
    expect(xml).toContain('<Read>Allow</Read>');
    expect(xml).not.toContain('<Create>');
    expect(xml).not.toContain('<Delete>');
    expect(xml).toContain('<Fields />');
    expect(xml).toContain('<Methods />');
  });

  it('generates DataEntityPermissions with full CRUD + Correct for maintain privilege', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityPrivilegeXml('MyPrivilegeMaintain', {
      label: '@MyModel:MyLabel',
      dataEntity: 'MyEntityMaintain',
      accessLevel: 'maintain',
    });
    expect(xml).toContain('<Read>Allow</Read>');
    expect(xml).toContain('<Create>Allow</Create>');
    expect(xml).toContain('<Update>Allow</Update>');
    expect(xml).toContain('<Delete>Allow</Delete>');
    expect(xml).toContain('<Correct>Allow</Correct>');
    expect(xml).toContain('<Fields />');
    expect(xml).toContain('<Methods />');
    // Canonical Microsoft serializer order (verified against shipped
    // ApplicationCommon privileges): Grant before Name, CRUD alphabetical.
    expect(xml).toMatch(
      /<AxSecurityDataEntityPermission>\s*<Grant>\s*<Correct>Allow<\/Correct>\s*<Create>Allow<\/Create>\s*<Delete>Allow<\/Delete>\s*<Read>Allow<\/Read>\s*<Update>Allow<\/Update>\s*<\/Grant>\s*<Name>MyEntityMaintain<\/Name>\s*<Fields \/>\s*<Methods \/>/,
    );
  });

  it('defaults to view (Read only) when accessLevel is omitted', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityPrivilegeXml('MyPrivilegeView', {
      dataEntity: 'MyEntity',
    });
    expect(xml).toContain('<Read>Allow</Read>');
    expect(xml).not.toContain('<Create>');
  });
});

// ─── XmlTemplateGenerator.splitXppClassSource ────────────────────────────────

describe('XmlTemplateGenerator.splitXppClassSource', () => {
  it('adds a blank line before } when member vars have no trailing blank line', () => {
    const source = [
      '[DataContractAttribute]',
      'public final class ContosoVendPaymTermRecalcContract',
      '{',
      '    VendGroupId vendGroupId;',
      '}',
    ].join('\n');
    const { declaration, methods } = XmlTemplateGenerator.splitXppClassSource(source);
    expect(methods).toHaveLength(0);
    // Must end with a blank line before the closing brace
    expect(declaration).toMatch(/VendGroupId vendGroupId;\n\n}$/);
  });

  it('does not double-add the blank line when one is already present', () => {
    const source = [
      'public class MyContract',
      '{',
      '    str myField;',
      '',
      '}',
    ].join('\n');
    const { declaration } = XmlTemplateGenerator.splitXppClassSource(source);
    // Should still be exactly \n\n} — not \n\n\n}
    expect(declaration).toMatch(/myField;\n\n}$/);
    expect(declaration).not.toMatch(/myField;\n\n\n}/);
  });

  it('does not add a blank line for an empty class body', () => {
    const source = 'public class MyEmpty\n{\n}';
    const { declaration } = XmlTemplateGenerator.splitXppClassSource(source);
    // Empty body: no extra blank line injected
    expect(declaration).toMatch(/{\n}$/);
  });
});

// ─── XmlTemplateGenerator.normalizeSelfReferenceName ────────────────────────
//
// Regression for eval/corpus/runs/2026-07-06T16__L1-class-basic__73707ff.json
// (classification: TOOL_DEFECT, build.succeeded: false): the caller passed an
// already-fully-resolved objectName ("ContosoXyzNoteFormatter") but sourceCode's
// own `class XyzNoteFormatter` used the bare, unprefixed name. Because
// objectName itself needed no prefix-normalizing (finalObjectName ===
// args.objectName), the existing xmlContent-only "CRITICAL FIX" guard in
// create_d365fo_file (keyed on finalObjectName !== args.objectName) never
// fired, so the AOT object's <Name> disagreed with its own X++ class keyword
// — a hard xppc build error.
describe('XmlTemplateGenerator.normalizeSelfReferenceName', () => {
  it('renames a stale self-reference in the header and in method bodies (construct pattern)', () => {
    const declaration = 'public class XyzNoteFormatter\n{\n    str prefix;\n\n}';
    const methods = [
      { name: 'new', source: 'public void new(str _prefix)\n    {\n        prefix = _prefix;\n    }' },
      {
        name: 'construct',
        source: 'public static XyzNoteFormatter construct(str _prefix)\n    {\n        return new XyzNoteFormatter(_prefix);\n    }',
      },
    ];

    const result = XmlTemplateGenerator.normalizeSelfReferenceName('ContosoXyzNoteFormatter', declaration, methods);

    expect(result.declaration).toContain('public class ContosoXyzNoteFormatter');
    expect(result.declaration).not.toMatch(/(?<!Contoso)XyzNoteFormatter/);
    const construct = result.methods.find(m => m.name === 'construct')!;
    expect(construct.source).toContain('public static ContosoXyzNoteFormatter construct');
    expect(construct.source).toContain('return new ContosoXyzNoteFormatter(_prefix);');
    expect(construct.source).not.toMatch(/\bXyzNoteFormatter\b/);
  });

  it('is a no-op when the declared name already matches className', () => {
    const declaration = 'public class ContosoFoo\n{\n}';
    const methods = [{ name: 'run', source: 'public void run()\n    {\n    }' }];
    const result = XmlTemplateGenerator.normalizeSelfReferenceName('ContosoFoo', declaration, methods);
    expect(result.declaration).toBe(declaration);
    expect(result.methods).toEqual(methods);
  });

  it('generateAxClassXml applies the correction end-to-end (Name element + Declaration + method Source agree)', () => {
    const sourceCode =
      'public class XyzNoteFormatter\n{\n    str prefix;\n}\n\n' +
      'public static XyzNoteFormatter construct(str _prefix)\n{\n    return new XyzNoteFormatter(_prefix);\n}';
    const xml = XmlTemplateGenerator.generateAxClassXml('ContosoXyzNoteFormatter', sourceCode);

    expect(xml).toContain('<Name>ContosoXyzNoteFormatter</Name>');
    expect(xml).toContain('public class ContosoXyzNoteFormatter');
    expect(xml).toContain('public static ContosoXyzNoteFormatter construct');
    expect(xml).toContain('return new ContosoXyzNoteFormatter(_prefix);');
    // No leftover reference to the stale, unprefixed self-name anywhere in the XML.
    expect(xml).not.toMatch(/\bXyzNoteFormatter\b/);
  });

  it('parseSourceForBridge applies the correction when className is passed (bridge CREATE path)', () => {
    const sourceCode =
      'class XyzNoteFormatter\n{\n    str prefix;\n}\n\n' +
      'public static XyzNoteFormatter construct(str _prefix)\n{\n    return new XyzNoteFormatter(_prefix);\n}';
    const parsed = XmlTemplateGenerator.parseSourceForBridge(sourceCode, 'ContosoXyzNoteFormatter');

    expect(parsed.declaration).toContain('class ContosoXyzNoteFormatter');
    const construct = parsed.methods.find(m => m.name === 'construct')!;
    expect(construct.source).toContain('ContosoXyzNoteFormatter construct');
    expect(construct.source).toContain('new ContosoXyzNoteFormatter(_prefix)');
  });

  it('parseSourceForBridge without className (legacy callers) leaves self-references untouched', () => {
    const sourceCode = 'class Foo\n{\n}\n\npublic static Foo construct()\n{\n    return new Foo();\n}';
    const parsed = XmlTemplateGenerator.parseSourceForBridge(sourceCode);
    expect(parsed.declaration).toContain('class Foo');
  });
});

// ─── XmlTemplateGenerator security generators ───────────────────────────────

describe('XmlTemplateGenerator security duty/role generators', () => {
  it('emits privilege references on a duty from properties.privileges', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyXml('MyDuty', {
      label: '@My:Duty',
      privileges: ['MyView', 'MyMaintain'],
    });
    expect(xml).toContain('<AxSecurityRolePermissionSet>\n\t\t\t<Name>MyView</Name>');
    expect(xml).toContain('<Name>MyMaintain</Name>');
    expect(xml).not.toContain('<Privileges />');
  });

  it('accepts a comma-separated privilege string', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyXml('MyDuty', {
      privileges: 'MyView, MyMaintain',
    });
    expect(xml).toContain('<Name>MyView</Name>');
    expect(xml).toContain('<Name>MyMaintain</Name>');
  });

  it('keeps an empty self-closing Privileges when none are given', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyXml('MyDuty', {});
    expect(xml).toContain('<Privileges />');
  });

  it('emits duty references on a role from properties.duties', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityRoleXml('MyRole', {
      duties: ['MyDuty1', 'MyDuty2'],
    });
    expect(xml).toContain('<AxSecurityRoleDutyPermission>\n\t\t\t<Name>MyDuty1</Name>');
    expect(xml).toContain('<Name>MyDuty2</Name>');
    expect(xml).not.toContain('<Duties />');
  });
});

// ─── security-duty-extension / security-role-extension generators ───────────
// AxSecurityDutyExtension/AxSecurityRoleExtension add privileges/duties to an
// EXISTING (often Microsoft-owned) duty/role without overlaying it — confirmed
// against real shipped objects, e.g.
// ApplicationCommon\AxSecurityDutyExtension\BatchJobMaintain.ApplicationCommon.xml
// and ApplicationCommon\AxSecurityRoleExtension\SystemUser.ApplicationCommon.xml.
describe('XmlTemplateGenerator security duty/role EXTENSION generators', () => {
  it('emits AxSecurityPrivilegeReference entries on a duty extension', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyExtensionXml(
      'SalesOrderProgressInquire.ContosoExtension',
      { privileges: ['ContosoSalesPostingAuditLogView'] },
    );
    expect(xml).toContain('<AxSecurityDutyExtension');
    expect(xml).toContain('<Name>SalesOrderProgressInquire.ContosoExtension</Name>');
    expect(xml).toContain('<AxSecurityPrivilegeReference>\n\t\t\t<Name>ContosoSalesPostingAuditLogView</Name>');
    expect(xml).toContain('<PropertyModifications />');
    // No <Label> — duty extensions don't carry one (only the base duty does).
    expect(xml).not.toContain('<Label>');
  });

  it('accepts a comma-separated privilege string on a duty extension', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyExtensionXml('MyDuty.Extension', {
      privileges: 'MyView, MyMaintain',
    });
    expect(xml).toContain('<Name>MyView</Name>');
    expect(xml).toContain('<Name>MyMaintain</Name>');
  });

  it('keeps an empty self-closing Privileges when none are given on a duty extension', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyExtensionXml('MyDuty.Extension', {});
    expect(xml).toContain('<Privileges />');
  });

  it('emits duty + privilege references on a role extension', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityRoleExtensionXml(
      'SystemUser.ContosoExtension',
      { duties: ['MyDuty1'], privileges: ['MyPrivilege1'] },
    );
    expect(xml).toContain('<AxSecurityRoleExtension');
    expect(xml).toContain('<Name>SystemUser.ContosoExtension</Name>');
    expect(xml).toContain('<DirectAccessPermissions />');
    expect(xml).toContain('<AxSecurityDutyReference>\n\t\t\t<Name>MyDuty1</Name>');
    expect(xml).toContain('<AxSecurityPrivilegeReference>\n\t\t\t<Name>MyPrivilege1</Name>');
    expect(xml).toContain('<PropertyModifications />');
  });

  it('keeps empty self-closing Duties/Privileges when none are given on a role extension', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityRoleExtensionXml('MyRole.Extension', {});
    expect(xml).toContain('<Duties />');
    expect(xml).toContain('<Privileges />');
  });
});

// ─── table create: enum field generation ─────────────────────────────────────

describe('XmlTemplateGenerator.generateAxTableXml enum fields', () => {
  it('emits AxTableFieldEnum + EnumType from enumType (extension-style field spec)', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('ContosoRentEquipment', {
      fields: [{ name: 'EquipmentStatus', enumType: 'NoYes', label: '@Contoso:Status' }],
    });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
    expect(xml).not.toContain('AxTableFieldString');
  });

  it('honors an explicit fieldType="AxTableFieldEnum"', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('ContosoRentEquipment', {
      fields: [{ name: 'EquipmentStatus', fieldType: 'AxTableFieldEnum', enumType: 'NoYes' }],
    });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
  });

  it('still maps the primitive type="Enum" spec to an enum field', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('ContosoRentEquipment', {
      fields: [{ name: 'EquipmentStatus', type: 'Enum', enumType: 'NoYes' }],
    });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
  });

  it('leaves plain string fields untouched', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('ContosoRentEquipment', {
      fields: [{ name: 'EquipmentName', edt: 'Name' }],
    });
    expect(xml).toContain('i:type="AxTableFieldString"');
    expect(xml).not.toContain('<EnumType>');
  });
});

// ─── generate_smart_table ────────────────────────────────────────────────────

describe('generate_smart_table', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    // Force non-Windows code path so tools return XML as text instead of writing to disk.
    // Also clear EXTENSION_PREFIX so generated names stay unprefixed and match test assertions.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('EXTENSION_PREFIX', '');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.unstubAllEnvs();
  });

  it('generates table XML from field definitions', async () => {
    const result = await handleGenerateSmartTable(
      {
        name: 'MyCustomTable',
        modelName: 'MyModel',
        fieldsHint: 'Description,Amount',
      },
      ctx.symbolIndex,
    );
    expect(result?.content[0].text).toContain('MyCustomTable');
    expect(result?.content[0].text).toMatch(/Description|Amount/);
  });

  it('includes an index when uniqueIndex is specified', async () => {
    const result = await handleGenerateSmartTable(
      {
        name: 'MyTable',
        modelName: 'MyModel',
        fieldsHint: 'AccountNum,Name',
        primaryKeyFields: ['AccountNum'],
      },
      ctx.symbolIndex,
    );
    expect(result?.content[0].text).toMatch(/<Indexes>|UniqueIndex|Idx/i);
  });

  it('preserves both fields when the same hint name appears twice (dedup regression #2)', async () => {
    // Agent passed the EDT name twice ("AmountMST, AmountMST") instead of distinct
    // field names. The second occurrence must be renamed AmountMST2, not dropped.
    const result = await handleGenerateSmartTable(
      {
        name: 'RentalLine',
        modelName: 'MyModel',
        fieldsHint: 'AgreementId, AmountMST, AmountMST',
      },
      ctx.symbolIndex,
    );
    expect(result?.isError).toBeFalsy();
    const xml = result?.content[0].text ?? '';
    // Both amount fields present under different names
    expect(xml).toContain('AmountMST');
    expect(xml).toContain('AmountMST2');
    // Not silently collapsed to a single AmountMST
    const count = (xml.match(/AmountMST(?!2)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1); // original present
    expect(xml).toContain('AmountMST2');     // duplicate renamed
  });
});

// ─── scaffold pre-write EDT gate ─────────────────────────────────────────────

describe('selectUnbuildableEdts (scaffold pre-write gate)', () => {
  const modelDir = 'K:\\Pkg\\MyModel\\MyModel';

  it('blocks an EDT that exists neither in the index nor on disk', () => {
    const blocked = selectUnbuildableEdts(
      [{ field: 'Foo', edt: 'GhostEdt' }],
      modelDir,
      () => false, // nothing on disk
    );
    expect(blocked).toEqual([{ field: 'Foo', edt: 'GhostEdt' }]);
  });

  it('allows a same-session EDT that is on disk but unindexed (xppc reads disk)', () => {
    // Separator-agnostic so this holds on both Windows (path.join → "\") and Linux CI ("/").
    const onDisk = (p: string) => p.replace(/\\/g, '/').endsWith('AxEdt/ContosoSessionEdt.xml');
    const blocked = selectUnbuildableEdts(
      [{ field: 'A', edt: 'ContosoSessionEdt' }, { field: 'B', edt: 'GhostEdt' }],
      modelDir,
      onDisk,
    );
    // Only the truly-missing one is blocked; the on-disk same-session EDT passes.
    expect(blocked).toEqual([{ field: 'B', edt: 'GhostEdt' }]);
  });

  it('returns nothing when there are no missing EDTs', () => {
    expect(selectUnbuildableEdts([], modelDir, () => false)).toEqual([]);
  });
});

// ─── generate_smart_form ─────────────────────────────────────────────────────

describe('generate_smart_form', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('EXTENSION_PREFIX', '');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.unstubAllEnvs();
  });

  it('generates form XML from a table datasource', async () => {
    const result = await handleGenerateSmartForm(
      {
        name: 'MyCustomForm',
        modelName: 'MyModel',
        dataSource: 'MyCustomTable',
      },
      ctx.symbolIndex,
    );
    expect(result?.content[0].text).toContain('MyCustomForm');
    expect(result?.content[0].text).toContain('MyCustomTable');
  });

  it('defaults the Caption to the bound table\'s own reused Label, not the raw object name', async () => {
    // Regression: eval/corpus/runs/2026-07-06T17__L1-form-listpage__cb1b73d.json (cross-
    // referenced by L1-form-dialog and L1-form-lookup as "a systemic scaffold default, not
    // a one-off"): with no explicit caption/label given, Caption used to fall back to the
    // raw object name ("PFXDemoNoteHeaderListPage") instead of the table's real Label,
    // even though that Label is resolvable via the symbol index.
    const labelCtx = buildContext({
      symbolIndex: {
        ...ctx.symbolIndex,
        getSymbolByName: vi.fn((name: string, type: string) =>
          type === 'table' && name === 'ConDemoNoteHeader'
            ? { name, type: 'table', signature: '@TaxTransactionInquiry:HeaderNote' }
            : undefined,
        ),
      } as any,
    });

    const result = await handleGenerateSmartForm(
      {
        name: 'ConDemoNoteHeaderListPage',
        modelName: 'MyModel',
        dataSource: 'ConDemoNoteHeader',
        formPattern: 'ListPage',
      },
      labelCtx.symbolIndex,
    );
    const text = result?.content[0].text as string;
    expect(text).toContain('<Caption xmlns="">@TaxTransactionInquiry:HeaderNote</Caption>');
    expect(text).not.toContain('<Caption xmlns="">ConDemoNoteHeaderListPage</Caption>');
    expect(text).not.toContain('<Caption xmlns="">PFXConDemoNoteHeaderListPage</Caption>');
  });

  it('an explicit caption argument still wins over the table Label', async () => {
    const labelCtx = buildContext({
      symbolIndex: {
        ...ctx.symbolIndex,
        getSymbolByName: vi.fn((name: string, type: string) =>
          type === 'table' && name === 'ConDemoNoteHeader'
            ? { name, type: 'table', signature: '@TaxTransactionInquiry:HeaderNote' }
            : undefined,
        ),
      } as any,
    });

    const result = await handleGenerateSmartForm(
      {
        name: 'ConDemoNoteHeaderListPage',
        modelName: 'MyModel',
        dataSource: 'ConDemoNoteHeader',
        formPattern: 'ListPage',
        caption: '@MyModel:ExplicitCaption',
      },
      labelCtx.symbolIndex,
    );
    const text = result?.content[0].text as string;
    expect(text).toContain('<Caption xmlns="">@MyModel:ExplicitCaption</Caption>');
  });

  it('falls back to the (resolved) object name when the table has no indexed Label (unchanged behaviour)', async () => {
    const result = await handleGenerateSmartForm(
      {
        name: 'MyUnlabeledForm',
        modelName: 'MyModel',
        dataSource: 'UnindexedTable',
        formPattern: 'ListPage',
      },
      ctx.symbolIndex, // default mock: getSymbolByName always returns undefined
    );
    const text = result?.content[0].text as string;
    // No table Label available — falls back to the resolved object name, same as before
    // this fix (no @Label-style caption is emitted; whatever name the object resolved to).
    expect(text).toMatch(/<Caption xmlns="">[^@<]*MyUnlabeledForm<\/Caption>/);
  });

  it('warns about a STALE datasource table (indexed row, but its file no longer exists on disk)', async () => {
    // Regression: eval/corpus/runs/2026-07-06T17__L1-form-dialog__cb1b73d.json — a
    // rolled-back prior run's table left a phantom `symbols` row. The existence
    // check used to be a bare `SELECT 1 ... WHERE name = ?`, which matched the
    // stale row and silently skipped the warning — the scaffold then produced a
    // form bound to a table with no file on disk (4 build errors, no warning).
    // No fs mocking needed: this fictional package path genuinely does not exist
    // on the machine running the test, so the real fs.existsSync(...) === false
    // check exercises the same "stale row" branch a rolled-back VM table would.
    const staleCtx = buildContext({
      symbolIndex: {
        ...ctx.symbolIndex,
        getReadDb: vi.fn(() => ({
          prepare: vi.fn((sql: string) => {
            // The later staleness check (this fix) selects file_path specifically.
            if (sql.includes('file_path')) {
              return { get: vi.fn(() => ({ file_path: 'K:\\Definitely\\Does\\Not\\Exist\\GoneTable.xml' })) };
            }
            // The earlier "does the table exist at all" lookup (dataSource resolution,
            // a SEPARATE existing check) — the stale DB row still matches by name here,
            // same as a real un-invalidated `symbols` row would; the table is only
            // discovered to be gone once the file_path staleness check runs later.
            if (sql.includes('SELECT name FROM symbols')) {
              return { get: vi.fn(() => ({ name: 'GoneTable' })) };
            }
            // "closest alternate name" suggestion lookup — no suggestion.
            return { get: vi.fn(() => undefined) };
          }),
        })),
      } as any,
    });

    const result = await handleGenerateSmartForm(
      { name: 'MyStaleForm', modelName: 'MyModel', dataSource: 'GoneTable' },
      staleCtx.symbolIndex,
    );
    const text = result?.content[0].text as string;
    expect(text).toContain('is stale in the index');
    expect(text).toContain('GoneTable');
    expect(text).toContain('update_symbol_index');
  });

  it('expands a template-less pattern deterministically from the catalog', async () => {
    // "Task" (TaskSingle) has a catalog spec but no hand-written builder
    // template. It used to silently degrade to SimpleList; now the deterministic
    // expander emits the correct TaskSingle structure (single source of truth
    // with the validator) instead of the wrong pattern.
    const result = await handleGenerateSmartForm(
      {
        name: 'MyTaskForm',
        modelName: 'MyModel',
        dataSource: 'MyCustomTable',
        formPattern: 'Task',
      },
      ctx.symbolIndex,
    );
    const text = result?.content[0].text as string;
    // Correct pattern emitted (not degraded to SimpleList) …
    expect(text).toContain('<Pattern xmlns="">TaskSingle</Pattern>');
    expect(text).not.toContain('<Pattern xmlns="">SimpleList</Pattern>');
    // … and the deterministic-catalog note is shown, not the degrade warning.
    expect(text).toContain('Generated deterministically from the form-pattern catalog');
    expect(text).not.toContain('No dedicated template');
  });

  it('DetailsMaster warns that the Overview FastTab needs a matching table field group', async () => {
    // Regression: eval/corpus/runs/2026-07-07T11__L3-form-add-datasource-lines__cb1b73d.json,
    // eval/corpus/runs/2026-07-07T15__L4-master-security-slice__cb1b73d.json — DetailsMaster's
    // FieldsFieldGroups TabPage always emits <DataGroup>Overview</DataGroup> on its inner Group
    // control, but the scaffold never creates (or checks for) a matching AxTableFieldGroup named
    // "Overview" on the bound table. A brand-new custom table almost never has one, so the very
    // next build silently fails with "Field group 'Overview' does not exist" and no pointer back
    // to this control. This tool has no table-write access to auto-create the field group (and a
    // prior investigation found even a same-session add-field-group call unreliable against
    // xppc's build — unconfirmed without a live VM re-check), so it must surface the dependency
    // loudly instead.
    const result = await handleGenerateSmartForm(
      {
        name: 'MyDetailsForm',
        modelName: 'MyModel',
        dataSource: 'MyCustomTable',
        formPattern: 'DetailsMaster',
      },
      ctx.symbolIndex,
    );
    const text = result?.content[0].text as string;
    expect(text).toContain('<DataGroup>Overview</DataGroup>');
    expect(text).toContain('references a field group named "Overview"');
    expect(text).toContain('MyCustomTable');
    expect(text).toContain('add-field-group');
  });

  it('Dialog (no DataGroup="Overview" anywhere in its template) does NOT emit the field-group warning', async () => {
    // Unlike SimpleList/SimpleListDetails/DetailsMaster (all of which reference a field group
    // named "Overview" somewhere — Grid.DataGroup or the FieldsFieldGroups Group.DataGroup),
    // Dialog's template has no such reference, so the warning must not fire unconditionally.
    const result = await handleGenerateSmartForm(
      {
        name: 'MyDialogForm',
        modelName: 'MyModel',
        dataSource: 'MyCustomTable',
        formPattern: 'Dialog',
      },
      ctx.symbolIndex,
    );
    const text = result?.content[0].text as string;
    expect(text).not.toContain('<DataGroup>Overview</DataGroup>');
    expect(text).not.toContain('references a field group named "Overview"');
  });
});

// ─── suggest_edt ─────────────────────────────────────────────────────────────

describe('suggest_edt', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns EDT suggestions for a field description', async () => {
    const result = await handleSuggestEdt(
      { fieldName: 'CustAccount' },
      ctx.symbolIndex,
    );
    expect(result?.content[0].text).toContain('CustAccount');
  });

  it('returns no-suggestions message when nothing matches', async () => {
    const result = await handleSuggestEdt(
      { fieldName: 'XyzBizarroObscure999' },
      ctx.symbolIndex,
    );
    // Function always returns JSON with fieldName and suggestions array
    expect(result?.content[0].text).toContain('XyzBizarroObscure999');
  });
});

// ─── analyze_code_patterns ───────────────────────────────────────────────────

describe('analyze_code_patterns', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns pattern analysis results', async () => {
    (ctx.symbolIndex.analyzeCodePatterns as any).mockReturnValueOnce({
      scenario: 'batch-job',
      totalMatches: 2,
      patterns: [],
      exampleClasses: ['SalesFormLetter', 'SalesFormLetterPost'],
    });

    const result = await analyzeCodePatternsTool(
      req('analyze_code_patterns', { scenario: 'batch-job', classPattern: 'SalesFormLetter' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesFormLetter');
  });

  it('returns error when pattern is missing', async () => {
    const result = await analyzeCodePatternsTool(req('analyze_code_patterns', {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ─── suggest_method_implementation ───────────────────────────────────────────

describe('suggest_method_implementation', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns implementation suggestions', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([
      makeSymbol({ name: 'validateWrite', type: 'method', parentName: 'CustTable', signature: 'public boolean validateWrite()' }),
    ]);

    const result = await suggestMethodImplementationTool(
      req('suggest_method_implementation', { className: 'CustTable', methodName: 'validateWrite' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when required fields are missing', async () => {
    const result = await suggestMethodImplementationTool(req('suggest_method_implementation', {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ─── analyze_class_completeness ──────────────────────────────────────────────

describe('analyze_class_completeness', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns completeness report for a class', async () => {
    (ctx.symbolIndex.getSymbolByName as any).mockReturnValue(
      makeSymbol({ name: 'MyHelper', type: 'class' }),
    );
    (ctx.symbolIndex.getClassMethods as any).mockReturnValue([
      makeSymbol({ name: 'run', type: 'method', parentName: 'MyHelper', signature: 'void run()' }),
    ]);

    const result = await analyzeClassCompletenessTool(
      req('analyze_class_completeness', { className: 'MyHelper' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('MyHelper');
  });

  it('returns error when className is missing', async () => {
    const result = await analyzeClassCompletenessTool(req('analyze_class_completeness', {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ─── get_api_usage_patterns ──────────────────────────────────────────────────

describe('get_api_usage_patterns', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns API usage patterns for a class', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([
      makeSymbol({ name: 'LedgerJournalCheckPost', type: 'class', model: 'ApplicationSuite' }),
    ]);

    const result = await getApiUsagePatternsTool(
      req('get_api_usage_patterns', { apiName: 'LedgerJournalCheckPost' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when apiName is missing', async () => {
    const result = await getApiUsagePatternsTool(req('get_api_usage_patterns', {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ─── get_table_patterns ──────────────────────────────────────────────────────

describe('get_table_patterns', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns table creation patterns', async () => {
    const result = await handleGetTablePatterns({ tableGroup: 'Main' }, ctx.symbolIndex);
    expect(result?.content[0].text).toMatch(/pattern/i);
  });
});

// ─── get_form_patterns ───────────────────────────────────────────────────────

describe('get_form_patterns', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns form creation patterns', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([
      makeSymbol({ name: 'SalesTable', type: 'form', model: 'ApplicationSuite' }),
    ]);

    const result = await handleGetFormPatterns({ tableName: 'SalesTable' }, ctx.symbolIndex);
    expect(result?.content[0].text).toMatch(/SalesTable|pattern|form/i);
  });
});
