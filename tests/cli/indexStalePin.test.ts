/**
 * `d365fo-mcp index` refuses a target whose pinned XPP config file is gone.
 *
 * With the pin dangling, extract-metadata found no UDE config, fell back to the
 * drive-scanned packages root (often an empty leftover PackagesLocalDirectory),
 * extracted nothing with exit code 0, and the full rebuild then cleared the
 * database. rebuildIndex() must stop before the extract script is spawned, so
 * the existing index survives.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const runNode = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../../src/cli/exec.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/cli/exec.js')>()),
  runNode,
}));

import { rebuildIndex, staleXppConfigRefusal } from '../../src/cli/commands/indexCmd.js';
import { openStore } from '../../src/cli/settingsStore.js';
import { writeConfigFile, type ConfigObject } from '../../src/config/configFile.js';
import type { Target } from '../../src/cli/target.js';

const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
let root: string;
let configDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'index-stale-pin-'));
  // xppConfigDir() reads LOCALAPPDATA at call time, so this runs on Linux CI too.
  process.env.LOCALAPPDATA = join(root, 'LocalAppData');
  configDir = join(process.env.LOCALAPPDATA, 'Microsoft', 'Dynamics365', 'XPPConfig');
  fs.mkdirSync(configDir, { recursive: true });
  runNode.mockClear();
});

afterEach(() => {
  if (ORIGINAL_LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeXppConfig(fullName: string): void {
  fs.writeFileSync(join(configDir, `${fullName}.json`), '{}', 'utf-8');
}

function makeTarget(environment: ConfigObject, asInstance = true): Target {
  const dir = join(root, 'instance');
  fs.mkdirSync(dir, { recursive: true });
  writeConfigFile(join(dir, 'd365fo-mcp.json'), { environment });
  const store = openStore(dir, null);
  return asInstance
    ? {
      name: 'contoso',
      label: "instance 'contoso'",
      envFile: null,
      store,
      port: null,
      instance: { name: 'contoso', dir, envFile: join(dir, '.env'), configFile: store.configPath, port: null },
    }
    : { name: 'root', label: 'root server', envFile: null, store, port: null };
}

describe('staleXppConfigRefusal', () => {
  it('refuses a pin whose config file is gone and names the upgrade command', () => {
    // The pinned 10.0.2428.63 config was deleted; only the newer one is left.
    writeXppConfig('contoso-dev___10.0.2500.7');
    const target = makeTarget({ type: 'ude', xppConfigName: 'contoso-dev___10.0.2428.63' });

    const refusal = staleXppConfigRefusal(target);
    expect(refusal).toContain("'contoso-dev___10.0.2428.63'");
    expect(refusal).toContain('d365fo-mcp instance upgrade contoso');
  });

  it('points the root server at setup, which has no instance to upgrade', () => {
    writeXppConfig('contoso-dev___10.0.2500.7');
    const target = makeTarget({ type: 'ude', xppConfigName: 'contoso-dev___10.0.2428.63' }, false);

    expect(staleXppConfigRefusal(target)).toContain('d365fo-mcp setup');
  });

  it('allows a pin whose config file exists, even when newer ones exist too', () => {
    // A version update leaves the old config in place; that pin still resolves.
    writeXppConfig('contoso-dev___10.0.2428.63');
    writeXppConfig('contoso-dev___10.0.2500.7');
    const target = makeTarget({ type: 'ude', xppConfigName: 'contoso-dev___10.0.2428.63' });

    expect(staleXppConfigRefusal(target)).toBeNull();
  });

  it('allows a target with no pin, and a traditional target', () => {
    writeXppConfig('contoso-dev___10.0.2500.7');

    expect(staleXppConfigRefusal(makeTarget({ type: 'ude' }))).toBeNull();
    expect(staleXppConfigRefusal(makeTarget({ type: 'traditional', xppConfigName: 'contoso-dev___10.0.2428.63' })))
      .toBeNull();
  });
});

describe('rebuildIndex with a stale pin', () => {
  it('returns false without running the extraction or the database build', async () => {
    writeXppConfig('contoso-dev___10.0.2500.7');
    const target = makeTarget({ type: 'ude', xppConfigName: 'contoso-dev___10.0.2428.63' });

    expect(await rebuildIndex(target)).toBe(false);
    expect(runNode).not.toHaveBeenCalled();
  });
});
