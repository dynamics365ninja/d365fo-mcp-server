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
import { handleGenerateSmartTable } from '../../src/tools/generateSmartTable';
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
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
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

  it('returns error on missing objectType', async () => {
    const result = await handleGenerateD365Xml(
      req('generate_d365fo_xml', { objectName: 'Foo', modelName: 'MyModel' }),
    );
    expect(result.isError).toBe(true);
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

// ─── table create: enum field generation ─────────────────────────────────────

describe('XmlTemplateGenerator.generateAxTableXml enum fields', () => {
  it('emits AxTableFieldEnum + EnumType from enumType (extension-style field spec)', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('AslRentEquipment', {
      fields: [{ name: 'EquipmentStatus', enumType: 'NoYes', label: '@Asl:Status' }],
    });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
    expect(xml).not.toContain('AxTableFieldString');
  });

  it('honors an explicit fieldType="AxTableFieldEnum"', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('AslRentEquipment', {
      fields: [{ name: 'EquipmentStatus', fieldType: 'AxTableFieldEnum', enumType: 'NoYes' }],
    });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
  });

  it('still maps the primitive type="Enum" spec to an enum field', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('AslRentEquipment', {
      fields: [{ name: 'EquipmentStatus', type: 'Enum', enumType: 'NoYes' }],
    });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
  });

  it('leaves plain string fields untouched', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('AslRentEquipment', {
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
