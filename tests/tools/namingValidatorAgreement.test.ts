/**
 * validate_object_naming and get_workspace_info must not describe a name the write
 * path would never write (#901).
 *
 * #892/PR #894 moved the WRITE path onto normalizeModelToken, so a model called
 * "Contoso Robotics" produces `CustTable.ContosoRobotics` — an AOT element name is an
 * identifier and cannot hold the space. Four sites that DESCRIBE the expected name kept
 * interpolating the raw model name, and two of them are validation rules: the validator
 * flagged the exact name create had just written and recommended "Contoso Robotics" back.
 * An agent that trusted it either renamed a correct object into an unbuildable one, or
 * reported a correct name as a violation.
 *
 * These tests run the REAL modelClassifier (only configManager is mocked), so the name
 * fed to the validator is literally applyObjectPrefix's output — the pin that ties the
 * two paths together.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { getWorkspaceInfoTool } from '../../src/tools/readers/getWorkspaceInfo.js';
import { applyObjectPrefix } from '../../src/utils/modelClassifier.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';

/** A model name Visual Studio creates without a second thought — and not an identifier. */
const MODEL = 'Contoso Robotics';
const TOKEN = 'ContosoRobotics';
const PREFIX = 'CR';

/** The model's own objects, all on the short prefix — the shape #892 reported. */
const MODEL_OBJECTS = Array.from({ length: 40 }, (_, i) => `CRObject${i}`);

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
    getRawAutoDetectedModelName: () => MODEL,
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
    getDevEnvironmentType: async () => 'local',
    getMicrosoftPackagesPath: async () => null,
    getWorkspaceInfoDiagnostics: async () => ({
      modelName: MODEL,
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

/**
 * `CustTable` is the only symbol in this index — enough for the base-object probe to
 * succeed, so a clean response really is clean and an unrelated "not found in symbol
 * index" warning cannot mask a naming one. Nothing else resolves, so the conflict check
 * over the proposed name stays empty.
 */
const buildContext = (): XppServerContext => {
  const hit = (params: unknown[]) =>
    params.some(p => typeof p === 'string' && p.replace(/"/g, '') === 'CustTable')
      ? { name: 'CustTable', type: 'table', model: 'Application', extends_class: null, file_path: null }
      : undefined;
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
  const result = await validateObjectNamingTool(
    req('validate_object_naming', { modelName: MODEL, modelPrefix: PREFIX, ...args }),
    buildContext(),
  );
  return String(result.content[0].text);
};

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
  process.env.EXTENSION_PREFIX = PREFIX;
  process.env.EXTENSION_NAMING_STYLE = 'model-name';
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_PREFIX_SOURCE;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('validate_object_naming accepts what the write path produces (spaced model name)', () => {
  it('the element-extension name applyObjectPrefix builds passes clean', async () => {
    const written = applyObjectPrefix('CustTable.Extension', PREFIX, MODEL);
    expect(written).toBe(`CustTable.${TOKEN}`);

    const out = await validate({
      proposedName: written,
      objectType: 'table-extension',
      baseObjectName: 'CustTable',
    });
    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).not.toMatch(/WARNINGS \(\d/);
  });

  it('the class-extension name applyObjectPrefix builds passes clean', async () => {
    const written = applyObjectPrefix('CustTable_Extension', PREFIX, MODEL);
    expect(written).toBe(`CustTable_${TOKEN}_Extension`);

    const out = await validate({
      proposedName: written,
      objectType: 'class-extension',
      baseObjectName: 'CustTable',
    });
    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).not.toMatch(/WARNINGS \(\d/);
  });

  it('never recommends a name carrying the space', async () => {
    // Both the correct name and a wrong one — the recommendation has to be buildable
    // either way. `CustTable.Contoso Robotics` is what the validator used to print.
    for (const [proposedName, objectType] of [
      [`CustTable.${TOKEN}`, 'table-extension'],
      ['CustTable.CRExtension', 'table-extension'],
      [`CustTable_${TOKEN}_Extension`, 'class-extension'],
      ['CustTableCR_Extension', 'class-extension'],
    ] as const) {
      const out = await validate({ proposedName, objectType, baseObjectName: 'CustTable' });
      expect(out, `for ${proposedName}`).not.toMatch(/CustTable[._]Contoso Robotics/);
      expect(out, `for ${proposedName}`).not.toMatch(/Recommended: Contoso Robotics$/m);
    }
  });

  it('still warns on a genuinely wrong token, and recommends the buildable one', async () => {
    const out = await validate({
      proposedName: 'CustTable.CRExtension',
      objectType: 'table-extension',
      baseObjectName: 'CustTable',
    });
    // The prose names both halves: the token that belongs in the name, and the model
    // it came from — "should be the model name X … Recommended: Y" reads as a bug.
    expect(out).toMatch(/should be the model-name token "ContosoRobotics" \(from model "Contoso Robotics"\)/);
    expect(out).toMatch(/Recommended: ContosoRobotics/);
  });

  it('names both halves in the Extension Style header', async () => {
    const out = await validate({
      proposedName: `CustTable.${TOKEN}`,
      objectType: 'table-extension',
      baseObjectName: 'CustTable',
    });
    expect(out).toMatch(
      /Extension Style: model-name \(token = model-name token "ContosoRobotics" \(from model "Contoso Robotics"\)\)/,
    );
  });
});

describe('get_workspace_info samples are names a write would produce', () => {
  it('neither extension sample carries the space', async () => {
    const result = await getWorkspaceInfoTool(req('get_workspace_info', {}), buildContext());
    const out = String(result.content[0].text);

    expect(out).toMatch(/CustTable_ContosoRobotics_Extension/);
    expect(out).toMatch(/CustTable\.ContosoRobotics/);
    expect(out).not.toMatch(/CustTable[._]Contoso Robotics/);
  });
});
