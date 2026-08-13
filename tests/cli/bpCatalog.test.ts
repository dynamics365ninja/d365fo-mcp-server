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

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'bp-catalog-target-'));
  packagesPath = join(root, 'packages');
  binDir = join(packagesPath, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
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
  });
});
