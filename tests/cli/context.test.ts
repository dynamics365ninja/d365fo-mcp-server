/**
 * Where an installation keeps its state.
 *
 * Two things are load-bearing here. First, a git checkout must keep behaving
 * exactly as it did before the npm-install layout existed: config/, data/ and
 * instances/ in the checkout, no pointer file involved. Every existing
 * installation is a checkout, so a regression here silently relocates a user's
 * configuration and their multi-gigabyte index.
 *
 * Second, the pointer file is the only thing that survives `npm install -g
 * d365fo-mcp@latest` — it is what lets the new package find the installation
 * the old one set up. A corrupt pointer must degrade to "not configured yet",
 * never to a crash, because `connect` has to keep working without either.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  dataRoot,
  installMode,
  isGitCheckout,
  paths,
  readInstallPointer,
  repoRoot,
  writeInstallPointer,
} from '../../src/cli/context.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'd365fo-context-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('data root in a checkout', () => {
  // The suite runs from the checkout, so this is the real thing rather than a
  // simulation of it.
  it('is the checkout itself', () => {
    expect(isGitCheckout).toBe(true);
    expect(installMode).toBe('git');
    expect(dataRoot()).toBe(repoRoot);
  });

  it('keeps config, data and instances on their historical paths', () => {
    expect(paths.rootConfig).toBe(resolve(repoRoot, 'config', 'd365fo-mcp.json'));
    expect(paths.rootSecrets).toBe(resolve(repoRoot, 'config', 'secrets.json'));
    expect(paths.rootEnv).toBe(resolve(repoRoot, '.env'));
    expect(paths.instancesDir).toBe(resolve(repoRoot, 'instances'));
    expect(paths.defaultDb).toBe(resolve(repoRoot, 'data', 'xpp-metadata.db'));
  });

  it('resolves code paths against the package, not the data directory', () => {
    expect(paths.distEntry).toBe(resolve(repoRoot, 'dist', 'index.js'));
    expect(paths.bridgeExe).toBe(
      resolve(repoRoot, 'bridge', 'D365MetadataBridge', 'bin', 'Release', 'D365MetadataBridge.exe'),
    );
  });
});

describe('install pointer', () => {
  it('round-trips the data directory', () => {
    const file = join(tmp, 'state', 'install.json');
    const target = join(tmp, 'installation');
    writeInstallPointer(file, target);
    expect(readInstallPointer(file)).toBe(target);
  });

  it('creates both the data directory and the pointer folder', () => {
    const file = join(tmp, 'deep', 'state', 'install.json');
    const target = join(tmp, 'deep', 'installation');
    writeInstallPointer(file, target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('reports "unset" for a missing, corrupt or empty pointer', () => {
    expect(readInstallPointer(join(tmp, 'absent.json'))).toBeNull();

    const corrupt = join(tmp, 'corrupt.json');
    fs.writeFileSync(corrupt, '{ this is not json', 'utf8');
    expect(readInstallPointer(corrupt)).toBeNull();

    const empty = join(tmp, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ dataRoot: '' }), 'utf8');
    expect(readInstallPointer(empty)).toBeNull();

    const wrongType = join(tmp, 'wrong.json');
    fs.writeFileSync(wrongType, JSON.stringify({ dataRoot: 42 }), 'utf8');
    expect(readInstallPointer(wrongType)).toBeNull();
  });
});
