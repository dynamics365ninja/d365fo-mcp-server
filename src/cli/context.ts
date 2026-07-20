/**
 * CLI context — repo-root resolution shared by all commands.
 *
 * The CLI runs either from src/cli (tsx during development) or dist/cli
 * (built). Both are exactly two levels below the repo root, so resolve
 * relative to this file rather than process.cwd() — developers invoke the
 * CLI from arbitrary directories.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __cliDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(__cliDir, '../..');

/**
 * True when the CLI runs from a git checkout — the only supported layout for
 * setup/update/index. Those commands need scripts/, devDependencies (tsx) and
 * `git pull`, none of which exist when the package runs from the npx cache or
 * a release tarball.
 */
export const isGitCheckout = fs.existsSync(resolve(repoRoot, '.git'));

/** Bootstrap one-liner printed when a command needs a full installation. */
export const installOneLiner =
  'irm https://raw.githubusercontent.com/dynamics365ninja/d365fo-mcp-server/main/install.ps1 | iex';

export const paths = {
  /** Legacy configuration file — still read as a fallback, no longer written. */
  rootEnv: resolve(repoRoot, '.env'),
  rootConfig: resolve(repoRoot, 'config', 'd365fo-mcp.json'),
  rootSecrets: resolve(repoRoot, 'config', 'secrets.json'),
  instancesDir: resolve(repoRoot, 'instances'),
  distEntry: resolve(repoRoot, 'dist', 'index.js'),
  defaultDb: resolve(repoRoot, 'data', 'xpp-metadata.db'),
  defaultLabelsDb: resolve(repoRoot, 'data', 'xpp-metadata-labels.db'),
  bridgeDir: resolve(repoRoot, 'bridge', 'D365MetadataBridge'),
  bridgeExe: resolve(repoRoot, 'bridge', 'D365MetadataBridge', 'bin', 'Release', 'D365MetadataBridge.exe'),
  extractScript: resolve(repoRoot, 'scripts', 'extract-metadata.ts'),
  buildDbScript: resolve(repoRoot, 'scripts', 'build-database.ts'),
} as const;

export const isWindows = process.platform === 'win32';
