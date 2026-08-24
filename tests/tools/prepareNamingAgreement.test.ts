/**
 * prepare and validate_object_naming must not disagree about a name.
 *
 * They did. The naming RULES existed only inside the validate_object_naming tool —
 * the module exported nothing but the MCP wrapper — so prepare could not reuse them
 * and grew two hand-rolled validators instead. Live, on the same input:
 *
 *   prepare(mode="create", objectName="CustTable", objectType="table")
 *     -> "Naming looks valid."
 *   validate_object_naming(proposedName="CustTable", objectType="table")
 *     -> "Proposed name does not start with model prefix"
 *
 * and for an extension:
 *
 *   prepare(mode="change", proposedName="CustTable_Ext")
 *     -> "Confirm naming follows your convention"      (no check at all)
 *   validate_object_naming(… "table-extension", base "CustTable")
 *     -> hard ERROR plus the expected name "CustTable.CRExtension"
 *
 * tests/tools/prefixResolutionAgreement.test.ts pins workspace_info to the validator.
 * This one pins prepare to it, which is the pair that had drifted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { prepareCreateTool } from '../../src/tools/prepare/prepareCreate.js';
import { prepareChangeTool } from '../../src/tools/prepare/prepareChange.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoRobotics';
const PREFIX = 'CR';
/** The model's own objects all carry the short prefix, so it is the effective one. */
const MODEL_OBJECTS = Array.from({ length: 40 }, (_, i) => 'CRObject' + i);

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
    getRawAutoDetectedModelName: () => MODEL,
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
  })),
}));

/** Only CustTable resolves, so an unrelated "not indexed" warning cannot mask a naming one. */
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
    symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null, searchLabels: vi.fn(() => []) } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

const req = (name: string, args: Record<string, unknown>): CallToolRequest =>
  ({ method: 'tools/call', params: { name, arguments: args } });
const textOf = (r: any): string => String(r?.content?.[0]?.text ?? '');

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
  process.env.EXTENSION_PREFIX = PREFIX;
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_NAMING_STYLE;
  delete process.env.EXTENSION_PREFIX_SOURCE;
});
afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
});

describe('prepare(mode="create") runs the shared naming rules', () => {
  it('reports the missing model prefix the validator reports, not "looks valid"', async () => {
    const validator = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTable', objectType: 'table' }), buildContext()));
    expect(validator).toMatch(/does not start with model prefix/i);

    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'CustTable', objectType: 'table' }),
      buildContext()));

    expect(prep).toMatch(/does not start with model prefix/i);
    expect(prep).not.toContain('Naming looks valid.');
  });

  it('applies the underscore rule, which prepare had no equivalent for', async () => {
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'MyThing_Helper', objectType: 'table' }),
      buildContext()));
    expect(prep).toMatch(/underscore/i);
  });

  it('applies the data-entity convention, which prepare had no equivalent for', async () => {
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'CRThing', objectType: 'data-entity' }),
      buildContext()));
    expect(prep).toMatch(/Entity/);
  });

  it('keeps its own final-name guard (#892/#901), which the shared rules do not cover', async () => {
    // The shared rules see the name the caller typed; this one guards the name the
    // prefix step composed.
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'lowerStart', objectType: 'table' }),
      buildContext()));
    expect(prep).toMatch(/uppercase letter/i);
  });
});

describe('prepare(mode="change") validates an extension name for real', () => {
  it('answers a malformed extension name with the same expected form as the validator', async () => {
    const validator = textOf(await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTable_Ext', objectType: 'table-extension', baseObjectName: 'CustTable',
      }), buildContext()));
    expect(validator).toMatch(/dot notation/i);

    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'CustTable_Ext',
      }), buildContext()));

    expect(prep).toMatch(/dot notation/i);
    // The placeholder that used to be the entire verdict must be gone.
    expect(prep).not.toContain('Confirm naming follows your convention');
  });

  it('accepts a correctly formed element extension', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'CustTable.CRExtension',
      }), buildContext()));
    expect(prep).not.toMatch(/dot notation/i);
  });

  it('reads a _Extension name as the CoC class shape, not the element one', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'CustTableCR_Extension',
      }), buildContext()));
    // A class extension is not required to use dot notation.
    expect(prep).not.toMatch(/must use dot notation/i);
  });
});
