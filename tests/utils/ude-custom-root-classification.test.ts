/**
 * UDE: with no CUSTOM_MODELS list, every model under the custom packages root is custom
 * after start-up (path-based, like the metadata extract) — also one created in an earlier
 * session whose name matches no EXTENSION_PREFIX. A non-empty list stays untouched (#1310).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getConfigManager } from '../../src/utils/configManager.js';
import { XppConfigProvider } from '../../src/utils/xppConfigProvider.js';
import { isCustomModel, clearAutoDetectedModels } from '../../src/utils/modelClassifier.js';
import { buildDescriptorXml } from '../../src/metadata/modelInventory.js';

let root: string;
let savedList: string | undefined;
let savedPrefix: string | undefined;

async function seed(name: string) {
  const dir = path.join(root, name, 'Descriptor');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.xml`), buildDescriptorXml({
    name, displayName: name, description: '', id: 900, layer: 12, publisher: 'Contoso',
    modelModule: name, version: { major: 1, minor: 0, build: 0, revision: 0 }, moduleReferences: [],
  }), 'utf-8');
}

async function load() {
  const Cls = Object.getPrototypeOf(getConfigManager()).constructor;
  const mgr = new Cls('/nonexistent/.mcp.json');
  mgr.config = { servers: { context: {} } };
  mgr.autoDetectionAttempted = true;
  vi.spyOn(XppConfigProvider.prototype, 'getActiveConfig').mockResolvedValue({
    configName: 'ContosoUde', version: '1', customPackagesPath: root, microsoftPackagesPath: path.join(root, '..'),
    referencePackagesPaths: [], fullFilename: 'x',
  } as any);
  await mgr.getCustomPackagesPath();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ude-root-'));
  await seed('ContosoScripts');
  savedList = process.env.CUSTOM_MODELS; savedPrefix = process.env.EXTENSION_PREFIX;
  delete process.env.CUSTOM_MODELS; delete process.env.EXTENSION_PREFIX;
  clearAutoDetectedModels();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearAutoDetectedModels();
  if (savedList === undefined) delete process.env.CUSTOM_MODELS; else process.env.CUSTOM_MODELS = savedList;
  if (savedPrefix === undefined) delete process.env.EXTENSION_PREFIX; else process.env.EXTENSION_PREFIX = savedPrefix;
  await fs.rm(root, { recursive: true, force: true });
});

describe('UDE custom-root classification', () => {
  it('treats a model under the custom root as custom when CUSTOM_MODELS is empty', async () => {
    expect(isCustomModel('ContosoScripts')).toBe(false);
    await load();
    expect(isCustomModel('ContosoScripts')).toBe(true);
    expect(isCustomModel('ApplicationSuite')).toBe(false);
  });

  it('leaves a hand-written CUSTOM_MODELS list alone', async () => {
    process.env.CUSTOM_MODELS = 'ContosoCore';
    await load();
    expect(isCustomModel('ContosoScripts')).toBe(false);
  });
});
