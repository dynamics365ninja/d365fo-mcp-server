/**
 * Binary ISV models as a step of `d365fo-mcp index` (docs/BINARY_ISV_MODELS.md).
 *
 * Before this, the dump and the import were manual steps from a git checkout,
 * so an npm install had no way to run them, and every full rebuild
 * (extractMode "all" wipes METADATA_PATH) silently dropped the models again.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runNode = vi.hoisted(() => vi.fn(async (_args: string[], _opts?: { env?: Record<string, string> }) => 0));
vi.mock('../../src/cli/exec.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/cli/exec.js')>()),
  runNode,
}));
vi.mock('../../src/cli/commands/bpCatalog.js', () => ({ ensureBpCatalogFresh: vi.fn(async () => undefined) }));
const askMultiSelect = vi.hoisted(() => vi.fn(async (_m: string, _o: unknown[], initial: string[] = []) => initial));
vi.mock('../../src/cli/ui.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/cli/ui.js')>()),
  askMultiSelect,
}));

import {
  askBinaryIsvModels,
  binaryIsvConfig,
  extractorNeedsBuild,
  findBinaryOnlyPackages,
  isMicrosoftPublisher,
} from '../../src/cli/binaryIsv.js';
import { buildEnvAfterBinaryImport, rebuildIndex } from '../../src/cli/commands/indexCmd.js';
import { openStore, readSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';
import { writeConfigFile, type ConfigObject } from '../../src/config/configFile.js';
import type { Target } from '../../src/cli/target.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'binary-isv-cli-'));
  runNode.mockReset();
  runNode.mockImplementation(async () => 0);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(path: string, content = ''): void {
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(path, content);
}

function descriptor(publisher: string): string {
  return `<?xml version="1.0"?><AxModelInfo><Name>M</Name><Publisher>${publisher}</Publisher></AxModelInfo>`;
}

describe('findBinaryOnlyPackages', () => {
  it('finds packages with a module assembly and no object XML, with their publisher', () => {
    const pld = join(root, 'PackagesLocalDirectory');
    // Source package: an Ax* folder under its model folder.
    touch(join(pld, 'ContosoCore', 'bin', 'Dynamics.AX.ContosoCore.dll'));
    touch(join(pld, 'ContosoCore', 'ContosoCore', 'AxClass', 'ContosoRentEquipmentHelper.xml'));
    // Compiled-only ISV package.
    touch(join(pld, 'ContosoIsv', 'bin', 'Dynamics.AX.ContosoIsv.dll'));
    touch(join(pld, 'ContosoIsv', 'Descriptor', 'ContosoIsv.xml'), descriptor('Contoso Software'));
    touch(join(pld, 'ContosoIsv', 'XppMetadata', 'ContosoIsv', 'AxClass', 'x.md'));
    // Compiled-only, but Microsoft's.
    touch(join(pld, 'ContosoPlatformPart', 'bin', 'Dynamics.AX.ContosoPlatformPart.netmodule'));
    touch(join(pld, 'ContosoPlatformPart', 'Descriptor', 'P.xml'), descriptor('Microsoft Corporation'));
    // Not a package at all, and the platform's own bin.
    touch(join(pld, 'ContosoNotes', 'readme.txt'));
    touch(join(pld, 'bin', 'Microsoft.Dynamics.AX.Metadata.dll'));

    expect(findBinaryOnlyPackages(pld)).toEqual([
      { name: 'ContosoIsv', publisher: 'Contoso Software' },
      { name: 'ContosoPlatformPart', publisher: 'Microsoft Corporation' },
    ]);
  });

  it('returns nothing for a packages path that does not exist', () => {
    expect(findBinaryOnlyPackages(join(root, 'missing'))).toEqual([]);
  });

  it('treats only Microsoft publishers as platform', () => {
    expect(isMicrosoftPublisher('Microsoft Corporation')).toBe(true);
    expect(isMicrosoftPublisher('Contoso Software')).toBe(false);
    expect(isMicrosoftPublisher('')).toBe(false);
  });
});

describe('extractorNeedsBuild', () => {
  it('wants a build when the binary or its stamp is missing, or the platform changed', () => {
    const bin = join(root, 'bin');
    touch(join(bin, 'Microsoft.Dynamics.AX.Metadata.dll'), 'v1');
    const exe = join(root, 'out', 'BinaryModelExtractor.exe');

    expect(extractorNeedsBuild(bin, exe)).toBe(true);
    touch(exe);
    expect(extractorNeedsBuild(bin, exe)).toBe(true); // no stamp
    touch(join(root, 'out', 'BinaryModelExtractor.stamp.json'), JSON.stringify({ sourceHash: 'old', platform: 'old' }));
    expect(extractorNeedsBuild(bin, exe)).toBe(true);
  });
});

describe('buildEnvAfterBinaryImport', () => {
  const env = { D365FO_CONFIG: 'c.json' };

  it('adds the imported models to a custom build that names its models', () => {
    expect(buildEnvAfterBinaryImport(env, 'custom', ['ContosoExt'], ['ContosoIsv'], false))
      .toEqual({ D365FO_CONFIG: 'c.json', CUSTOM_MODELS: 'ContosoExt,ContosoIsv' });
  });

  it('leaves a full build, and a custom build scoped by the manifest, alone', () => {
    expect(buildEnvAfterBinaryImport(env, 'all', ['ContosoExt'], ['ContosoIsv'], false)).toBe(env);
    expect(buildEnvAfterBinaryImport(env, 'custom', [], ['ContosoIsv'], false)).toBe(env);
  });

  it('scopes a --binary-only build to exactly the imported models', () => {
    expect(buildEnvAfterBinaryImport(env, 'all', ['ContosoExt'], ['ContosoIsv'], true))
      .toEqual({ D365FO_CONFIG: 'c.json', EXTRACT_MODE: 'custom', CUSTOM_MODELS: 'ContosoIsv' });
  });
});

function makeTarget(config: ConfigObject): Target {
  const dir = join(root, 'instance');
  fs.mkdirSync(dir, { recursive: true });
  writeConfigFile(join(dir, 'd365fo-mcp.json'), config);
  const store = openStore(dir, null);
  return {
    name: 'contoso',
    label: "instance 'contoso'",
    envFile: null,
    store,
    port: null,
    instance: { name: 'contoso', dir, envFile: join(dir, '.env'), configFile: store.configPath, port: null },
  };
}

/** The script each runNode call ran: the .ts source or the dist bundle. */
function scriptOf(args: string[]): string {
  return args.find(a => /extract-metadata|extract-binary-models|build-database/.test(a)) ?? '';
}

