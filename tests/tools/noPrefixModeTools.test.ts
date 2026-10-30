/**
 * naming.prefixSource=none, seen from the tools that report or check the prefix
 * (issue #1085): validate_object_naming must not ask for a prefix nor guess one
 * off the index, a configured suffix's own underscore is not a stray one, and
 * doctor / get_workspace_info state the choice instead of nagging about it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { buildPrefixDiagnostics } from '../../src/tools/analysis/prefixDiagnostics.js';
import { checkPrefixResolution } from '../../src/cli/commands/doctor.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ABC';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
    getRawAutoDetectedModelName: () => MODEL,
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
    // What get_workspace_info reads besides the above.
    ensureLoaded: async () => {},
    getAmbiguousProjectPaths: () => [],
    getDevEnvironmentType: async () => 'local',
    getMicrosoftPackagesPath: async () => null,
    getCustomPackagesPath: async () => null,
    getPackagePath: () => null,
    forceProject: async () => null,
    getWorkspaceInfoDiagnostics: async () => ({
      modelName: MODEL, modelSource: 'test', isModelSourceAutoDetected: false,
      projectPath: null, projectSource: 'not selected', ambiguousProjects: [],
      packagePath: null, packageSource: 'test', customPackagesPath: null, customPackagesSource: 'test',
    }),
  })),
}));

/** Every name lookup answers with objects, as a populated index would. */
const buildContext = (): XppServerContext => {
  const hit = (params: unknown[]) =>
    params.some(p => typeof p === 'string' && p.replace(/"/g, '').toLowerCase() === 'custtable')
      ? { name: 'CustTable', type: 'table', model: 'ApplicationSuite', extends_class: null, file_path: null }
      : undefined;
  const stmt = {
    all: vi.fn((...params: unknown[]) =>
      hit(params) ? [hit(params)] : Array.from({ length: 5 }, (_, i) => ({ name: `XYZThing${i}`, type: 'class', model: MODEL }))),
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

const validate = async (args: Record<string, unknown>): Promise<string> => {
  const req: CallToolRequest = {
    method: 'tools/call',
    params: { name: 'validate_object_naming', arguments: { modelName: MODEL, ...args } },
  };
  const result = await validateObjectNamingTool(req, buildContext());
  return String(result.content[0].text);
};

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(m => (m === MODEL ? Array.from({ length: 30 }, (_, i) => `ABCThing${i}`) : []));
  for (const k of ['EXTENSION_PREFIX', 'EXTENSION_SUFFIX', 'EXTENSION_NAMING_STYLE', 'EXTENSION_CLASS_NAMING_STYLE']) {
    delete process.env[k];
  }
  process.env.EXTENSION_PREFIX_SOURCE = 'none';
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('validate_object_naming under naming.prefixSource=none', () => {
  it('passes an unprefixed new object without asking for a prefix', async () => {
    const out = await validate({ proposedName: 'CustomerSettings', objectType: 'table' });
    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).not.toMatch(/does not start with model prefix/i);
    expect(out).not.toMatch(/Prefixed name/);
  });

  it('passes the suffix convention CustomerSettings_ABC — the underscore is the suffix\'s', async () => {
    process.env.EXTENSION_SUFFIX = '_ABC';
    const out = await validate({ proposedName: 'CustomerSettings_ABC', objectType: 'table' });
    expect(out).not.toMatch(/must not contain underscores/);
    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).not.toMatch(/does not end with it/);
  });

  it('still refuses a stray underscore that is not the suffix', async () => {
    process.env.EXTENSION_SUFFIX = '_ABC';
    const out = await validate({ proposedName: 'Customer_Settings_ABC', objectType: 'table' });
    expect(out).toMatch(/must not contain underscores/);
  });

  it('accepts the model-name extension names the writer produces', async () => {
    for (const [proposedName, objectType] of [
      ['CustTable.ABC', 'table-extension'],
      ['CustTable_ABC_Extension', 'class-extension'],
    ] as const) {
      const out = await validate({ proposedName, objectType, baseObjectName: 'CustTable' });
      expect(out, proposedName).not.toMatch(/ERRORS \(\d/);
      expect(out, proposedName).not.toMatch(/will not use this name as given/);
    }
  });
});

describe('reporting the choice', () => {
  it('get_workspace_info states "none" and does not nag about EXTENSION_PREFIX', () => {
    const { lines, verboseLines } = buildPrefixDiagnostics(MODEL, MODEL);
    expect(lines.join('\n')).toMatch(/Prefix\s+: \(none\)\s+\(none/);
    expect(lines.join('\n')).not.toMatch(/EXTENSION_PREFIX is not set/);
    expect(verboseLines.join('\n')).toMatch(/naming\.prefixSource=none/);
  });

  it('doctor reports it as OK, and offers it where it used to only say "set a prefix"', () => {
    const none = checkPrefixResolution('', MODEL, [], 'Naming', false, true);
    expect(none).toHaveLength(1);
    expect(none[0].severity).toBe('ok');
    expect(none[0].message).toMatch(/no prefix \(naming\.prefixSource=none\)/);

    const unset = checkPrefixResolution('', MODEL, [], 'Naming');
    expect(unset[0].severity).toBe('warn');
    expect(unset[0].fix).toMatch(/naming\.prefixSource=none/);
  });
});

describe('review follow-ups', () => {
  it('reads role suffixes before a configured suffix (CustomerExportEntity_ABC is an entity name)', async () => {
    process.env.EXTENSION_SUFFIX = '_ABC';
    const entity = await validate({ proposedName: 'CustomerExportEntity_ABC', objectType: 'data-entity' });
    expect(entity).not.toMatch(/typically end with 'Entity'/);
    const privilege = await validate({ proposedName: 'CustomerSettingsView_ABC', objectType: 'security-privilege' });
    expect(privilege).not.toMatch(/privileges typically end with/);
  });

  it('the cross-model refusal names the model-name extension instead of "<Prefix>Extension"', async () => {
    const { suggestedExtensionName } = await import('../../src/utils/crossModelWriteGuard.js');
    expect(suggestedExtensionName('CustTable', 'table', MODEL)).toBe('CustTable.ABC');
    expect(suggestedExtensionName('SalesFormLetter', 'class', MODEL)).toBe('SalesFormLetter_ABC_Extension');
  });

  it('modify finds the base of a Base_Model_Extension class to auto-create it', async () => {
    const { baseObjectNameCandidates } = await import('../../src/tools/write/modifyD365File.js');
    expect(baseObjectNameCandidates('SalesFormLetter_ABC_Extension', MODEL)).toContain('SalesFormLetter');
  });

  it('doctor warns when naming.prefix is set but ignored by none', () => {
    const r = checkPrefixResolution('XY', MODEL, [], 'Naming', false, true);
    expect(r[0].severity).toBe('warn');
    expect(r[0].message).toMatch(/ignores naming\.prefix "XY"/);
  });
});

/**
 * get_workspace_info(diagnostics=true) reported the configured class style under
 * none, which forces model-name — EXTENSION_CLASS_NAMING_STYLE: prefix-leading, above
 * samples in the model-name shape — called a misspelled style "treated as prefix"
 * when none ignores it, and still said any embedded infix is normalised, which
 * {Base}{Token}{Feature}_Extension names no longer are (#1103).
 */
describe('get_workspace_info naming report under none', () => {
  const report = async (): Promise<string> => {
    const { getWorkspaceInfoTool } = await import('../../src/tools/readers/getWorkspaceInfo.js');
    const r = await getWorkspaceInfoTool(
      { method: 'tools/call', params: { name: 'get_workspace_info', arguments: { diagnostics: true } } } as any,
      buildContext(),
    );
    return String(r.content[0].text);
  };

  it('states the class style none forces, not the configured one', async () => {
    process.env.EXTENSION_CLASS_NAMING_STYLE = 'prefix-leading';
    const text = await report();
    expect(text).toContain('EXTENSION_CLASS_NAMING_STYLE: model-name (forced by naming.prefixSource=none)');
    expect(text).toContain('Extension class  → CustTable_ABC_Extension');
  });

  it('does not call a style setting it ignores "treated as prefix"', async () => {
    process.env.EXTENSION_NAMING_STYLE = 'prefx';
    expect(await report()).not.toMatch(/treated as "prefix"/);
  });

  it('no longer says every embedded token is normalised', async () => {
    const text = await report();
    expect(text).not.toContain('any infix you embed will be normalised');
    expect(text).toContain('CustTableABCCredit_Extension) is kept');
  });
});

/**
 * naming.prefixSource=as-given (#1134): the tools that check or report naming
 * must not hold a name to a token the server no longer applies. Only what makes a
 * name a valid AOT name is checked; the convention is the instruction file's.
 */
describe('naming.prefixSource=as-given', () => {
  beforeEach(() => {
    process.env.EXTENSION_PREFIX_SOURCE = 'as-given';
  });

  it('validate_object_naming accepts an extension token that is not the model name', async () => {
    for (const [proposedName, objectType] of [
      ['VendTable.XY', 'table-extension'],
      ['VendTableTable_XY_Extension', 'class-extension'],
      ['VendSettingsXY', 'table'],
    ] as const) {
      const out = await validate({ proposedName, objectType });
      expect(out, proposedName).not.toMatch(/ERRORS \(\d/);
      expect(out, proposedName).toMatch(/Naming: as given/);
      expect(out, proposedName).not.toMatch(/Model prefix|model name "ABC"|Extension Style/);
    }
  });

  it('validate_object_naming refuses only structurally invalid names', async () => {
    expect(await validate({ proposedName: 'VendTable', objectType: 'table-extension' }))
      .toMatch(/<Base>\.<Token>/);
    expect(await validate({ proposedName: 'VendTableTable_XY', objectType: 'class-extension' }))
      .toMatch(/must end with `_Extension`/);
  });

  it('get_workspace_info and doctor say nothing is renamed', () => {
    const { lines, verboseLines } = buildPrefixDiagnostics(MODEL, MODEL);
    expect(lines.join('\n')).toMatch(/naming\.prefixSource=as-given/);
    expect(verboseLines.join('\n')).toMatch(/renames nothing/);

    const doctor = checkPrefixResolution('XY', MODEL, [], 'Naming', false, true, true);
    expect(doctor).toHaveLength(1);
    expect(doctor[0].severity).toBe('ok');
    expect(doctor[0].message).toMatch(/names as given .*naming\.prefix "XY" is not applied/);
  });

  it('the cross-model refusal shows the shape, not a name built from the model', async () => {
    const { suggestedExtensionName } = await import('../../src/utils/crossModelWriteGuard.js');
    expect(suggestedExtensionName('CustTable', 'table', MODEL)).toBe('CustTable.<YourToken>');
    expect(suggestedExtensionName('SalesFormLetter', 'class', MODEL)).toBe('SalesFormLetter_<YourToken>_Extension');
  });
});
