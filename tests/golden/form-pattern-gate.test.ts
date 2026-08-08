/**
 * Golden gate suite: form-pattern enforcement in the write path.
 *
 * Locks the chain: FormPatternTemplates → validateFormPatternXml →
 * gateOnFormPatternErrors → handleCreateD365File(objectType='form').
 *
 * - Pattern-correct form XML writes to disk.
 * - Structurally violating XML (missing Grid, wrong order, unknown pattern)
 *   is rejected BEFORE fs.writeFile, with the specific FP rule named.
 * - With FORM_PATTERN_ENFORCE=false the write proceeds and errors downgrade
 *   to warnings in the success message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/createD365File';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (p: string) => {
    if (/^[A-Za-z]:[\\\/]?$/.test(p) || p === '/') return;
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1024 })),
  readdir: vi.fn(async () => []),
  // The direct-XML writes go through writeFileAtomic: a temp sibling written with
  // writeFile, then renamed over the target (rm cleans the temp up on failure).
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'ContosoExt'),
    // Writes are measured against the anchor, not the active model (see getWriteAnchorModel).
    getWriteAnchorModel: vi.fn(() => 'ContosoExt'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'ContosoExt'),
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
  PackageResolver: vi.fn().mockImplementation(function () {
    return {
      resolve: vi.fn(async (modelName: string) => ({
        packageName: modelName,
        modelName,
        rootPath: 'K:\\PackagesLocalDirectory',
      })),
      resolveWithPackage: vi.fn((m: string, p: string) => ({
        packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
      })),
    };
  }),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  getExtensionNamingStyle: vi.fn(() => 'prefix'),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

import * as fsMock from 'fs/promises';

const ORIGINAL_ENFORCE = process.env.FORM_PATTERN_ENFORCE;

beforeEach(() => {
  vi.mocked(fsMock.writeFile).mockClear();
});

afterEach(() => {
  if (ORIGINAL_ENFORCE === undefined) delete process.env.FORM_PATTERN_ENFORCE;
  else process.env.FORM_PATTERN_ENFORCE = ORIGINAL_ENFORCE;
});

const createReq = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

const validXml = () =>
  FormPatternTemplates.buildSimpleList({
    formName: 'GateTestForm',
    dsName: 'CustGroup',
    dsTable: 'CustGroup',
    caption: 'Gate Test',
    gridFields: ['CustGroup', 'Name'],
  });

describe('form pattern gate in create_d365fo_file', () => {
  it('writes a pattern-correct form', async () => {
    process.env.FORM_PATTERN_ENFORCE = 'true';
    const result = await handleCreateD365File(createReq({
      objectType: 'form',
      objectName: 'GateTestForm',
      xmlContent: validXml(),
      modelName: 'ContosoExt',
      addToProject: false,
    }));
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(vi.mocked(fsMock.writeFile)).toHaveBeenCalled();
  });

  it('blocks an unknown pattern (FP001) before any write', async () => {
    process.env.FORM_PATTERN_ENFORCE = 'true';
    const xml = validXml().replace(
      '<Pattern xmlns="">SimpleList</Pattern>',
      '<Pattern xmlns="">SimplestList</Pattern>',
    );
    const result = await handleCreateD365File(createReq({
      objectType: 'form',
      objectName: 'GateTestForm',
      xmlContent: xml,
      modelName: 'ContosoExt',
      addToProject: false,
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FP001');
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it('blocks a missing required Grid (FP003) before any write', async () => {
    process.env.FORM_PATTERN_ENFORCE = 'true';
    // Retype the Grid into a Group — SimpleList then misses its required Grid
    const mutated = validXml()
      .replace('i:type="AxFormGridControl"', 'i:type="AxFormGroupControl"')
      .replace('<Type>Grid</Type>', '<Type>Group</Type>');
    const result = await handleCreateD365File(createReq({
      objectType: 'form',
      objectName: 'GateTestForm',
      xmlContent: mutated,
      modelName: 'ContosoExt',
      addToProject: false,
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FP003');
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it('does not block when FORM_PATTERN_ENFORCE=false (errors downgrade to warnings)', async () => {
    process.env.FORM_PATTERN_ENFORCE = 'false';
    const xml = validXml().replace(
      '<Pattern xmlns="">SimpleList</Pattern>',
      '<Pattern xmlns="">SimplestList</Pattern>',
    );
    const result = await handleCreateD365File(createReq({
      objectType: 'form',
      objectName: 'GateTestForm',
      xmlContent: xml,
      modelName: 'ContosoExt',
      addToProject: false,
    }));
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('FORM_PATTERN_ENFORCE is disabled');
    expect(result.content[0].text).toContain('FP001');
    expect(vi.mocked(fsMock.writeFile)).toHaveBeenCalled();
  });

  it('generates a gate-passing form from a SimpleList template (no xmlContent)', async () => {
    // Regression: requesting formTemplate="SimpleList" with no xmlContent used to
    // emit an empty-controls skeleton declaring a DetailsTransaction pattern,
    // which the gate blocked (FP003 missing ActionPane/Tab). The template path
    // must now produce a pattern-compliant SimpleList that writes cleanly.
    process.env.FORM_PATTERN_ENFORCE = 'true';
    const result = await handleCreateD365File(createReq({
      objectType: 'form',
      objectName: 'RentEquipment',
      properties: { formTemplate: 'SimpleList', dataSource: 'ContosoRentEquipment', caption: 'Rent Equipment' },
      modelName: 'ContosoExt',
      addToProject: false,
    }));
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(vi.mocked(fsMock.writeFile)).toHaveBeenCalled();
    const written = String(vi.mocked(fsMock.writeFile).mock.calls.at(-1)?.[1] ?? '');
    expect(written).toContain('<Pattern xmlns="">SimpleList</Pattern>');
    expect(written).not.toContain('DetailsTransaction');
  });

  it('never gates non-form objectTypes', async () => {
    process.env.FORM_PATTERN_ENFORCE = 'true';
    const result = await handleCreateD365File(createReq({
      objectType: 'class',
      objectName: 'GateTestClass',
      modelName: 'ContosoExt',
      addToProject: false,
    }));
    expect(result.content[0].text ?? '').not.toContain('FP0');
  });
});
