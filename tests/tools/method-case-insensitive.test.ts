/**
 * Regression: case-insensitive object-name resolution in get_method (#686).
 *
 * The reported repro is WHSRFControlData — a standard class whose canonical AOT
 * name is upper-case (`WHSRFControlData`) while its file on disk is
 * `WhsrfControlData.xml`, so the misleading filename makes the lower-case
 * spelling a natural guess. Every lookup layer matched by exact name, so the
 * mismatch produced a false "method not found" with no "did you mean" hint.
 *
 * These run against a REAL in-memory index: the fix depends on the FTS fallback
 * inside symbolLookup, which a get()-only fake DB would not exercise (it calls
 * .all()).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { getMethodSignatureTool } from '../../src/tools/methodSignature';
import { getMethodSourceTool } from '../../src/tools/getMethodSource';
import { getMacroInfoTool } from '../../src/tools/macroInfo';
import { validateObjectNamingTool } from '../../src/tools/validateObjectNaming';
import { analyzeExtensionPointsTool } from '../../src/tools/analyzeExtensionPoints';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

let index: XppSymbolIndex;
let context: XppServerContext;

const symbol = (over: Record<string, unknown>) => ({
  name: '',
  type: 'class',
  filePath: '/x.xml',
  model: 'Foundation',
  ...over,
}) as any;

const req = (name: string, args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  index.addSymbol(symbol({ name: 'WHSRFControlData' }));
  index.addSymbol(symbol({
    name: 'processLegacyControl', type: 'method', parentName: 'WHSRFControlData',
    signature: 'public container processLegacyControl(container _con)',
  }));
  index.addSymbol(symbol({ name: 'AOT', type: 'macro' }));
  context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
});

afterAll(() => index.close());

describe('get_method name resolution is case-insensitive (#686)', () => {
  it('signature: resolves a class requested with non-canonical casing', async () => {
    const r: any = await getMethodSignatureTool(
      req('get_method', { className: 'WhsrfControlData', methodName: 'processLegacyControl' }),
      context,
    );
    expect(textOf(r)).toContain('processLegacyControl');
    expect(r.isError).toBeFalsy();
  });

  it('signature: resolves a method requested with non-canonical casing', async () => {
    const r: any = await getMethodSignatureTool(
      req('get_method', { className: 'WHSRFControlData', methodName: 'ProcessLegacyControl' }),
      context,
    );
    expect(r.isError).toBeFalsy();
  });

  it('signature: canonical casing keeps working', async () => {
    const r: any = await getMethodSignatureTool(
      req('get_method', { className: 'WHSRFControlData', methodName: 'processLegacyControl' }),
      context,
    );
    expect(r.isError).toBeFalsy();
  });

  it('a genuinely unknown class still reports not found', async () => {
    const r: any = await getMethodSignatureTool(
      req('get_method', { className: 'NoSuchClassAnywhere', methodName: 'foo' }),
      context,
    );
    expect(r.isError).toBe(true);
  });

  it('source: mis-cased class still emits the "did you mean" hint', async () => {
    // The hint query is parent-scoped; before the fix a case-sensitive
    // parent_name gate returned 0 candidates and the hint was silently dropped.
    const r: any = await getMethodSourceTool(
      req('get_method', { className: 'WhsrfControlData', methodName: 'processLegacy' }),
      context,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Similar methods');
    expect(textOf(r)).toContain('processLegacyControl');
  });
});

describe('other object-name lookups are case-insensitive (#686)', () => {
  it('get_macro_info resolves a mis-cased macro library', async () => {
    const r: any = await getMacroInfoTool(req('get_macro_info', { macroName: 'aot' }), context);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('AOT');
  });

  it('analyze_extension_points resolves a mis-cased class', async () => {
    const r: any = await analyzeExtensionPointsTool(
      req('analyze_extension_points', { objectName: 'whsrfcontroldata', objectType: 'class' }),
      context,
    );
    // Reports the canonical name, not the caller's casing.
    expect(textOf(r)).toContain('WHSRFControlData');
  });

  it('validate_object_naming flags a conflict differing only in casing', async () => {
    // AOT names are case-insensitive, so this IS a real conflict — before the
    // fix the case-sensitive probe reported "no existing objects".
    const r: any = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'WhsrfControlData', objectType: 'class' }),
      context,
    );
    expect(textOf(r)).toContain('already exists');
    expect(textOf(r)).toContain('WHSRFControlData');
  });
});
