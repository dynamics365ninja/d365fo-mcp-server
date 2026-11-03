/**
 * The extension name formats as the tools apply them: validate_object_naming
 * (accept / reject), generate_object's CoC patterns (named per base type, or the
 * ask-back) and get_workspace_info (reports the formats and their samples).
 *
 * The real modelClassifier, objectNaming and rules run; only configManager is mocked.
 * The convention is the neutral CTSO example: {0}.CTSO, CTSO_{0}Cls / Dbt / Frm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { getWorkspaceInfoTool } from '../../src/tools/readers/getWorkspaceInfo.js';
import { codeGenTool } from '../../src/tools/smart/codeGen.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoExt';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => 'ContosoExt',
    getWriteAnchorModel: () => 'ContosoExt',
    getAutoDetectedModelName: async () => 'ContosoExt',
    getRawAutoDetectedModelName: () => 'ContosoExt',
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
    getDevEnvironmentType: async () => 'local',
    getMicrosoftPackagesPath: async () => null,
    getWorkspaceInfoDiagnostics: async () => ({
      modelName: 'ContosoExt',
      modelSource: 'test',
      isModelSourceAutoDetected: false,
      projectPath: null,
      projectSource: 'test',
      ambiguousProjects: [],
      packagePath: null,
      packageSource: 'test',
      customPackagesPath: null,
      customPackagesSource: 'test',
    }),
  })),
}));

/** An index that knows the three bases used below, so the base probe stays quiet. */
const buildContext = (): XppServerContext => {
  const known: Record<string, string> = { InventTable: 'table', SalesFormLetter: 'class', CustTable: 'table' };
  const hit = (params: unknown[]) => {
    const n = params.find(p => typeof p === 'string' && known[p.replace(/"/g, '')]) as string | undefined;
    return n ? { name: n.replace(/"/g, ''), type: known[n.replace(/"/g, '')], model: 'Application' } : undefined;
  };
  const stmt = {
    all: vi.fn((...params: unknown[]) => (hit(params) ? [hit(params)] : [])),
    get: vi.fn((...params: unknown[]) => hit(params)),
    run: vi.fn(),
  };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

const req = (name: string, args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const validate = async (args: Record<string, unknown>): Promise<string> => {
  const result = await validateObjectNamingTool(req('validate_object_naming', { modelName: MODEL, ...args }), buildContext());
  return String(result.content[0].text);
};

const generate = async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
  const result: any = await codeGenTool(req('generate_object', { modelName: MODEL, ...args }));
  return { text: result.content.map((c: any) => c.text).join('\n'), isError: !!result.isError };
};

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(() => []);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('EXTENSION_') || k === 'GROUNDING_ENFORCE') delete process.env[k];
  }
  process.env.EXTENSION_PREFIX = 'Ctso';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  process.env.EXTENSION_ELEMENT_NAME_FORMAT = '{0}.CTSO';
  process.env.EXTENSION_CLASS_NAME_FORMAT = 'CTSO_{0}Cls';
  process.env.EXTENSION_CLASS_NAME_FORMAT_TABLE = 'CTSO_{0}Dbt';
  process.env.EXTENSION_CLASS_NAME_FORMAT_FORM = 'CTSO_{0}Frm';
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

const errorsOf = (out: string) => /ERRORS \((\d+)\)/.exec(out)?.[1] ?? '0';

describe('validate_object_naming under a format', () => {
  it('accepts the element name the format produces, for any element type', async () => {
    for (const objectType of ['table-extension', 'form-extension', 'enum-extension', 'edt-extension']) {
      const out = await validate({ proposedName: 'InventTable.CTSO', objectType });
      expect(errorsOf(out), `${objectType}: ${out}`).toBe('0');
      expect(out).toContain('Naming: format — EXTENSION_ELEMENT_NAME_FORMAT="{0}.CTSO"');
    }
  });

  it('rejects any other element name, naming the expected one', async () => {
    for (const proposedName of ['InventTable.CtsoExtension', 'InventTable.ctso', 'InventTable.ContosoExt']) {
      const out = await validate({ proposedName, objectType: 'table-extension' });
      expect(errorsOf(out), proposedName).toBe('1');
      expect(out).toContain('Expected: InventTable.CTSO');
    }
  });

  it('a class extension is held to the format of its stated type', async () => {
    const ok = await validate({ proposedName: 'CTSO_InventTableDbt_Extension', objectType: 'class-extension', baseObjectType: 'table' });
    expect(errorsOf(ok), ok).toBe('0');
    expect(ok).toContain('EXTENSION_CLASS_NAME_FORMAT_TABLE="CTSO_{0}Dbt" + _Extension (table)');

    const wrongToken = await validate({ proposedName: 'CTSO_InventTableCls_Extension', objectType: 'class-extension', baseObjectType: 'table' });
    expect(errorsOf(wrongToken)).toBe('1');
    expect(wrongToken).toContain('Expected: CTSO_InventTableDbt_Extension');

    const styleName = await validate({
      proposedName: 'InventTableCtso_Extension', objectType: 'class-extension', baseObjectType: 'form', baseObjectName: 'InventTable',
    });
    expect(styleName).toContain('Expected: CTSO_InventTableFrm_Extension');

    const cls = await validate({ proposedName: 'CTSO_SalesFormLetterCls_Extension', objectType: 'class-extension', baseObjectType: 'class' });
    expect(errorsOf(cls), cls).toBe('0');
  });

  it('exact means exact: the fixed text keeps its case, the base compares case-insensitively', async () => {
    const lower = await validate({ proposedName: 'ctso_InventTableDbt_Extension', objectType: 'class-extension', baseObjectType: 'table' });
    expect(errorsOf(lower)).toBe('1');
    const base = await validate({
      proposedName: 'CTSO_inventTableDbt_Extension', objectType: 'class-extension', baseObjectType: 'table', baseObjectName: 'InventTable',
    });
    expect(errorsOf(base), base).toBe('0');
  });

  it('an undefined case accepts any valid class name, under either UNDEFINED value', async () => {
    for (const mode of ['ask', 'class-format']) {
      process.env.EXTENSION_NAME_FORMAT_UNDEFINED = mode;
      const out = await validate({ proposedName: 'Whatever_CustTableDS_Extension', objectType: 'class-extension', baseObjectType: 'formdatasource' });
      expect(errorsOf(out), `${mode}: ${out}`).toBe('0');
      expect(out).toContain('no format for form-datasource extension classes');
    }
  });

  it('an undefined case still rejects what the compiler rejects', async () => {
    const noSuffix = await validate({ proposedName: 'CustTableDsHandler', objectType: 'class-extension', baseObjectType: 'view' });
    expect(noSuffix).toMatch(/must end with `_Extension`/);
    const badChars = await validate({ proposedName: 'Cust-Table_Extension', objectType: 'class-extension', baseObjectType: 'view' });
    expect(badChars).toMatch(/not a valid AOT name/);
    const tooLong = await validate({ proposedName: `${'A'.repeat(80)}_Extension`, objectType: 'class-extension', baseObjectType: 'view' });
    expect(tooLong).toMatch(/exceeds the D365FO AOT maximum/);
  });

  it('without a base type: a formatted name passes, any other is warned about', async () => {
    const formatted = await validate({ proposedName: 'CTSO_InventTableFrm_Extension', objectType: 'class-extension' });
    expect(errorsOf(formatted), formatted).toBe('0');
    expect(formatted).toContain('read from the name; pass baseObjectType');
    const other = await validate({ proposedName: 'InventTableCtso_Extension', objectType: 'class-extension' });
    expect(errorsOf(other)).toBe('0');
    expect(other).toContain('matches no configured extension class name format. Pass baseObjectType');
  });

  it('no format set: the style rules answer as before', async () => {
    for (const k of Object.keys(process.env)) if (k.includes('NAME_FORMAT')) delete process.env[k];
    const out = await validate({ proposedName: 'InventTable.CtsoExtension', objectType: 'table-extension' });
    expect(out).toContain('Extension Style: prefix (token = "Ctso")');
    expect(errorsOf(out)).toBe('0');
    expect(out).not.toContain('Naming: format');
  });
});

describe('generate_object CoC patterns under a format', () => {
  const declared = (text: string) => /final class (\w+)/.exec(text)?.[1];

  it.each([
    ['class-extension', 'SalesFormLetter', 'CTSO_SalesFormLetterCls_Extension', 'EXTENSION_CLASS_NAME_FORMAT'],
    ['table-extension', 'InventTable', 'CTSO_InventTableDbt_Extension', 'EXTENSION_CLASS_NAME_FORMAT_TABLE'],
    ['form-handler', 'InventTable', 'CTSO_InventTableFrm_Extension', 'EXTENSION_CLASS_NAME_FORMAT_FORM'],
  ])('%s %s → %s', async (pattern, name, expected, setting) => {
    const { text, isError } = await generate({ mode: 'pattern', pattern, name });
    expect(isError, text).toBe(false);
    expect(declared(text)).toBe(expected);
    expect(text).toContain(`Format: ${setting}`);
  });

  it.each(['form-datasource-extension', 'form-control-extension', 'map-extension'])(
    '%s asks for the name (UNDEFINED=ask)', async pattern => {
      const { text, isError } = await generate({ mode: 'pattern', pattern, name: 'CustTable', baseName: 'CustTable' });
      expect(isError).toBe(true);
      expect(text).toContain('no naming convention for an extension class of a');
      expect(text).toContain('ask the user for the name and call again with an explicit `name`');
      expect(text).toContain('params.className');
    },
  );

  it('the second call with the user\'s className generates it', async () => {
    const { text, isError } = await generate({
      mode: 'pattern', pattern: 'form-datasource-extension', name: 'CustTable', baseName: 'CustTable',
      className: 'CTSO_CustTable_CustTableDSCls_Extension',
    });
    expect(isError, text).toBe(false);
    expect(declared(text)).toBe('CTSO_CustTable_CustTableDSCls_Extension');
  });

  it('UNDEFINED=class-format names the undefined case by the class format', async () => {
    process.env.EXTENSION_NAME_FORMAT_UNDEFINED = 'class-format';
    const { text, isError } = await generate({ mode: 'pattern', pattern: 'map-extension', name: 'InventItemOrdered' });
    expect(isError, text).toBe(false);
    expect(declared(text)).toBe('CTSO_InventItemOrderedCls_Extension');
  });
});

describe('get_workspace_info reports the active formats', () => {
  it('lists each format, the UNDEFINED rule, and format-made samples', async () => {
    const result = await getWorkspaceInfoTool(req('get_workspace_info', {}), buildContext());
    const out = String(result.content[0].text);
    expect(out).toContain('EXTENSION_ELEMENT_NAME_FORMAT="{0}.CTSO"');
    expect(out).toContain('EXTENSION_CLASS_NAME_FORMAT="CTSO_{0}Cls"');
    expect(out).toContain('EXTENSION_CLASS_NAME_FORMAT_TABLE="CTSO_{0}Dbt"');
    expect(out).toContain('EXTENSION_CLASS_NAME_FORMAT_FORM="CTSO_{0}Frm"');
    expect(out).toContain('EXTENSION_NAME_FORMAT_UNDEFINED=ask');
    expect(out).toContain('CTSO_SalesFormLetterCls_Extension (class) · CTSO_CustTableDbt_Extension (table) · CTSO_CustTableFrm_Extension (form)');
    expect(out).toContain('CustTable.CTSO');
    expect(out).toContain('state the TYPE of the extended object');
  });

  it('reports a format it cannot use', async () => {
    process.env.EXTENSION_CLASS_NAME_FORMAT_TABLE = 'CTSO_Dbt';
    const result = await getWorkspaceInfoTool(req('get_workspace_info', {}), buildContext());
    expect(String(result.content[0].text)).toContain('EXTENSION_CLASS_NAME_FORMAT_TABLE="CTSO_Dbt" must contain {0}');
  });

  it('no format set: no format lines, the style samples as before', async () => {
    for (const k of Object.keys(process.env)) if (k.includes('NAME_FORMAT')) delete process.env[k];
    const result = await getWorkspaceInfoTool(req('get_workspace_info', {}), buildContext());
    const out = String(result.content[0].text);
    expect(out).not.toContain('NAME_FORMAT');
    expect(out).toContain('CustTableCtso_Extension');
    expect(out).toContain('CustTable.CtsoExtension');
  });
});

describe('prepare(mode="create") predicts what create writes, or the ask-back', () => {
  const prepareCreate = async (objectName: string, objectType: string): Promise<string> => {
    const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
    const result = await prepareCreateTool({ params: { arguments: { goal: 'test', objectName, objectType } } }, buildContext());
    return String(result.content[0].text);
  };

  it('an element extension is predicted under the element format', async () => {
    expect(await prepareCreate('InventTable', 'table-extension')).toMatch(/Final name\s*: InventTable\.CTSO/);
  });

  it('a formatted class name is kept', async () => {
    expect(await prepareCreate('CTSO_InventTableDbt_Extension', 'class-extension'))
      .toMatch(/Final name\s*: CTSO_InventTableDbt_Extension/);
  });

  it('a bare class-extension base (no type in a prepare call) carries the ask-back', async () => {
    expect(await prepareCreate('InventTable', 'class-extension')).toContain('no naming convention for an extension class whose base type was not given');
  });
});

describe('the cross-model refusal suggests the formatted extension name', () => {
  it('names element and class extensions by the format', async () => {
    const { suggestedExtensionName } = await import('../../src/utils/crossModelWriteGuard.js');
    expect(suggestedExtensionName('InventTable', 'table', MODEL)).toBe('InventTable.CTSO');
    expect(suggestedExtensionName('SalesFormLetter', 'class', MODEL)).toBe('CTSO_SalesFormLetterCls_Extension');
    for (const k of Object.keys(process.env)) if (k.includes('NAME_FORMAT')) delete process.env[k];
    expect(suggestedExtensionName('InventTable', 'table', MODEL)).toBe('InventTable.CtsoExtension');
    expect(suggestedExtensionName('SalesFormLetter', 'class', MODEL)).toBe('SalesFormLetterCtso_Extension');
  });
});
