/**
 * CLI context — the two roots every command resolves against.
 *
 * `repoRoot` is where the *code* lives. The CLI runs either from src/cli (tsx
 * during development) or dist/cli (built); both are exactly two levels below
 * it, so resolve relative to this file rather than process.cwd() — the CLI is
 * invoked from arbitrary directories.
 *
 * `dataRoot` is where *this installation's* configuration, metadata index and
 * instances live. In a git checkout the two are the same directory and nothing
 * about the old layout changes. An npm install has to separate them: `npm
 * install -g d365fo-mcp@latest` replaces the package directory wholesale, so a
 * config file or a 2 GB index kept inside it would not survive a single
 * update. There the setup wizard asks for a directory and records it in a
 * pointer file kept outside the package, which is how the next version finds
 * the same installation again.
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

export const isWindows = process.platform === 'win32';

/**
 * Per-user state directory — holds the pointer file, and nothing else.
 *
 * It must sit outside both roots: outside the package because an update
 * deletes that, and outside the data directory because the pointer is what
 * locates the data directory in the first place.
 */
function stateDir(): string {
  const local = process.env.LOCALAPPDATA;
  if (isWindows && local) return resolve(local, 'd365fo-mcp');
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return resolve(xdg, 'd365fo-mcp');
  return resolve(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.config', 'd365fo-mcp');
}

/** Records which directory holds this user's installation. */
export const installPointerFile = resolve(stateDir(), 'install.json');

/**
 * The data directory named by a pointer file, or null.
 *
 * Every failure collapses to null on purpose: the file is absent before the
 * first setup, and a truncated or hand-edited one is no more usable than a
 * missing one. Throwing here would break `connect`, which needs neither.
 */
export function readInstallPointer(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { dataRoot?: unknown };
    return typeof parsed.dataRoot === 'string' && parsed.dataRoot.length > 0 ? parsed.dataRoot : null;
  } catch {
    return null;
  }
}

/** Record `dir` as the data directory, creating both it and the pointer's folder. */
export function writeInstallPointer(file: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dataRoot: dir }, null, 2) + '\n', 'utf8');
}

/**
 * Default data directory for an npm install that has not been set up yet.
 * Deliberately not under the package, and not the current directory — the CLI
 * is run from wherever the user happens to be standing.
 */
function defaultDataRoot(): string {
  return resolve(stateDir(), 'installation');
}

function resolveDataRoot(): string {
  // A checkout is self-contained: config/, data/ and instances/ live in it and
  // survive `git pull`, so it never consults the pointer file. This is what
  // keeps every existing installation on exactly its current paths.
  if (installMode === 'git') return repoRoot;
  const override = process.env.D365FO_MCP_HOME?.trim();
  if (override) return resolve(override);
  return readInstallPointer(installPointerFile) ?? defaultDataRoot();
}

let currentDataRoot = resolveDataRoot();

/** Where this installation keeps its configuration, index and instances. */
export function dataRoot(): string {
  return currentDataRoot;
}

/**
 * Point this installation at `dir` and remember it for future runs.
 *
 * Only meaningful for an npm install; a checkout is its own data directory and
 * calling this on one would split it in two.
 */
export function setDataRoot(dir: string): void {
  const target = resolve(dir);
  writeInstallPointer(installPointerFile, target);
  currentDataRoot = target;
}

/**
 * Paths every command works from.
 *
 * Getters rather than plain strings: `setDataRoot` runs in the middle of the
 * setup wizard, and the entries below it must reflect the directory the user
 * just chose, not the one that was current when this module was imported.
 */
export const paths = {
  /** Legacy configuration file — still read as a fallback, no longer written. */
  get rootEnv(): string { return resolve(currentDataRoot, '.env'); },
  get rootConfig(): string { return resolve(currentDataRoot, 'config', 'd365fo-mcp.json'); },
  get rootSecrets(): string { return resolve(currentDataRoot, 'config', 'secrets.json'); },
  get instancesDir(): string { return resolve(currentDataRoot, 'instances'); },
  get defaultDb(): string { return resolve(currentDataRoot, 'data', 'xpp-metadata.db'); },
  get defaultLabelsDb(): string { return resolve(currentDataRoot, 'data', 'xpp-metadata-labels.db'); },
  /** Where the wizard drops the ready-to-paste .mcp.json block. */
  get mcpSuggestion(): string { return resolve(currentDataRoot, 'mcp-config-suggestion.json'); },

  // Code — always in the package, never in the data directory.
  distEntry: resolve(repoRoot, 'dist', 'index.js'),
  bridgeDir: resolve(repoRoot, 'bridge', 'D365MetadataBridge'),
  bridgeExe: resolve(repoRoot, 'bridge', 'D365MetadataBridge', 'bin', 'Release', 'D365MetadataBridge.exe'),
  extractScript: resolve(repoRoot, 'scripts', 'extract-metadata.ts'),
  buildDbScript: resolve(repoRoot, 'scripts', 'build-database.ts'),
  /** esbuild bundles of the two scripts above — what an npm install ships instead of the sources. */
  extractScriptDist: resolve(repoRoot, 'dist', 'scripts', 'extract-metadata.js'),
  buildDbScriptDist: resolve(repoRoot, 'dist', 'scripts', 'build-database.js'),
};

/**
 * True when this copy can rebuild an index — the one capability that separates
 * a full installation from a bare `npx d365fo-mcp connect` client.
 */
export const isFullInstall = isGitCheckout || fs.existsSync(paths.extractScriptDist);
