/**
 * Instance discovery — which directories under instances/ count as an instance,
 * and where a new one's configuration is written.
 *
 * Load-bearing because the two halves have to agree: `instance add` writes a
 * config file, and every other command (list, run, rebuild, upgrade) finds the
 * instance again only by looking for that same file. When they disagreed the
 * wizard produced an instance its own management commands reported as "not
 * found" — the config went to instances/<name>/config/d365fo-mcp.json while
 * discovery looked at instances/<name>/d365fo-mcp.json.
 *
 * The data root is mocked to a temp directory: the suite runs from a checkout,
 * where paths.instancesDir is the real instances/ folder of the repo.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInstance, getInstance, listInstances } from '../../src/cli/instances.js';
import { writeConfigFile } from '../../src/config/configFile.js';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../../src/cli/context.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/cli/context.js')>();
  return {
    ...actual,
    dataRoot: () => state.root,
    // A getter, like the real one: state.root changes between tests.
    paths: { ...actual.paths, get instancesDir() { return join(state.root, 'instances'); } },
  };
});

const instanceDir = (name: string) => join(state.root, 'instances', name);

beforeEach(() => {
  state.root = fs.mkdtempSync(join(os.tmpdir(), 'd365fo-instances-'));
});

afterEach(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('listInstances', () => {
  it('is empty when nothing has been created yet', () => {
    expect(listInstances()).toEqual([]);
  });

  it('finds an instance in the top-level layout and reads its port', () => {
    writeConfigFile(join(instanceDir('alpha'), 'd365fo-mcp.json'), { server: { port: 3005 } });

    const [alpha] = listInstances();
    expect(alpha.name).toBe('alpha');
    expect(alpha.configFile).toBe(join(instanceDir('alpha'), 'd365fo-mcp.json'));
    expect(alpha.port).toBe(3005);
  });

  it('finds an instance an older build wrote under config/', () => {
    // Regression: this layout was invisible, so `instance list`, `run`,
    // `rebuild` and `upgrade` all reported the instance as not found.
    writeConfigFile(join(instanceDir('legacy'), 'config', 'd365fo-mcp.json'), { server: { port: 3006 } });

    const [legacy] = listInstances();
    expect(legacy.name).toBe('legacy');
    expect(legacy.configFile).toBe(join(instanceDir('legacy'), 'config', 'd365fo-mcp.json'));
    expect(legacy.port).toBe(3006);
    expect(getInstance('legacy')).toBeDefined();
  });

  it('prefers the top-level config when both layouts are present', () => {
    writeConfigFile(join(instanceDir('both'), 'd365fo-mcp.json'), { server: { port: 3007 } });
    writeConfigFile(join(instanceDir('both'), 'config', 'd365fo-mcp.json'), { server: { port: 9999 } });

    const [both] = listInstances();
    expect(both.configFile).toBe(join(instanceDir('both'), 'd365fo-mcp.json'));
    expect(both.port).toBe(3007);
  });

  it('still recognises an instance configured by a legacy .env alone', () => {
    fs.mkdirSync(instanceDir('envonly'), { recursive: true });
    fs.writeFileSync(join(instanceDir('envonly'), '.env'), 'PORT=3008\n', 'utf8');

    const [envOnly] = listInstances();
    expect(envOnly.name).toBe('envonly');
    expect(envOnly.port).toBe(3008);
  });

  it('ignores a directory that holds neither a config nor a .env', () => {
    fs.mkdirSync(join(instanceDir('empty'), 'data'), { recursive: true });
    expect(listInstances()).toEqual([]);
  });
});

describe('createInstance', () => {
  it('writes the config where listInstances looks for it', () => {
    const created = createInstance('fresh', 3010);

    expect(created.configFile).toBe(join(instanceDir('fresh'), 'd365fo-mcp.json'));
    expect(fs.existsSync(join(instanceDir('fresh'), 'config', 'd365fo-mcp.json'))).toBe(false);
    expect(fs.existsSync(join(instanceDir('fresh'), 'data'))).toBe(true);
    expect(fs.existsSync(join(instanceDir('fresh'), 'metadata'))).toBe(true);

    const found = getInstance('fresh');
    expect(found?.port).toBe(3010);
    expect(found?.configFile).toBe(created.configFile);
  });

  it('refuses to clobber an instance that already exists in either layout', () => {
    writeConfigFile(join(instanceDir('top'), 'd365fo-mcp.json'), { server: { port: 3011 } });
    writeConfigFile(join(instanceDir('old'), 'config', 'd365fo-mcp.json'), { server: { port: 3012 } });

    expect(() => createInstance('top', 3020)).toThrow(/already exists/);
    expect(() => createInstance('old', 3021)).toThrow(/already exists/);
    // The existing configuration is untouched by the refused create.
    expect(getInstance('old')?.port).toBe(3012);
  });
});
