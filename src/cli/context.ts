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
 * True when the CLI runs from a git checkout — sources, devDependencies (tsx)
 * and `git pull` are all available, so setup/update/index run the TypeScript
 * directly.
 */
export const isGitCheckout = fs.existsSync(resolve(repoRoot, '.git'));

/**
 * How this copy was installed, which decides how the same commands do their
 * work:
 *
 *   git — a checkout: index scripts run from scripts/*.ts through tsx, and
 *         `update` is git pull + npm install + npm run build.
 *   npm — installed from the registry: there are no sources and no tsx, so the
 *         index scripts run as the bundles under dist/scripts/, and `update`
 *         is `npm install -g d365fo-mcp@latest`.
 *
 * A copy that is neither (an npx cache of a release published before the
 * bundles existed) reports 'npm' but fails `isFullInstall` below, so the user
 * is pointed at the installer instead of failing halfway through a rebuild.
 */
export type InstallMode = 'git' | 'npm';
export const installMode: InstallMode = isGitCheckout ? 'git' : 'npm';

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
  /** esbuild bundles of the two scripts above — what an npm install ships instead of the sources. */
  extractScriptDist: resolve(repoRoot, 'dist', 'scripts', 'extract-metadata.js'),
  buildDbScriptDist: resolve(repoRoot, 'dist', 'scripts', 'build-database.js'),
} as const;

/**
 * True when this copy can rebuild an index — the one capability that separates
 * a full installation from a bare `npx d365fo-mcp connect` client.
 */
export const isFullInstall = isGitCheckout || fs.existsSync(paths.extractScriptDist);

export const isWindows = process.platform === 'win32';