describe('rebuildIndex with binary ISV models', () => {
  it('runs nothing else when no binary model is configured', async () => {
    const target = makeTarget({ environment: { type: 'traditional' } });

    expect(binaryIsvConfig(target)).toBeNull();
    expect(await rebuildIndex(target)).toBe(true);
    expect(runNode.mock.calls.map(c => scriptOf(c[0]))).toEqual([
      expect.stringMatching(/extract-metadata/),
      expect.stringMatching(/build-database/),
    ]);
  });

  it('imports a prepared dump between extraction and build, and adds it to a custom build', async () => {
    const dump = join(root, 'isv-dump');
    fs.mkdirSync(dump);
    const target = makeTarget({
      environment: { type: 'traditional', customModels: ['ContosoExt'] },
      index: { extractMode: 'custom', binaryIsvDumpPath: dump },
    });
    runNode.mockImplementation(async (args: string[]) => {
      const report = args[args.indexOf('--report') + 1];
      if (args.includes('--report')) fs.writeFileSync(report, JSON.stringify({ models: ['ContosoIsv'] }));
      return 0;
    });

    expect(await rebuildIndex(target)).toBe(true);
    const calls = runNode.mock.calls;
    expect(calls.map(c => scriptOf(c[0]))).toEqual([
      expect.stringMatching(/extract-metadata/),
      expect.stringMatching(/extract-binary-models/),
      expect.stringMatching(/build-database/),
    ]);
    expect(calls[1][0]).toContain(dump);
    expect(calls[1][0]).not.toContain('--force');
    expect(calls[2][1]?.env?.CUSTOM_MODELS).toBe('ContosoExt,ContosoIsv');
  });

  it('still builds the database when the binary step fails, so the extraction is not lost', async () => {
    const target = makeTarget({
      environment: { type: 'traditional' },
      index: { binaryIsvDumpPath: join(root, 'no-such-dump') },
    });

    expect(await rebuildIndex(target)).toBe(true);
    expect(runNode.mock.calls.map(c => scriptOf(c[0]))).toEqual([
      expect.stringMatching(/extract-metadata/),
      expect.stringMatching(/build-database/),
    ]);
  });

  it('--binary-only skips the extraction and fails when nothing is configured', async () => {
    expect(await rebuildIndex(makeTarget({ environment: { type: 'traditional' } }), { binaryOnly: true })).toBe(false);
    expect(runNode).not.toHaveBeenCalled();

    const dump = join(root, 'isv-dump');
    fs.mkdirSync(dump);
    const target = makeTarget({ environment: { type: 'traditional' }, index: { binaryIsvDumpPath: dump } });
    runNode.mockImplementation(async (args: string[]) => {
      if (args.includes('--report')) {
        fs.writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify({ models: ['ContosoIsv'] }));
      }
      return 0;
    });
    expect(await rebuildIndex(target, { binaryOnly: true, forceBinary: true })).toBe(true);
    const calls = runNode.mock.calls;
    expect(calls.map(c => scriptOf(c[0]))).toEqual([
      expect.stringMatching(/extract-binary-models/),
      expect.stringMatching(/build-database/),
    ]);
    expect(calls[0][0]).toContain('--force');
    expect(calls[1][1]?.env).toMatchObject({ EXTRACT_MODE: 'custom', CUSTOM_MODELS: 'ContosoIsv' });
  });

  it('skips the binary step for a standard-only index', async () => {
    const dump = join(root, 'isv-dump');
    fs.mkdirSync(dump);
    const target = makeTarget({
      environment: { type: 'traditional' },
      index: { extractMode: 'standard', binaryIsvDumpPath: dump },
    });

    expect(await rebuildIndex(target)).toBe(true);
    expect(runNode.mock.calls.map(c => scriptOf(c[0])).some(s => /extract-binary-models/.test(s))).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('askBinaryIsvModels (setup)', () => {
  function storeWith(config: ConfigObject) {
    const dir = join(root, 'setup');
    fs.mkdirSync(dir, { recursive: true });
    writeConfigFile(join(dir, 'd365fo-mcp.json'), config);
    return openStore(dir, null);
  }

  function compiledOnly(pld: string, name: string, publisher: string): void {
    touch(join(pld, name, 'bin', `Dynamics.AX.${name}.dll`));
    touch(join(pld, name, 'Descriptor', `${name}.xml`), descriptor(publisher));
  }

  it('asks nothing when the packages path has no compiled-only package', async () => {
    const pld = join(root, 'pld');
    fs.mkdirSync(pld);
    const store = storeWith({ environment: { packagePath: pld } });

    await askBinaryIsvModels(store);
    expect(askMultiSelect).not.toHaveBeenCalled();
    expect(readSetting(store, settingByPath('index.binaryIsvModels')!)).toBeUndefined();
  });

  it('preselects non-Microsoft packages and keeps masks that name no found package', async () => {
    askMultiSelect.mockClear();
    const pld = join(root, 'pld');
    compiledOnly(pld, 'ContosoIsv', 'Contoso Software');
    compiledOnly(pld, 'ContosoPlatformPart', 'Microsoft Corporation');

    const fresh = storeWith({ environment: { packagePath: pld } });
    await askBinaryIsvModels(fresh);
    expect(askMultiSelect.mock.calls[0][2]).toEqual(['ContosoIsv']);
    expect(readSetting(fresh, settingByPath('index.binaryIsvModels')!)).toEqual(['ContosoIsv']);

    const configured = storeWith({
      environment: { packagePath: pld },
      index: { binaryIsvModels: ['ContosoPlatformPart', 'ContosoOther*'] },
    });
    await askBinaryIsvModels(configured);
    // What was chosen before stays chosen; no Microsoft-based default overrides it.
    expect(askMultiSelect.mock.calls[1][2]).toEqual(['ContosoPlatformPart']);
    expect(readSetting(configured, settingByPath('index.binaryIsvModels')!)).toEqual(['ContosoOther*', 'ContosoPlatformPart']);
  });
});
