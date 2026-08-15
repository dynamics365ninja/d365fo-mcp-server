/**
 * ensureBpCatalogFresh (src/cli/commands/bpCatalog.ts) — regenerates a
 * target's BP moniker catalog only when its resolved D365FO version has
 * moved since the catalog was last stamped, including "never generated"
 * (first-time instance creation). Every other call must be a cheap no-op:
 * no subprocess, no write.
 *
 * Exercised against a traditional environment, where the version key is the
 * packages root's bin\ folder mtime — no XPP config fixture needed.
 * commandExists/runExe are injected directly (see BpCatalogDeps) rather than
 * mocked, so these tests never spawn a real process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureBpCatalogFresh, type BpCatalogDeps } from '../../src/cli/commands/bpCatalog.js';
import { openStore } from '../../src/cli/settingsStore.js';
import { writeConfigFile } from '../../src/config/configFile.js';
import type { Target } from '../../src/cli/target.js';

let root: string;
let packagesPath: string;
let binDir: string;
let originalLocalAppData: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'bp-catalog-target-'));
  packagesPath = join(root, 'packages');
  binDir = join(packagesPath, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  originalLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  // The UDE case repoints LOCALAPPDATA at a fixture; the real one must not stay
  // shadowed for whatever runs next in this file.
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  fs.rmSync(root, { recursive: true, force: true });
});

function makeTarget(): Target {
  const configDir = join(root, 'instance');
  fs.mkdirSync(configDir, { recursive: true });
  writeConfigFile(join(configDir, 'd365fo-mcp.json'), {
    environment: { type: 'traditional', packagePath: packagesPath },
  });
  const store = openStore(configDir, null);
  return { name: 'test', label: "instance 'test'", envFile: null, store, port: null };
}

/**
 * A UDE target pinned to a config whose JSON cannot be parsed, so
 * listXppConfigs() lists it (by design) with no frameworkDirectory.
 */
function makeUdeTargetWithUnreadableConfig(): Target {
  const xppDir = join(root, 'LocalAppData', 'Microsoft', 'Dynamics365', 'XPPConfig');
  fs.mkdirSync(xppDir, { recursive: true });
  fs.writeFileSync(join(xppDir, 'contoso___10.0.2500.7.json'), '{ not json', 'utf-8');
  process.env.LOCALAPPDATA = join(root, 'LocalAppData');

  const configDir = join(root, 'ude-instance');
  fs.mkdirSync(configDir, { recursive: true });
  writeConfigFile(join(configDir, 'd365fo-mcp.json'), {
    environment: { type: 'ude', xppConfigName: 'contoso___10.0.2500.7' },
  });
  const store = openStore(configDir, null);
  return { name: 'ude', label: "instance 'ude'", envFile: null, store, port: null };
}

/** The value ensureBpCatalogFresh persisted into the instance config, if any. */
function readWrittenSetting(): unknown {
  const file = join(root, 'instance', 'd365fo-mcp.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).index?.bpCatalogPath;
}

function fakeDeps(overrides: Partial<BpCatalogDeps> = {}): BpCatalogDeps {
  return {
    commandExists: async () => true,
    runExe: async (_cmd, args) => {
      // Mirrors extract-bp-catalog.ps1's -OutFile branch, which creates the
      // parent directory itself before writing (New-Item -Force).
      const outIdx = args.indexOf('-OutFile');
      const versionIdx = args.indexOf('-Version');
      const outFile = args[outIdx + 1];
      fs.mkdirSync(join(outFile, '..'), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify({ version: args[versionIdx + 1], entries: [] }), 'utf-8');
      return 0;
    },
    ...overrides,
  };
}

describe('ensureBpCatalogFresh', () => {
  it('regenerates when no catalog exists yet (first-time creation)', async () => {
    const target = makeTarget();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(1);
    expect(fs.existsSync(join(root, 'instance', 'data', 'bp-moniker-catalog.json'))).toBe(true);
  });

  it('is a no-op on a second call when the version has not changed', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());

    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(0);
  });

  it('regenerates again once the packages root changes (bin\\ mtime moves)', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());

    // Simulate a platform update: something inside bin\ changes, moving its mtime.
    fs.writeFileSync(join(binDir, 'xppc.exe'), 'x');
    fs.utimesSync(binDir, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(1);
  });

  it('skips without throwing when neither pwsh nor powershell is on PATH', async () => {
    const target = makeTarget();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({
      commandExists: async () => false,
      runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); },
    }));
    expect(calls).toBe(0);
    expect(fs.existsSync(join(root, 'instance', 'data', 'bp-moniker-catalog.json'))).toBe(false);
  });

  it('keeps the previous catalog and does not write the setting when extraction fails', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async () => 1 }));
    expect(fs.existsSync(join(root, 'instance', 'data', 'bp-moniker-catalog.json'))).toBe(false);
    expect(readWrittenSetting()).toBeUndefined();
  });

  it('records the catalog as a portable RELATIVE path, not the resolved absolute one', async () => {
    // index.bpCatalogPath has no registry default, so this write is what turns
    // the per-instance override on — and an absolute path baked into the
    // instance config would not survive the folder being renamed or moved,
    // which is the whole point of resolving path settings against baseDir.
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());

    expect(readWrittenSetting()).toBe('./data/bp-moniker-catalog.json');
  });

  it('skips a UDE target whose pinned config carries no FrameworkDirectory', async () => {
    // listXppConfigs() deliberately keeps a config whose JSON could not be
    // read, so frameworkDirectory can legitimately be undefined. Passing '' on
    // to the script is not "use the default": its own -PackagesPath fallback
    // auto-detects the NEWEST PackagesLocalDirectory on the box, and the result
    // would then be stamped with this target's version and treated as current.
    const target = makeUdeTargetWithUnreadableConfig();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));

    expect(calls).toBe(0);
  });
});
