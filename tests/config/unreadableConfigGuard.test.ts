/**
 * An unreadable config file must stop the index pipeline, not silently fall
 * back to defaults.
 *
 * A config.json with one unescaped backslash in a path (`"K:\AosService\..."`)
 * does not parse. The loader logged one "[config] Cannot parse" line and
 * carried on with every setting at its default. For `d365fo-mcp index` the
 * default extract mode is "all", so a custom rebuild of minutes became a full
 * extraction of the whole packages path that wiped the metadata folder and the
 * database. A later save from the CLI would also have overwritten the broken
 * file with only the values that run had written.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runNode = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../../src/cli/exec.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/cli/exec.js')>()),
  runNode,
}));

import { resolveConfigFiles } from '../../src/config/configFile.js';
import { openStore, saveStore, unreadableConfigRefusal, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';
import { rebuildIndex } from '../../src/cli/commands/indexCmd.js';
import type { Target } from '../../src/cli/target.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
/** What a hand-edited Windows path looks like when the backslashes are not doubled. */
const BROKEN = '{ "environment": { "packagePath": "K:\\AosService\\PackagesLocalDirectory" } }';

let root: string;
const ORIGINAL_D365FO_CONFIG = process.env.D365FO_CONFIG;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'unreadable-config-'));
  runNode.mockClear();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_D365FO_CONFIG === undefined) delete process.env.D365FO_CONFIG;
  else process.env.D365FO_CONFIG = ORIGINAL_D365FO_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(content: string, name = 'd365fo-mcp.json'): string {
  const file = join(root, 'config', name);
  fs.mkdirSync(join(root, 'config'), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('resolveConfigFiles reports what it could not read', () => {
  it('names an unparseable config, a non-object one and an unparseable secrets file', () => {
    const config = writeConfig(BROKEN);
    const secrets = writeConfig('{ "sql": ', 'secrets.json');
    const files = resolveConfigFiles(root, { allowEnvOverride: false });

    expect(files.config).toBeNull();
    expect(files.unreadable.map(u => u.file)).toEqual([config, secrets]);

    writeConfig('["not", "an", "object"]');
    fs.rmSync(secrets);
    expect(resolveConfigFiles(root, { allowEnvOverride: false }).unreadable)
      .toEqual([{ file: config, error: 'not a JSON object' }]);
  });

  it('names a D365FO_CONFIG that points at no file, and nothing for a readable or absent config', () => {
    process.env.D365FO_CONFIG = join(root, 'typo', 'd365fo-mcp.json');
    expect(resolveConfigFiles(root).unreadable[0]?.error).toMatch(/does not exist/);
    delete process.env.D365FO_CONFIG;

    expect(resolveConfigFiles(root, { allowEnvOverride: false }).unreadable).toEqual([]);
    writeConfig('{ "environment": { "packagePath": "K:/AosService/PackagesLocalDirectory" } }');
    expect(resolveConfigFiles(root, { allowEnvOverride: false }).unreadable).toEqual([]);
  });
});

describe('the CLI does not act on an unreadable config', () => {
  it('saveStore refuses, so the broken file survives to be repaired', () => {
    const file = writeConfig(BROKEN);
    const store = openStore(root, null);
    writeSetting(store, settingByPath('workspace.modelName')!, 'ContosoExt');

    expect(unreadableConfigRefusal(store)).toMatch(/cannot be read/);
    expect(() => saveStore(store)).toThrow(/cannot be read/);
    expect(fs.readFileSync(file, 'utf8')).toBe(BROKEN);
  });

  it('rebuildIndex returns false before any script runs', async () => {
    writeConfig(BROKEN);
    const target: Target = { name: 'root', label: 'root server', envFile: null, store: openStore(root, null), port: null };

    expect(await rebuildIndex(target)).toBe(false);
    expect(runNode).not.toHaveBeenCalled();
  });
});

describe('the index scripts refuse an unreadable config', () => {
  it('extract-metadata exits 1 and leaves the metadata folder alone', () => {
    const config = writeConfig(BROKEN);
    const metadata = join(root, 'extracted-metadata');
    fs.mkdirSync(join(metadata, 'ContosoExt'), { recursive: true });
    fs.writeFileSync(join(metadata, 'ContosoExt', 'marker.json'), '{}');

    const r = spawnSync(process.execPath, ['--import', 'tsx/esm', join(REPO_ROOT, 'scripts', 'extract-metadata.ts')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      // METADATA_PATH from the real environment, as an instance run passes it:
      // without the guard, the default extract mode "all" deletes this folder.
      env: { ...process.env, D365FO_CONFIG: config, METADATA_PATH: metadata, EXTRACT_MODE: '', NO_COLOR: '1' },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing to run');
    expect(r.stderr).toContain(config);
    expect(fs.existsSync(join(metadata, 'ContosoExt', 'marker.json'))).toBe(true);
  }, 90_000);
});
