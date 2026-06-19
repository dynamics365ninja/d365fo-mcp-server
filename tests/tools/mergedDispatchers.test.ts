/**
 * Merged dispatcher tests — verify the consolidated tools route to the correct
 * underlying handler and remap their discriminator/params correctly.
 *
 * Covers: extension_info, validate_code, generate_object, object_patterns.
 * The underlying handlers are mocked so these tests assert ONLY the dispatcher's
 * own routing + argument-remapping logic (the handlers have their own tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ── Mock every underlying handler so we can capture the forwarded args ────────
// Factories are hoisted above imports — keep them self-contained (no outer vars).
vi.mock('../../src/tools/findCocExtensions', () => ({ findCocExtensionsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'coc' }] })) }));
vi.mock('../../src/tools/findEventHandlers', () => ({ findEventHandlersTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'events' }] })) }));
vi.mock('../../src/tools/tableExtensionInfo', () => ({ tableExtensionInfoTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'table-merge' }] })) }));
vi.mock('../../src/tools/analyzeExtensionPoints', () => ({ analyzeExtensionPointsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'points' }] })) }));
vi.mock('../../src/tools/extensionStrategyAdvisor', () => ({ extensionStrategyAdvisorTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'strategy' }] })) }));
vi.mock('../../src/tools/validateXpp', () => ({ validateXppTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'syntax' }] })) }));
vi.mock('../../src/tools/resolveReferences', () => ({ resolveReferencesTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'references' }] })) }));
vi.mock('../../src/tools/codeGen', () => ({ codeGenTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'pattern' }] })) }));
vi.mock('../../src/tools/generateSmart', () => ({ generateSmartTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'scaffold' }] })) }));
vi.mock('../../src/tools/getTablePatterns', () => ({ getTablePatternsTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'table' }] })) }));
vi.mock('../../src/tools/formPattern', () => ({ formPatternTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'form' }] })) }));

import { extensionInfoTool } from '../../src/tools/extensionInfo';
import { validateCodeTool } from '../../src/tools/validateCode';
import { generateObjectTool } from '../../src/tools/generateObject';
import { objectPatternsTool } from '../../src/tools/objectPatterns';
import { findCocExtensionsTool } from '../../src/tools/findCocExtensions';
import { findEventHandlersTool } from '../../src/tools/findEventHandlers';
import { tableExtensionInfoTool } from '../../src/tools/tableExtensionInfo';
import { analyzeExtensionPointsTool } from '../../src/tools/analyzeExtensionPoints';
import { extensionStrategyAdvisorTool } from '../../src/tools/extensionStrategyAdvisor';
import { validateXppTool } from '../../src/tools/validateXpp';
import { resolveReferencesTool } from '../../src/tools/resolveReferences';
import { codeGenTool } from '../../src/tools/codeGen';
import { generateSmartTool } from '../../src/tools/generateSmart';
import { getTablePatternsTool } from '../../src/tools/getTablePatterns';
import { formPatternTool } from '../../src/tools/formPattern';

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

  it('unknown/omitted domain with no signals → friendly error', async () => {
    const r: any = await objectPatternsTool(req('object_patterns', {}), ctx);
    expect(r.isError).toBe(true);
  });
});
