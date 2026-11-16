/**
 * The model lifecycle on real folders: d365fo_file with
 * objectType="model-descriptor" for create / modify-property / delete, and the
 * read side, get_object_info(objectType="model").
 *
 * What is guarded here is what goes wrong quietly: a model created under a
 * taken name or Id, a reference to a package that does not exist, a delete that
 * takes a model other models still build on, a Microsoft model touched at all —
 * and a model the rest of the server cannot write into because no
 * configuration knows it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const state = { root: '', msRoot: '', anchor: 'ContosoCore' as string | null, projects: {} as Record<string, string[]> };

vi.mock('../../src/utils/configManager', () => {
  const manager = {
    ensureLoaded: async () => {},
    getModelName: () => state.anchor,
    getWriteAnchorModel: () => state.anchor,
    resolveWriteAnchorModel: async () => state.anchor,
    getAutoDetectedModelName: async () => state.anchor,
    getToolProjectSwitch: () => null,
    getCustomPackagesPath: async () => state.root,
    getPackagePath: () => state.root,
    getMicrosoftPackagesPath: async () => state.msRoot,
    getProjectsForModel: (m: string | null) => (m ? state.projects[m] ?? [] : []),
    getProjectPath: async () => null,
    getSolutionPath: async () => null,
    getAllDetectedProjects: () => [],
  };
  return {
    getConfigManager: vi.fn(() => manager),
    fallbackPackagePath: () => state.root,
    extractModelFromFilePath: () => null,
  };
});

import {
  handleCreateModel, handleDeleteModel, handleModelProperty, tidyAfterModelUndo,
} from '../../src/tools/write/modelLifecycle';
import { d365foFileTool } from '../../src/tools/d365foFile';
import { modelInfoTool } from '../../src/tools/readers/modelInfo';
import { buildDescriptorXml, parseDescriptor, MODEL_ID_MIN } from '../../src/metadata/modelInventory';
import { lookupCreatedArtifact } from '../../src/workspace/createdArtifactLedger';
import { clearAutoDetectedModels } from '../../src/utils/modelClassifier';
import { lookupOpSpec } from '../../src/tools/specs/opSpecs';
import { OBJECT_INFO_TYPES } from '../../src/tools/readers/objectInfoRegistry';

const BOM = '﻿';
const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

async function seedModel(
  base: string, pkg: string, name: string, refs: string[], id: number,
  extra: { layer?: number; publisher?: string } = {},
): Promise<string> {
  const dir = path.join(base, pkg, 'Descriptor');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(base, pkg, name), { recursive: true });
  const file = path.join(dir, `${name}.xml`);
  await fs.writeFile(file, BOM + buildDescriptorXml({
    name, displayName: name, description: '', id, layer: extra.layer ?? 12, publisher: extra.publisher ?? 'Contoso',
    modelModule: pkg, version: { major: 1, minor: 0, build: 0, revision: 0 }, moduleReferences: refs,
  }).replace(/\n/g, '\r\n'), 'utf-8');
  return file;
}

let envPath: string;
const envFile = () => ({ envPath, ownedByRealEnv: () => false });
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CUSTOM_MODELS', 'D365FO_CROSS_MODEL_WRITE_MODELS', 'D365FO_ALLOW_CROSS_MODEL_WRITE'];

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-lifecycle-'));
  state.msRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'model-lifecycle-ms-'));
  state.anchor = 'ContosoCore';
  state.projects = {};
  envPath = path.join(state.root, '..', `${path.basename(state.root)}.env`);
  await fs.writeFile(envPath, 'CUSTOM_MODELS=ContosoCore\n', 'utf-8');
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CUSTOM_MODELS = 'ContosoCore';
  clearAutoDetectedModels();

  for (const ms of ['ApplicationPlatform', 'ApplicationFoundation', 'ApplicationSuite']) {
    await seedModel(state.msRoot, ms, ms, [], 400 + ms.length, { layer: 0, publisher: 'Microsoft Corporation' });
  }
  await seedModel(state.root, 'ContosoCore', 'ContosoCore', ['ApplicationPlatform'], MODEL_ID_MIN);
});

afterEach(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await fs.rm(envPath, { force: true });
  await fs.rm(state.root, { recursive: true, force: true });
  await fs.rm(state.msRoot, { recursive: true, force: true });
});

const create = (args: Record<string, unknown>, random = () => 0) =>
  handleCreateModel({ objectType: 'model-descriptor', ...args }, undefined, { envFile: envFile(), random });
const remove = (args: Record<string, unknown>) =>
  handleDeleteModel({ objectType: 'model-descriptor', dryRun: false, ...args }, undefined, { envFile: envFile() });

describe('create', () => {
  it('writes the descriptor and the model folder, defaulting layer and publisher from the workspace model', async () => {
    const res = await create({ objectName: 'ContosoScripts', properties: { description: 'One-off scripts' } });
    expect(res.isError, text(res)).toBeFalsy();

    const file = path.join(state.root, 'ContosoScripts', 'Descriptor', 'ContosoScripts.xml');
    const raw = await fs.readFile(file, 'utf-8');
    // As Visual Studio writes one: BOM, CRLF, no trailing newline.
    expect(raw.startsWith(BOM)).toBe(true);
    expect(raw).toContain('\r\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parseDescriptor(raw)).toMatchObject({
      name: 'ContosoScripts', displayName: 'ContosoScripts', description: 'One-off scripts', layer: 12,
      publisher: 'Contoso', modelModule: 'ContosoScripts', moduleReferences: ['ApplicationPlatform'],
      version: { major: 1, minor: 0, build: 0, revision: 0 },
    });
    expect((await fs.stat(path.join(state.root, 'ContosoScripts', 'ContosoScripts'))).isDirectory()).toBe(true);
    // Undo can remove it: the ledger knows this session made it.
    expect(lookupCreatedArtifact(file)?.objectType).toBe('model-descriptor');
  });

  it('picks an Id no visible descriptor uses', async () => {
    // random() = 0 proposes MODEL_ID_MIN, which ContosoCore holds.
    await create({ objectName: 'ContosoScripts' }, () => 0);
    const raw = await fs.readFile(path.join(state.root, 'ContosoScripts', 'Descriptor', 'ContosoScripts.xml'), 'utf-8');
    expect(parseDescriptor(raw)!.id).toBe(MODEL_ID_MIN + 1);
    const taken = await create({ objectName: 'ContosoOther', properties: { id: MODEL_ID_MIN } });
    expect(taken.isError).toBe(true);
    expect(text(taken)).toMatch(/already used by "ContosoCore"/);
  });

  it('records the model in CUSTOM_MODELS and the cross-model allow-list, in .env and in the process', async () => {
    const res = await create({ objectName: 'ContosoScripts' });
    const env = await fs.readFile(envPath, 'utf-8');
    expect(env).toContain('CUSTOM_MODELS=ContosoCore,ContosoScripts');
    expect(env).toContain('D365FO_CROSS_MODEL_WRITE_MODELS=ContosoScripts');
    expect(process.env.D365FO_CROSS_MODEL_WRITE_MODELS).toBe('ContosoScripts');
    // Reported, never silent.
    expect(text(res)).toContain('D365FO_CROSS_MODEL_WRITE_MODELS=ContosoScripts');
    expect(text(res)).toContain('still targets "ContosoCore"');
  });

  it('dryRun writes nothing at all', async () => {
    const res = await create({ objectName: 'ContosoScripts', dryRun: true });
    expect(text(res)).toMatch(/DRY RUN/);
    await expect(fs.stat(path.join(state.root, 'ContosoScripts'))).rejects.toThrow();
    expect(await fs.readFile(envPath, 'utf-8')).toBe('CUSTOM_MODELS=ContosoCore\n');
  });

  it('refuses a reference that names no package, a self-reference and a bad name', async () => {
    const typo = await create({ objectName: 'ContosoScripts', properties: { moduleReferences: ['ApplicationSuit'] } });
    expect(typo.isError).toBe(true);
    expect(text(typo)).toMatch(/"ApplicationSuit" name no package folder/);
    await expect(fs.stat(path.join(state.root, 'ContosoScripts'))).rejects.toThrow();

    const allowed = await create({
      objectName: 'ContosoScripts',
      properties: { moduleReferences: ['applicationsuite', 'IsvOnBuildAgent'], allowUnresolvedReferences: true },
    });
    expect(allowed.isError, text(allowed)).toBeFalsy();
    const raw = await fs.readFile(path.join(state.root, 'ContosoScripts', 'Descriptor', 'ContosoScripts.xml'), 'utf-8');
    // Spelled as the folder is, whatever the caller typed.
    expect(parseDescriptor(raw)!.moduleReferences).toEqual(['ApplicationSuite', 'IsvOnBuildAgent']);

    expect((await create({ objectName: 'ContosoSelf', properties: { moduleReferences: ['ContosoSelf'] } })).isError).toBe(true);
    expect((await create({ objectName: '2Bad Name' })).isError).toBe(true);
    expect((await create({})).isError).toBe(true);
  });

  it('refuses a name that is taken, in any root and any casing', async () => {
    expect(text(await create({ objectName: 'contosocore' }))).toMatch(/already exists/);
    expect(text(await create({ objectName: 'ApplicationSuite' }))).toMatch(/already exists/);
  });

  it('refuses a Microsoft layer, and asks when there is no model to copy from', async () => {
    expect(text(await create({ objectName: 'ContosoScripts', properties: { layer: 'sys' } }))).toMatch(/Microsoft layer/);
    await fs.rm(path.join(state.root, 'ContosoCore'), { recursive: true });
    const res = await create({ objectName: 'ContosoScripts' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/layer and publisher not given/);
    const explicit = await create({ objectName: 'ContosoScripts', properties: { layer: 'usr', publisher: 'Contoso' } });
    expect(explicit.isError, text(explicit)).toBeFalsy();
  });

  it('adds a model to an existing package only when asked to, and never to a Microsoft one', async () => {
    const res = await create({ objectName: 'ContosoCoreTests', properties: { packageName: 'ContosoCore' } });
    expect(res.isError, text(res)).toBeFalsy();
    const raw = await fs.readFile(path.join(state.root, 'ContosoCore', 'Descriptor', 'ContosoCoreTests.xml'), 'utf-8');
    expect(parseDescriptor(raw)!.modelModule).toBe('ContosoCore');
    expect((await fs.stat(path.join(state.root, 'ContosoCore', 'ContosoCoreTests'))).isDirectory()).toBe(true);

    const ms = await handleCreateModel(
      { objectName: 'ContosoInMs', packagePath: state.msRoot, properties: { packageName: 'ApplicationSuite', layer: 'cus', publisher: 'Contoso' } },
      undefined, { envFile: envFile() });
    expect(ms.isError).toBe(true);
    expect(text(ms)).toMatch(/Microsoft package/);
  });

  it('holds a model added to ANOTHER model\'s package to the cross-model guard', async () => {
    await seedModel(state.root, 'ContosoShared', 'ContosoShared', ['ApplicationPlatform'], MODEL_ID_MIN + 50);
    const res = await create({ objectName: 'ContosoSharedTests', properties: { packageName: 'ContosoShared' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Refusing to create/);
    await expect(fs.stat(path.join(state.root, 'ContosoShared', 'Descriptor', 'ContosoSharedTests.xml'))).rejects.toThrow();
  });
});

describe('modify-property', () => {
  const file = () => path.join(state.root, 'ContosoCore', 'Descriptor', 'ContosoCore.xml');

  it('edits one property and keeps BOM and CRLF', async () => {
    const res = await handleModelProperty({ modelName: 'ContosoCore', propertyPath: 'Version', propertyValue: '1.2.0.0' });
    expect(res.isError, text(res)).toBeFalsy();
    const raw = await fs.readFile(file(), 'utf-8');
    expect(raw.startsWith(BOM)).toBe(true);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parseDescriptor(raw)!.version).toEqual({ major: 1, minor: 2, build: 0, revision: 0 });
  });

  it('refuses a rename through the property door, byte-identically', async () => {
    const before = await fs.readFile(file());
    const res = await handleModelProperty({ modelName: 'ContosoCore', propertyPath: 'Name', propertyValue: 'ContosoNew' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/rename/);
    expect((await fs.readFile(file())).equals(before)).toBe(true);
  });

  it('refuses a Microsoft descriptor and another model\'s', async () => {
    const ms = await handleModelProperty({
      filePath: path.join(state.msRoot, 'ApplicationSuite', 'Descriptor', 'ApplicationSuite.xml'),
      propertyPath: 'Description', propertyValue: 'x',
    });
    expect(text(ms)).toMatch(/Microsoft model/);
    await seedModel(state.root, 'ContosoShared', 'ContosoShared', [], MODEL_ID_MIN + 50);
    const other = await handleModelProperty({ modelName: 'ContosoShared', propertyPath: 'Description', propertyValue: 'x' });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/Refusing to modify/);
  });

  it('is reachable through d365fo_file, single and batched', async () => {
    const single = await d365foFileTool({
      method: 'tools/call',
      params: { name: 'd365fo_file', arguments: {
        action: 'modify', objectType: 'model-descriptor', modelName: 'ContosoCore', operation: 'modify-property',
        params: { propertyPath: 'Description', propertyValue: 'Core model' },
      } },
    } as any, {} as any);
    expect((single as any).isError, text(single)).toBeFalsy();
    expect(parseDescriptor(await fs.readFile(file(), 'utf-8'))!.description).toBe('Core model');
  });
});

describe('delete', () => {
  beforeEach(async () => {
    // An empty model this session is allowed to remove.
    await seedModel(state.root, 'ContosoScripts', 'ContosoScripts', ['ApplicationPlatform', 'ContosoCore'], MODEL_ID_MIN + 7);
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'ContosoScripts';
    await fs.writeFile(envPath, 'CUSTOM_MODELS=ContosoCore,ContosoScripts\nD365FO_CROSS_MODEL_WRITE_MODELS=ContosoScripts\n', 'utf-8');
  });

  it('never takes the name from the configured model', async () => {
    const res = await remove({});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/name the model to delete/);
  });

  it('previews by default: without dryRun:false nothing is deleted', async () => {
    const res = await remove({ objectName: 'ContosoScripts', dryRun: undefined });
    expect(text(res)).toMatch(/DRY RUN/);
    expect((await fs.stat(path.join(state.root, 'ContosoScripts', 'Descriptor', 'ContosoScripts.xml'))).isFile()).toBe(true);
  });

  it('dryRun lists what would go and deletes nothing', async () => {
    const res = await remove({ objectName: 'ContosoScripts', dryRun: true });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/DRY RUN/);
    expect(text(res)).toMatch(/Nothing blocks it/);
    expect((await fs.stat(path.join(state.root, 'ContosoScripts', 'Descriptor', 'ContosoScripts.xml'))).isFile()).toBe(true);
  });

  it('removes an empty model, its package folder and its configuration entries', async () => {
    await fs.mkdir(path.join(state.root, 'ContosoScripts', 'bin'), { recursive: true });
    const res = await remove({ objectName: 'ContosoScripts' });
    expect(res.isError, text(res)).toBeFalsy();
    await expect(fs.stat(path.join(state.root, 'ContosoScripts'))).rejects.toThrow();
    expect(await fs.readFile(envPath, 'utf-8')).toBe('CUSTOM_MODELS=ContosoCore\nD365FO_CROSS_MODEL_WRITE_MODELS=\n');
    expect(process.env.D365FO_CROSS_MODEL_WRITE_MODELS).toBeUndefined();
  });

  it('refuses while the model still holds objects, unless forced', async () => {
    const cls = path.join(state.root, 'ContosoScripts', 'ContosoScripts', 'AxClass');
    await fs.mkdir(cls, { recursive: true });
    await fs.writeFile(path.join(cls, 'ContosoRunScript.xml'), '<AxClass />', 'utf-8');

    const refused = await remove({ objectName: 'ContosoScripts' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/still contains 1 file/);
    expect((await fs.stat(path.join(cls, 'ContosoRunScript.xml'))).isFile()).toBe(true);

    expect(text(await remove({ objectName: 'ContosoScripts', dryRun: true }))).toMatch(/would be REFUSED/);

    const forced = await remove({ objectName: 'ContosoScripts', force: true });
    expect(forced.isError, text(forced)).toBeFalsy();
    await expect(fs.stat(path.join(state.root, 'ContosoScripts'))).rejects.toThrow();
  });

  it('refuses while another model references its package, and names that model', async () => {
    await seedModel(state.root, 'ContosoReports', 'ContosoReports', ['ContosoScripts'], MODEL_ID_MIN + 9);
    const res = await remove({ objectName: 'ContosoScripts' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/ContosoReports/);
    expect(text(res)).toMatch(/remove-module-reference/);
  });

  it('keeps the package when another model still lives in it', async () => {
    state.anchor = 'ContosoCore';
    await seedModel(state.root, 'ContosoCore', 'ContosoCoreTests', ['ApplicationPlatform'], MODEL_ID_MIN + 11);
    // ContosoCore is referenced by ContosoScripts — but the package survives, so that is no blocker.
    const res = await remove({ objectName: 'ContosoCoreTests' });
    expect(res.isError, text(res)).toBeFalsy();
    await expect(fs.stat(path.join(state.root, 'ContosoCore', 'Descriptor', 'ContosoCoreTests.xml'))).rejects.toThrow();
    await expect(fs.stat(path.join(state.root, 'ContosoCore', 'ContosoCoreTests'))).rejects.toThrow();
    expect((await fs.stat(path.join(state.root, 'ContosoCore', 'Descriptor', 'ContosoCore.xml'))).isFile()).toBe(true);
  });

  it('keeps a package folder that holds anything it does not recognise', async () => {
    await fs.writeFile(path.join(state.root, 'ContosoScripts', 'README.md'), 'notes', 'utf-8');
    const res = await remove({ objectName: 'ContosoScripts' });
    expect(res.isError, text(res)).toBeFalsy();
    expect(text(res)).toMatch(/was kept: it also holds README.md/);
    expect((await fs.stat(path.join(state.root, 'ContosoScripts', 'README.md'))).isFile()).toBe(true);
    await expect(fs.stat(path.join(state.root, 'ContosoScripts', 'Descriptor'))).rejects.toThrow();
  });

  it('refuses a Microsoft model, a model the guard does not allow, and an unknown one', async () => {
    expect(text(await remove({ objectName: 'ApplicationSuite', force: true }))).toMatch(/Microsoft model/);
    await seedModel(state.root, 'ContosoShared', 'ContosoShared', [], MODEL_ID_MIN + 50);
    const foreign = await remove({ objectName: 'ContosoShared', force: true });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toMatch(/Refusing to delete/);
    expect((await fs.stat(path.join(state.root, 'ContosoShared', 'Descriptor', 'ContosoShared.xml'))).isFile()).toBe(true);
    expect((await remove({ objectName: 'ContosoNope' })).isError).toBe(true);
  });

  it('is reachable through d365fo_file(action="delete")', async () => {
    const res: any = await d365foFileTool({
      method: 'tools/call',
      params: { name: 'd365fo_file', arguments: {
        action: 'delete', objectType: 'model-descriptor', objectName: 'ContosoScripts',
      } },
    } as any, {} as any);
    expect(text(res)).toMatch(/DRY RUN/);
  });
});

describe('create through d365fo_file, then undo', () => {
  it('routes action="create" to the model handler and tidies up after an undo', async () => {
    const res: any = await d365foFileTool({
      method: 'tools/call',
      params: { name: 'd365fo_file', arguments: {
        action: 'create', objectType: 'model-descriptor', objectName: 'ContosoScripts',
        properties: { layer: 'usr', publisher: 'Contoso', moduleReferences: [] },
      } },
    } as any, {} as any);
    expect(res.isError, text(res)).toBeFalsy();
    const file = path.join(state.root, 'ContosoScripts', 'Descriptor', 'ContosoScripts.xml');
    expect(parseDescriptor(await fs.readFile(file, 'utf-8'))!.layer).toBe(14);

    // What action="undo" does once it has unlinked the descriptor.
    await fs.rm(file);
    const note = await tidyAfterModelUndo(file, { envFile: null });
    expect(note).toMatch(/Removed the empty model folder/);
    await expect(fs.stat(path.join(state.root, 'ContosoScripts'))).rejects.toThrow();
    expect(process.env.D365FO_CROSS_MODEL_WRITE_MODELS).toBeUndefined();
  });
});

describe('get_object_info(objectType="model")', () => {
  const info = (name: string, options: Record<string, unknown> = {}) =>
    modelInfoTool({ method: 'tools/call', params: { name: 'get_model_info', arguments: { modelName: name, ...options } } } as any, {} as any);

  beforeEach(async () => {
    await seedModel(state.root, 'ContosoExt', 'ContosoExt', ['ApplicationPlatform', 'ContosoCore', 'Missing'], MODEL_ID_MIN + 3);
  });

  it('is a published get_object_info type', () => {
    expect(OBJECT_INFO_TYPES).toContain('model');
  });

  it('describes one model: references, dependents, objects', async () => {
    const out = text(await info('ContosoCore'));
    expect(out).toContain('# Model: `ContosoCore` (the model this workspace targets)');
    expect(out).toContain('**Layer:** cus (12)');
    expect(out).toMatch(/## Referenced by \(1\)\s+- ContosoExt/);
    const ext = text(await info('contosoext'));
    expect(ext).toContain('- Missing ⚠️ no such package folder on this box');
    expect(ext).toContain('- ContosoCore\n');
  });

  it('lists the custom models and the problems among them', async () => {
    await seedModel(state.root, 'ContosoTwin', 'ContosoTwin', [], MODEL_ID_MIN + 3);
    const out = text(await info('*'));
    expect(out).toContain('# Models (3 custom, 3 Microsoft — not listed)');
    expect(out).toContain('| ContosoCore ← workspace | ContosoCore |');
    expect(out).not.toContain('| ApplicationSuite |');
    expect(out).toContain('ContosoExt references Missing');
    expect(out).toMatch(/Model Id \d+ is used by ContosoExt and ContosoTwin/);
    expect(text(await info('*', { includeStandard: true }))).toContain('| ApplicationSuite |');
  });

  it('answers a miss with the models that do exist', async () => {
    const res: any = await info('ContosoNope');
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('ContosoCore, ContosoExt');
  });
});

describe('the lifecycle is discoverable', () => {
  it('op-spec answers for the objectType and for the lifecycle as a whole', () => {
    expect(lookupOpSpec('model-descriptor')).toMatch(/Creates a MODEL/);
    for (const topic of ['model', 'create-model', 'delete-model', 'rename-model']) {
      const answer = lookupOpSpec(topic);
      expect(answer, topic).toMatch(/RENAME \/ MOVE TO ANOTHER PACKAGE — not offered/);
      expect(answer, topic).toContain('get_object_info(objectType="model", name="*")');
    }
    expect(lookupOpSpec('modify-property')).toMatch(/model-descriptor: propertyPath is one of Description/);
    expect(lookupOpSpec()).toContain('topic="model"');
  });
});
