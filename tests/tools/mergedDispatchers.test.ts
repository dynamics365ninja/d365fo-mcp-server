/**
 * Merged dispatcher tests — verify the consolidated tools route to the correct
 * underlying handler and remap their discriminator/params correctly.
 *
 * Covers: extension_info, validate_code, generate_object, object_patterns,
 * analyze_code, security_info.
 * The underlying handlers are mocked so these tests assert ONLY the dispatcher's
 * own routing + argument-remapping logic (the handlers have their own tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ── Mock every underlying handler so we can capture the forwarded args ────────
// Factories are hoisted above imports — keep them self-contained (no outer vars).
vi.mock('../../src/tools/knowledge/findCocExtensions', () => ({ findCocExtensionsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'coc' }] })) }));
vi.mock('../../src/tools/knowledge/findEventHandlers', () => ({ findEventHandlersTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'events' }] })) }));
vi.mock('../../src/tools/readers/tableExtensionInfo', () => ({ tableExtensionInfoTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'table-merge' }] })) }));
vi.mock('../../src/tools/knowledge/analyzeExtensionPoints', () => ({ analyzeExtensionPointsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'points' }] })) }));
vi.mock('../../src/tools/knowledge/extensionStrategyAdvisor', () => ({ extensionStrategyAdvisorTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'strategy' }] })) }));
vi.mock('../../src/tools/analysis/validateXpp', () => ({ validateXppTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'syntax' }] })) }));
vi.mock('../../src/tools/write/resolveReferences', () => ({ resolveReferencesTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'references' }] })) }));
vi.mock('../../src/tools/smart/codeGen', () => ({ codeGenTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'pattern' }] })) }));
vi.mock('../../src/tools/smart/generateSmart', () => ({ generateSmartTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'scaffold' }] })) }));
vi.mock('../../src/tools/xml/generateTableFields', () => ({ generateTableFieldsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'fields' }] })) }));
vi.mock('../../src/tools/knowledge/getTablePatterns', () => ({ getTablePatternsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'table' }] })) }));
vi.mock('../../src/tools/knowledge/formPattern', () => ({ formPatternTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'form' }] })) }));
vi.mock('../../src/tools/knowledge/analyzePatterns', () => ({ analyzeCodePatternsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'patterns' }] })) }));
vi.mock('../../src/tools/smart/suggestImplementation', () => ({ suggestMethodImplementationTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'impl' }] })) }));
vi.mock('../../src/tools/analysis/analyzeCompleteness', () => ({ analyzeClassCompletenessTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'complete' }] })) }));
vi.mock('../../src/tools/knowledge/apiUsagePatterns', () => ({ getApiUsagePatternsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'api' }] })) }));
vi.mock('../../src/tools/readers/securityArtifactInfo', () => ({ securityArtifactInfoTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'artifact' }] })) }));
vi.mock('../../src/tools/readers/securityCoverageInfo', () => ({ securityCoverageInfoTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'coverage' }] })) }));

import { extensionInfoTool } from '../../src/tools/readers/extensionInfo';
import { securityInfoTool } from '../../src/tools/readers/securityInfo';
import { securityArtifactInfoTool } from '../../src/tools/readers/securityArtifactInfo';
import { securityCoverageInfoTool } from '../../src/tools/readers/securityCoverageInfo';
import { analyzeCodeTool } from '../../src/tools/analysis/analyzeCode';
import { getApiUsagePatternsTool } from '../../src/tools/knowledge/apiUsagePatterns';
import { validateCodeTool } from '../../src/tools/analysis/validateCode';
import { generateObjectTool } from '../../src/tools/generateObject';
import { objectPatternsTool } from '../../src/tools/knowledge/objectPatterns';
import { findCocExtensionsTool } from '../../src/tools/knowledge/findCocExtensions';
import { findEventHandlersTool } from '../../src/tools/knowledge/findEventHandlers';
import { tableExtensionInfoTool } from '../../src/tools/readers/tableExtensionInfo';
import { analyzeExtensionPointsTool } from '../../src/tools/knowledge/analyzeExtensionPoints';
import { extensionStrategyAdvisorTool } from '../../src/tools/knowledge/extensionStrategyAdvisor';
import { validateXppTool } from '../../src/tools/analysis/validateXpp';
import { resolveReferencesTool } from '../../src/tools/write/resolveReferences';
import { codeGenTool } from '../../src/tools/smart/codeGen';
import { generateSmartTool } from '../../src/tools/smart/generateSmart';
import { generateTableFieldsTool } from '../../src/tools/xml/generateTableFields';
import { getTablePatternsTool } from '../../src/tools/knowledge/getTablePatterns';
import { formPatternTool } from '../../src/tools/knowledge/formPattern';

const ctx: any = { symbolIndex: {} };
const req = (name: string, args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});
const argsOf = (mock: any) => mock.mock.calls[0][0].params.arguments;

beforeEach(() => vi.clearAllMocks());

// ── extension_info ────────────────────────────────────────────────────────────
describe('extension_info dispatcher', () => {
  it('mode=coc → findCocExtensions with target→className, method→methodName', async () => {
    await extensionInfoTool(req('extension_info', { mode: 'coc', target: 'CustTable', method: 'validateWrite' }), ctx);
    expect(findCocExtensionsTool).toHaveBeenCalledOnce();
    expect(argsOf(findCocExtensionsTool)).toMatchObject({ className: 'CustTable', methodName: 'validateWrite' });
  });

  it('mode=events (class default) → findEventHandlers with target→targetClass, method→eventName', async () => {
    await extensionInfoTool(req('extension_info', { mode: 'events', target: 'CustTable', method: 'onInserted' }), ctx);
    expect(argsOf(findEventHandlersTool)).toMatchObject({ targetClass: 'CustTable', eventName: 'onInserted' });
    expect(argsOf(findEventHandlersTool).targetTable).toBeUndefined();
  });

  it('mode=events with objectType=table → targetTable', async () => {
    await extensionInfoTool(req('extension_info', { mode: 'events', target: 'SalesLine', objectType: 'table' }), ctx);
    expect(argsOf(findEventHandlersTool)).toMatchObject({ targetTable: 'SalesLine' });
    expect(argsOf(findEventHandlersTool).targetClass).toBeUndefined();
  });

  it('mode=table-merge → tableExtensionInfo with target→tableName', async () => {
    await extensionInfoTool(req('extension_info', { mode: 'table-merge', target: 'CustTable' }), ctx);
    expect(argsOf(tableExtensionInfoTool)).toMatchObject({ tableName: 'CustTable' });
  });

  it('mode=points → analyzeExtensionPoints with target→objectName', async () => {
    await extensionInfoTool(req('extension_info', { mode: 'points', target: 'SalesFormLetter', objectType: 'class' }), ctx);
    expect(argsOf(analyzeExtensionPointsTool)).toMatchObject({ objectName: 'SalesFormLetter', objectType: 'class' });
  });

  it('mode=strategy → extensionStrategyAdvisor with goal + target→objectName', async () => {
    await extensionInfoTool(req('extension_info', { mode: 'strategy', goal: 'validate qty', target: 'SalesLine' }), ctx);
    expect(argsOf(extensionStrategyAdvisorTool)).toMatchObject({ goal: 'validate qty', objectName: 'SalesLine' });
  });

  it('missing target on coc → friendly error, no handler call', async () => {
    const r: any = await extensionInfoTool(req('extension_info', { mode: 'coc' }), ctx);
    expect(r.isError).toBe(true);
    expect(findCocExtensionsTool).not.toHaveBeenCalled();
  });

  it('missing goal on strategy → friendly error', async () => {
    const r: any = await extensionInfoTool(req('extension_info', { mode: 'strategy', target: 'X' }), ctx);
    expect(r.isError).toBe(true);
    expect(extensionStrategyAdvisorTool).not.toHaveBeenCalled();
  });

  it('unknown mode → friendly error listing valid modes', async () => {
    const r: any = await extensionInfoTool(req('extension_info', { mode: 'bogus', target: 'X' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('coc');
  });
});

// ── validate_code ─────────────────────────────────────────────────────────────
describe('validate_code dispatcher', () => {
  it('mode=syntax → validateXpp (request passed through)', async () => {
    await validateCodeTool(req('validate_code', { mode: 'syntax', code: 'x', codeType: 'xpp' }), ctx);
    expect(validateXppTool).toHaveBeenCalledOnce();
    expect(resolveReferencesTool).not.toHaveBeenCalled();
  });

  it('mode=references → resolveReferences', async () => {
    await validateCodeTool(req('validate_code', { mode: 'references', code: 'x' }), ctx);
    expect(resolveReferencesTool).toHaveBeenCalledOnce();
    expect(validateXppTool).not.toHaveBeenCalled();
  });

  it('omitted mode defaults to syntax', async () => {
    await validateCodeTool(req('validate_code', { code: 'x' }), ctx);
    expect(validateXppTool).toHaveBeenCalledOnce();
  });

  it('missing code → friendly error', async () => {
    const r: any = await validateCodeTool(req('validate_code', { mode: 'syntax' }), ctx);
    expect(r.isError).toBe(true);
    expect(validateXppTool).not.toHaveBeenCalled();
  });

  it('unknown mode → friendly error', async () => {
    const r: any = await validateCodeTool(req('validate_code', { mode: 'bogus', code: 'x' }), ctx);
    expect(r.isError).toBe(true);
  });
});

// ── generate_object ───────────────────────────────────────────────────────────
describe('generate_object dispatcher', () => {
  it('mode=pattern → codeGen', async () => {
    await generateObjectTool(req('generate_object', { mode: 'pattern', pattern: 'class', name: 'MyHelper' }), ctx);
    expect(codeGenTool).toHaveBeenCalledOnce();
    expect(generateSmartTool).not.toHaveBeenCalled();
  });

  it('mode=scaffold → generateSmart', async () => {
    await generateObjectTool(req('generate_object', { mode: 'scaffold', objectType: 'table', name: 'MyTable' }), ctx);
    expect(generateSmartTool).toHaveBeenCalledOnce();
    expect(codeGenTool).not.toHaveBeenCalled();
  });

  it('unknown/omitted mode → friendly error', async () => {
    const r: any = await generateObjectTool(req('generate_object', { name: 'X' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('kind="op-spec"');
  });

  // The published schema advertises only mode/name/pattern/objectType/modelName
  // plus a free-form `params` (issue #825), so everything else arrives nested
  // and has to be flattened before the underlying handler sees it.
  it('flattens `params` into the forwarded arguments', async () => {
    await generateObjectTool(
      req('generate_object', {
        mode: 'scaffold',
        objectType: 'form',
        name: 'MyForm',
        params: { cloneFrom: 'CustGroup', tableMapping: { CustGroup: 'MyGroup' } },
      }),
      ctx,
    );
    const args = argsOf(generateSmartTool);
    expect(args.cloneFrom).toBe('CustGroup');
    expect(args.tableMapping).toEqual({ CustGroup: 'MyGroup' });
    expect(args.params).toBeUndefined();
  });

  it('still accepts flat legacy params, with nested winning on collision', async () => {
    await generateObjectTool(
      req('generate_object', {
        mode: 'fields', name: 'MyTable', fieldGroup: 'Flat', params: { fieldGroup: 'Nested' },
      }),
      ctx,
    );
    expect(argsOf(generateTableFieldsTool).fieldGroup).toBe('Nested');
  });

  it('answers a missing required param with the mode spec, not a bare zod error', async () => {
    const r: any = await generateObjectTool(req('generate_object', { mode: 'pattern', name: 'MyHelper' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('missing required parameter(s) pattern');
    expect(r.content[0].text).toContain('kind="op-spec"');
    expect(codeGenTool).not.toHaveBeenCalled();
  });
});

// ── object_patterns ───────────────────────────────────────────────────────────
describe('object_patterns dispatcher', () => {
  it('domain=table → getTablePatterns', async () => {
    await objectPatternsTool(req('object_patterns', { domain: 'table', tableGroup: 'Parameter' }), ctx);
    expect(getTablePatternsTool).toHaveBeenCalledOnce();
    expect(formPatternTool).not.toHaveBeenCalled();
  });

  it('domain=form → formPattern', async () => {
    await objectPatternsTool(req('object_patterns', { domain: 'form', action: 'analyze' }), ctx);
    expect(formPatternTool).toHaveBeenCalledOnce();
    expect(getTablePatternsTool).not.toHaveBeenCalled();
  });

  it('infers domain=form + action=spec from a bare pattern arg', async () => {
    await objectPatternsTool(req('object_patterns', { pattern: 'SimpleList' }), ctx);
    expect(formPatternTool).toHaveBeenCalledOnce();
    expect(getTablePatternsTool).not.toHaveBeenCalled();
    expect(argsOf(formPatternTool)).toMatchObject({ domain: 'form', action: 'spec', pattern: 'SimpleList' });
  });

  it('infers domain=form + action=analyze from recommend', async () => {
    await objectPatternsTool(req('object_patterns', { recommend: { entityKind: 'master' } }), ctx);
    expect(formPatternTool).toHaveBeenCalledOnce();
    expect(argsOf(formPatternTool)).toMatchObject({ domain: 'form', action: 'analyze' });
  });

  it('infers domain=form + action=validate from xml', async () => {
    await objectPatternsTool(req('object_patterns', { xml: '<AxForm/>' }), ctx);
    expect(argsOf(formPatternTool)).toMatchObject({ domain: 'form', action: 'validate' });
  });

  it('infers domain=table from tableGroup when domain omitted', async () => {
    await objectPatternsTool(req('object_patterns', { tableGroup: 'Main' }), ctx);
    expect(getTablePatternsTool).toHaveBeenCalledOnce();
    expect(formPatternTool).not.toHaveBeenCalled();
  });

  it('accepts patternType as an alias for domain', async () => {
    await objectPatternsTool(req('object_patterns', { patternType: 'table', tableGroup: 'Main' }), ctx);
    expect(getTablePatternsTool).toHaveBeenCalledOnce();
    expect(formPatternTool).not.toHaveBeenCalled();
  });

  it('accepts type as an alias for domain', async () => {
    await objectPatternsTool(req('object_patterns', { type: 'form', action: 'analyze' }), ctx);
    expect(formPatternTool).toHaveBeenCalledOnce();
  });

  it('a real form-pattern NAME in patternType → form + action=spec + pattern', async () => {
    await objectPatternsTool(req('object_patterns', { patternType: 'SimpleList' }), ctx);
    expect(formPatternTool).toHaveBeenCalledOnce();
    expect(getTablePatternsTool).not.toHaveBeenCalled();
    expect(argsOf(formPatternTool)).toMatchObject({ domain: 'form', action: 'spec', pattern: 'SimpleList' });
  });

  it('a real form-pattern NAME in objectType (canonicalised) → form spec', async () => {
    await objectPatternsTool(req('object_patterns', { objectType: 'detailsmaster' }), ctx);
    expect(argsOf(formPatternTool)).toMatchObject({ domain: 'form', action: 'spec', pattern: 'DetailsMaster' });
  });

  it('a concept noun (number-sequence) in patternType → friendly error, no handler, redirects to get_knowledge', async () => {
    const r: any = await objectPatternsTool(req('object_patterns', { patternType: 'number-sequence' }), ctx);
    expect(r.isError).toBe(true);
    expect(formPatternTool).not.toHaveBeenCalled();
    expect(getTablePatternsTool).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain('get_knowledge');
  });

  it('unknown/omitted domain with no signals → friendly error', async () => {
    const r: any = await objectPatternsTool(req('object_patterns', {}), ctx);
    expect(r.isError).toBe(true);
  });
});

// ── analyze_code ──────────────────────────────────────────────────────────────
describe('analyze_code dispatcher', () => {
  it('routes api-usage and maps className → apiName', async () => {
    await analyzeCodeTool(req('analyze_code', { mode: 'api-usage', className: 'NumberSeqFormHandler' }), ctx);
    expect(getApiUsagePatternsTool).toHaveBeenCalledOnce();
    expect(argsOf(getApiUsagePatternsTool).apiName).toBe('NumberSeqFormHandler');
  });

  it('does not override an explicit apiName', async () => {
    await analyzeCodeTool(req('analyze_code', { mode: 'api-usage', apiName: 'NumberSeq', className: 'X' }), ctx);
    expect(argsOf(getApiUsagePatternsTool).apiName).toBe('NumberSeq');
  });
});

// ── security_info ─────────────────────────────────────────────────────────────
describe('security_info dispatcher', () => {
  it('mode=artifact → securityArtifactInfo with mode stripped, params passed through', async () => {
    await securityInfoTool(
      req('security_info', { mode: 'artifact', name: 'VendPaymTermsMaintain', artifactType: 'duty', includeChain: true }),
      ctx,
    );
    expect(securityArtifactInfoTool).toHaveBeenCalledOnce();
    expect(securityCoverageInfoTool).not.toHaveBeenCalled();
    const fwd = argsOf(securityArtifactInfoTool);
    expect(fwd).toEqual({ name: 'VendPaymTermsMaintain', artifactType: 'duty', includeChain: true });
    expect(fwd.mode).toBeUndefined();
  });

  it('mode=coverage → securityCoverageInfo with objectName/objectType passed through', async () => {
    await securityInfoTool(
      req('security_info', { mode: 'coverage', objectName: 'VendPaymTerms', objectType: 'form' }),
      ctx,
    );
    expect(securityCoverageInfoTool).toHaveBeenCalledOnce();
    expect(securityArtifactInfoTool).not.toHaveBeenCalled();
    expect(argsOf(securityCoverageInfoTool)).toEqual({ objectName: 'VendPaymTerms', objectType: 'form' });
  });

  it('missing name on artifact → friendly error, no handler call', async () => {
    const r: any = await securityInfoTool(req('security_info', { mode: 'artifact', artifactType: 'role' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/requires `name`/);
    expect(securityArtifactInfoTool).not.toHaveBeenCalled();
  });

  it('missing artifactType on artifact → friendly error', async () => {
    const r: any = await securityInfoTool(req('security_info', { mode: 'artifact', name: 'X' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/requires `artifactType`/);
    expect(securityArtifactInfoTool).not.toHaveBeenCalled();
  });

  it('missing objectName on coverage → friendly error', async () => {
    const r: any = await securityInfoTool(req('security_info', { mode: 'coverage' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/requires `objectName`/);
    expect(securityCoverageInfoTool).not.toHaveBeenCalled();
  });

  it('unknown/missing mode → friendly error listing valid modes', async () => {
    const r: any = await securityInfoTool(req('security_info', { name: 'X', artifactType: 'role' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown mode/);
    expect(r.content[0].text).toMatch(/artifact, coverage/);
    expect(securityArtifactInfoTool).not.toHaveBeenCalled();
  });
});
