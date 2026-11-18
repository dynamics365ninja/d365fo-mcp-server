import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { isModelInCustomStore, clearCustomStoreCache } from '../../src/utils/customModelStore.js';
import { clearSharedPackageMaps } from '../../src/utils/packageResolver.js';
import { isStandardModel } from '../../src/utils/modelClassifier.js';
import { getConfigManager } from '../../src/utils/configManager.js';
import { d365foFileTool } from '../../src/tools/d365foFile.js';

// A custom TEST model that lives in the UDE custom metadata folder (ModelStoreFolder):
// not configured, not in CUSTOM_MODELS, no EXTENSION_PREFIX match and no project yet.
const MODEL = 'ContosoTest';

let root: string;
let custom: string;
let microsoft: string;

async function addPackage(store: string, model: string) {
  await fs.mkdir(path.join(store, model, 'Descriptor'), { recursive: true });
  await fs.writeFile(path.join(store, model, 'Descriptor', `${model}.xml`),
    `<AxModelInfo><Name>${model}</Name><ModelModule>${model}</ModelModule></AxModelInfo>`);
}

function environment(env: 'ude' | 'traditional', customRoot: string | null, microsoftRoot: string | null) {
  const cfg = getConfigManager();
  vi.spyOn(cfg, 'getDevEnvironmentType').mockResolvedValue(env);
  vi.spyOn(cfg, 'getCustomPackagesPath').mockResolvedValue(customRoot);
  vi.spyOn(cfg, 'getMicrosoftPackagesPath').mockResolvedValue(microsoftRoot);
}

beforeEach(async () => {
  clearCustomStoreCache();
  clearSharedPackageMaps();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-store-'));
  custom = path.join(root, 'Metadata');
  microsoft = path.join(root, 'PackagesLocalDirectory');
  await fs.mkdir(custom, { recursive: true });
  await fs.mkdir(microsoft, { recursive: true });
  await addPackage(microsoft, 'ApplicationSuite');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('isModelInCustomStore', () => {
  it('a model whose package is in the UDE custom store is custom by location', async () => {
    await addPackage(custom, MODEL);
    environment('ude', custom, microsoft);
    expect(isStandardModel(MODEL)).toBe(true); // what the name-based classifier says
    expect(await isModelInCustomStore(MODEL)).toBe(true);
    expect(await isModelInCustomStore(MODEL.toLowerCase())).toBe(true);
  });

  it('a model only in the Microsoft store, or nowhere, is not', async () => {
    environment('ude', custom, microsoft);
    expect(await isModelInCustomStore('ApplicationSuite')).toBe(false);
    expect(await isModelInCustomStore(MODEL)).toBe(false);
  });

  it('proves nothing on a classic VM, where both kinds share PackagesLocalDirectory', async () => {
    await addPackage(microsoft, MODEL);
    environment('traditional', microsoft, microsoft);
    expect(await isModelInCustomStore(MODEL)).toBe(false);
    // Even when the environment reads as UDE, one shared folder proves nothing.
    environment('ude', microsoft, microsoft);
    expect(await isModelInCustomStore(MODEL)).toBe(false);
  });

  it('proves nothing when the stores nest or one of them is unknown', async () => {
    const nested = path.join(microsoft, 'Custom');
    await addPackage(nested, MODEL);
    environment('ude', nested, microsoft);
    expect(await isModelInCustomStore(MODEL)).toBe(false);
    await addPackage(custom, MODEL);
    environment('ude', custom, null);
    expect(await isModelInCustomStore(MODEL)).toBe(false);
  });
});

describe('d365fo_file(action="project", operation="create") for a model in the custom store', () => {
  let projects: string;
  beforeEach(async () => {
    projects = path.join(root, 'Projects');
    await fs.mkdir(path.join(projects, 'T-001'), { recursive: true });
    await fs.writeFile(path.join(projects, 'T-001', 'T-001.rnrproj'), '<Project/>');
    await fs.writeFile(path.join(projects, 'Contoso.sln'),
      'Microsoft Visual Studio Solution File, Format Version 12.00\r\nGlobal\r\nEndGlobal\r\n');
    getConfigManager().setRuntimeContext({ solutionPath: projects });
  });
  afterEach(() => { getConfigManager().setRuntimeContext({ solutionPath: undefined }); });

  const create = (projectName: string) => d365foFileTool({
    method: 'tools/call',
    params: { name: 'd365fo_file', arguments: { action: 'project', params: {
      operation: 'create', projectName, modelName: MODEL, projectsRoot: projects, activate: false,
    } } },
  } as any, {} as any) as Promise<any>;

  it('creates the project instead of refusing the model as standard', async () => {
    await addPackage(custom, MODEL);
    environment('ude', custom, microsoft);
    const r = await create('T-002');
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(await fs.readFile(path.join(projects, 'T-002', 'T-002.rnrproj'), 'utf-8')).toContain(`<Model>${MODEL}</Model>`);
  });

  it('still refuses the same model on a classic VM', async () => {
    await addPackage(microsoft, MODEL);
    environment('traditional', microsoft, microsoft);
    const r = await create('T-003');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('looks like a standard Microsoft model');
  });
});
