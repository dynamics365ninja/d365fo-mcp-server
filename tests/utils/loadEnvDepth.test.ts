/**
 * Configuration discovery from callers at different depths.
 *
 * `loadEnv` used to assume every caller sits exactly one level below the
 * installation root — true for `dist/index.js` and for `scripts/*.ts`, but not
 * for their esbuild bundles at `dist/scripts/*.js`. A bundle therefore looked
 * for `dist/config/`, found nothing, and fell through to every built-in
 * default: the wrong packages path, and the default DB_PATH, so a standalone
 * run would write beside the real index rather than the configured one.
 *
 * Both depths are pinned here because the shallow one is the regression risk:
 * the search must still match on its first try for callers that already
 * resolved correctly.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnv } from '../../src/utils/loadEnv.js';

let tmp: string;
let savedEnv: NodeJS.ProcessEnv;

/**
 * A distinctive packages path that is absolute on this platform.
 *
 * It has to be: a relative packagePath is resolved against the config's own
 * directory, which is correct behaviour but would make the assertions below
 * measure that resolution rather than which config was found. A literal
 * `K:\...` is absolute on Windows and relative everywhere else, so hard-coding
 * one passes locally and fails on the Linux CI runner.
 */
function packagesPath(name: string): string {
  return resolve(tmp, name, 'PackagesLocalDirectory');
}

/** An installation root holding a config that names a distinctive path. */
function makeInstall(packagePath: string): string {
  const root = fs.mkdtempSync(join(tmp, 'install-'));
  writeConfig(root, packagePath);
  return root;
}

/** Write config/d365fo-mcp.json under `root`. */
function writeConfig(root: string, packagePath: string): void {
  fs.mkdirSync(join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    join(root, 'config', 'd365fo-mcp.json'),
    JSON.stringify({ version: 1, environment: { type: 'traditional', packagePath } }),
    'utf8',
  );
}

/** Call loadEnv as if from a module living at `<root>/<...segments>/mod.js`. */
function loadFrom(root: string, ...segments: string[]): void {
  const dir = join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  loadEnv(pathToFileURL(join(dir, 'mod.js')).href);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'd365fo-loadenv-'));
  savedEnv = { ...process.env };
  // loadEnv treats anything already set as a real environment variable that
  // outranks the config, which would mask what this test is measuring.
  delete process.env.D365FO_PACKAGE_PATH;
  delete process.env.ENV_FILE;
  delete process.env.D365FO_CONFIG;
});

afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loadEnv config discovery', () => {
  it('finds the config from one level down (server at dist/, scripts at scripts/)', () => {
    const expected = packagesPath('one');
    const root = makeInstall(expected);
    loadFrom(root, 'dist');
    expect(process.env.D365FO_PACKAGE_PATH).toBe(expected);
  });

  it('finds the config from two levels down (bundles at dist/scripts/)', () => {
    const expected = packagesPath('two');
    const root = makeInstall(expected);
    loadFrom(root, 'dist', 'scripts');
    expect(process.env.D365FO_PACKAGE_PATH).toBe(expected);
  });

  it('prefers the nearest installation when one is nested inside another', () => {
    // Guards the upward walk against climbing past the installation it is in.
    const outer = makeInstall(packagesPath('outer'));
    const expected = packagesPath('inner');
    const inner = join(outer, 'inner');
    writeConfig(inner, expected);
    loadFrom(inner, 'dist');
    expect(process.env.D365FO_PACKAGE_PATH).toBe(expected);
  });

  it('leaves the variable unset when there is no configuration anywhere', () => {
    const bare = fs.mkdtempSync(join(tmp, 'bare-'));
    loadFrom(bare, 'dist', 'scripts');
    expect(process.env.D365FO_PACKAGE_PATH).toBeUndefined();
  });

  it('still lets an explicit ENV_FILE win over discovery', () => {
    const root = makeInstall(packagesPath('from-config'));
    const pinned = packagesPath('from-env-file');
    const envFile = join(tmp, 'pinned.env');
    fs.writeFileSync(envFile, `D365FO_PACKAGE_PATH=${pinned}\n`, 'utf8');
    process.env.ENV_FILE = envFile;
    loadFrom(root, 'dist', 'scripts');
    expect(process.env.D365FO_PACKAGE_PATH).toBe(pinned);
  });
});
