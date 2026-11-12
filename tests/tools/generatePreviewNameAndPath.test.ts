/**
 * d365fo_file(action="generate") must preview the object create would write:
 * the same name, in the same file.
 *
 * It did neither. Under a configured prefix the preview said `<Name>RentEquipmentJob</Name>`
 * and renamed the caller's `class CtsoRentEquipmentJob` back to `RentEquipmentJob`, while
 * prepare(mode="create") predicted CtsoRentEquipmentJob and create wrote that. And the
 * recommended path was always `<packagePath>\<model>\<model>\…` under the Microsoft
 * PackagesLocalDirectory, where create writes into the custom write root and into the
 * package the model's descriptor names. Copying the preview to that path produced an
 * object the next create could not see, in a package that is not under source control.
 *
 * Real objectNaming, modelClassifier and PackageResolver (over a temp metadata tree);
 * only configManager is mocked. The parity case runs the real create into the same
 * tree, so "the path create writes" is the writer's own answer, not a copy of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { handleGenerateD365Xml } from '../../src/tools/xml/generateD365Xml';
import { handleCreateD365File, type CreateOutcome } from '../../src/tools/write/createD365File';
import { registerCustomModel } from '../../src/utils/modelClassifier';

const { cfg } = vi.hoisted(() => ({
  cfg: {
    packagePath: null as string | null,
    customPackagesPath: null as string | null,
    model: 'ContosoExt',
  },
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getContext: vi.fn(() => null),
    getPackagePath: vi.fn(() => cfg.packagePath),
    getModelName: vi.fn(() => cfg.model),
    getWriteAnchorModel: vi.fn(() => cfg.model),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => null),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getWorkspaceProjectCandidates: vi.fn(() => []),
    getAmbiguousProjectPaths: vi.fn(() => []),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
    getCustomPackagesPath: vi.fn(async () => cfg.customPackagesPath),
    getMicrosoftPackagesPath: vi.fn(async () => null),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

const req = (name: string, args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const generate = async (args: Record<string, unknown>): Promise<string> => {
  const result: any = await handleGenerateD365Xml(req('generate_d365fo_xml', { objectType: 'class', ...args }));
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.content[0].text as string;
};

const recommendedPath = (text: string): string => {
  const m = /Recommended path: (.+)/.exec(text);
  expect(m, 'no recommended path in the reply').not.toBeNull();
  return m![1].trim();
};

const descriptor = (name: string, moduleName: string) =>
  `<?xml version="1.0"?>\n<AxModelInfo>\n  <Name>${name}</Name>\n  <ModelModule>${moduleName}</ModelModule>\n</AxModelInfo>\n`;

const ENV_KEYS = ['EXTENSION_PREFIX', 'EXTENSION_SUFFIX', 'EXTENSION_NAMING_STYLE', 'EXTENSION_PREFIX_SOURCE'];
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXTENSION_PREFIX = 'Ctso';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'generate-target-'));
  cfg.packagePath = path.join(root, 'PackagesLocalDirectory');
  cfg.customPackagesPath = null;
  cfg.model = 'ContosoExt';
  await fs.mkdir(cfg.packagePath, { recursive: true });
  registerCustomModel('ContosoExt');
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('generate names the object as create does', () => {
  it('applies the prefix to <Name>, the declaration and the file, and says so', async () => {
    const text = await generate({
      objectName: 'RentEquipmentJob',
      modelName: 'ContosoExt',
      sourceCode: 'class CtsoRentEquipmentJob\n{\n    public static void main(Args _args)\n    {\n    }\n}',
    });

    expect(text).toContain('<Name>CtsoRentEquipmentJob</Name>');
    expect(text).toMatch(/class CtsoRentEquipmentJob\b/);
    expect(text).not.toContain('<Name>RentEquipmentJob</Name>');
    expect(text).not.toMatch(/class RentEquipmentJob\b/);
    expect(recommendedPath(text)).toMatch(/\\AxClass\\CtsoRentEquipmentJob\.xml$/);
    // The rename is disclosed in the reply, in create's words.
    expect(text).toMatch(/Named `CtsoRentEquipmentJob`, not `RentEquipmentJob` as passed/);
  });

  it('carries the rename into a declaration written with the name as passed', async () => {
    const text = await generate({
      objectName: 'RentEquipmentJob',
      modelName: 'ContosoExt',
      sourceCode: 'class RentEquipmentJob\n{\n    public static void main(Args _args)\n    {\n    }\n}',
    });

    expect(text).toContain('<Name>CtsoRentEquipmentJob</Name>');
    expect(text).toMatch(/class CtsoRentEquipmentJob\b/);
  });

  it('says nothing about a rename when the name is already final', async () => {
    const text = await generate({ objectName: 'CtsoRentEquipmentJob', modelName: 'ContosoExt' });

    expect(text).toContain('<Name>CtsoRentEquipmentJob</Name>');
    expect(text).not.toMatch(/as passed/);
    expect(text).not.toContain('🔖');
  });
});

describe('generate recommends the file create writes', () => {
  it('recommends the custom write root and the model folder the descriptor names', async () => {
    // Package "ContosoCore" holds the model "Contoso Core": neither the
    // PackagesLocalDirectory nor `<model>\<model>` is where its files live.
    const custom = path.join(root, 'Metadata');
    await fs.mkdir(path.join(custom, 'ContosoCore', 'Descriptor'), { recursive: true });
    await fs.writeFile(
      path.join(custom, 'ContosoCore', 'Descriptor', 'ContosoCore.xml'),
      descriptor('Contoso Core', 'ContosoCore'),
    );
    await fs.mkdir(path.join(custom, 'ContosoCore', 'Contoso Core', 'AxClass'), { recursive: true });
    cfg.customPackagesPath = custom;
    cfg.model = 'Contoso Core';
    registerCustomModel('Contoso Core');

    const text = await generate({ objectName: 'CtsoRentEquipmentJob', modelName: 'Contoso Core' });

    expect(recommendedPath(text).toLowerCase()).toBe(
      path.join(custom, 'ContosoCore', 'Contoso Core', 'AxClass', 'CtsoRentEquipmentJob.xml')
        .replace(/\//g, '\\').toLowerCase(),
    );
  });

  it('falls back to the custom write root, not the PackagesLocalDirectory, for an unknown package', async () => {
    const custom = path.join(root, 'Metadata');
    await fs.mkdir(custom, { recursive: true });
    cfg.customPackagesPath = custom;

    const text = await generate({ objectName: 'CtsoRentEquipmentJob', modelName: 'ContosoExt' });

    expect(recommendedPath(text).toLowerCase()).toBe(
      path.join(custom, 'ContosoExt', 'ContosoExt', 'AxClass', 'CtsoRentEquipmentJob.xml')
        .replace(/\//g, '\\').toLowerCase(),
    );
  });

  it('recommends exactly the file create then writes', async () => {
    const custom = path.join(root, 'Metadata');
    await fs.mkdir(path.join(custom, 'ContosoCore', 'Descriptor'), { recursive: true });
    await fs.writeFile(
      path.join(custom, 'ContosoCore', 'Descriptor', 'ContosoCore.xml'),
      descriptor('Contoso Core', 'ContosoCore'),
    );
    await fs.mkdir(path.join(custom, 'ContosoCore', 'Contoso Core', 'AxClass'), { recursive: true });
    cfg.customPackagesPath = custom;
    cfg.model = 'Contoso Core';
    registerCustomModel('Contoso Core');
    const args = {
      objectType: 'class',
      objectName: 'RentEquipmentJob',
      modelName: 'Contoso Core',
      sourceCode: 'class RentEquipmentJob\n{\n}',
    };

    const preview = await generate(args);
    const outcome: CreateOutcome = {};
    const created = await handleCreateD365File(req('create_d365fo_file', { ...args, addToProject: false }), undefined, outcome);

    expect(created.isError, created.content[0].text).toBeFalsy();
    expect(outcome.finalObjectName).toBe('CtsoRentEquipmentJob');
    expect(recommendedPath(preview)).toBe(outcome.filePath);
    const written = await fs.readFile(outcome.filePath!, 'utf-8');
    expect(written).toContain('<Name>CtsoRentEquipmentJob</Name>');
    expect(preview).toContain('<Name>CtsoRentEquipmentJob</Name>');
  });
});
