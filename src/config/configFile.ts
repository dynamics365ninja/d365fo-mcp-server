/**
 * Structured configuration file — config/d365fo-mcp.json (+ config/secrets.json).
 *
 * Replaces hand-editing .env: `npm run setup` writes these files and the server
 * projects them onto process.env at startup, so every consumer keeps reading the
 * same environment variables it always has (see src/config/settings.ts for the
 * mapping).
 *
 * Precedence at runtime — first one that defines a variable wins:
 *   1. the real environment (shell, .mcp.json env{} block, Azure App Settings)
 *   2. config/d365fo-mcp.json + config/secrets.json
 *   3. a legacy .env file, still honoured so existing installations keep working
 *
 * Lookup order for the config file itself:
 *   1. D365FO_CONFIG (explicit path to a .json file)
 *   2. <dir of the active .env>/d365fo-mcp.json      — instance layout
 *   3. <dir of the active .env>/config/d365fo-mcp.json — repo layout
 */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { SETTINGS, serializeValue, type Setting } from './settings.js';

/** Bumped only when the on-disk shape changes in a way the loader must handle. */
export const CONFIG_VERSION = 1;

export type ConfigObject = Record<string, any>;

export interface ResolvedConfigFiles {
  /** Directory holding the config file itself. */
  dir: string;
  /** Project directory — what relative paths resolve from (see configBaseDir). */
  baseDir: string;
  configPath: string;
  secretsPath: string;
  config: ConfigObject | null;
  secrets: ConfigObject | null;
}

export function getAtPath(obj: ConfigObject | null | undefined, path: string): unknown {
  if (!obj) return undefined;
  return path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function setAtPath(obj: ConfigObject, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let cursor = obj;
  for (const key of keys) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  if (value === undefined || value === null || value === '') {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
}

/** Candidate config paths for a given base directory (the .env directory). */
export function configCandidates(baseDir: string): string[] {
  return [join(baseDir, 'd365fo-mcp.json'), join(baseDir, 'config', 'd365fo-mcp.json')];
}

function readJson(file: string): ConfigObject | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch (err) {
    // A malformed config must be loud but must not prevent the server from
    // starting on .env alone — it writes to stderr, never stdout (stdio mode).
    process.stderr.write(`[config] Cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

/**
 * Locate and read the config + secrets pair.
 * `baseDir` is the directory of the active .env file (repo root, or an instance folder).
 *
 * `allowEnvOverride` is what the running server wants (D365FO_CONFIG points it
 * at one specific instance); the CLI passes false, since it manages several
 * targets in one process and must not collapse them all onto that one file.
 */
export function resolveConfigFiles(baseDir: string, opts?: { allowEnvOverride?: boolean }): ResolvedConfigFiles {
  const explicit = opts?.allowEnvOverride === false ? undefined : process.env.D365FO_CONFIG?.trim();
  const configPath = explicit
    ? resolve(explicit)
    : configCandidates(baseDir).find(p => fs.existsSync(p)) ?? join(baseDir, 'config', 'd365fo-mcp.json');

  const dir = dirname(configPath);
  return {
    dir,
    baseDir: configBaseDir(configPath),
    configPath,
    secretsPath: join(dir, 'secrets.json'),
    config: readJson(configPath),
    secrets: readJson(join(dir, 'secrets.json')),
  };
}

/**
 * Directory a relative path setting (./data/xpp-metadata.db) resolves from:
 * the folder that owns the deployment, not the folder that happens to hold the
 * JSON. For the repo layout config/d365fo-mcp.json that is the repo root; for
 * instances/<name>/d365fo-mcp.json it is the instance folder. Keeping paths
 * relative is what lets an instance folder be renamed or moved.
 */
export function configBaseDir(configPath: string): string {
  const dir = dirname(configPath);
  return basename(dir).toLowerCase() === 'config' ? dirname(dir) : dir;
}

/**
 * Flatten config + secrets into the environment variables the runtime reads.
 * Relative `path`-typed values are resolved against `baseDir` so a config file
 * can use portable values like ./data/xpp-metadata.db.
 */
export function toEnvRecord(files: Pick<ResolvedConfigFiles, 'baseDir' | 'config' | 'secrets'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setting of SETTINGS) {
    const source = setting.tier === 'secret' ? files.secrets : files.config;
    const raw = getAtPath(source, setting.path);
    const value = serializeValue(setting, raw);
    if (value === null) continue;
    out[setting.env] = setting.type === 'path' && !isAbsolute(value) ? resolve(files.baseDir, value) : value;
  }
  return out;
}

/**
 * The path settings the wizard never writes, resolved against `baseDir`.
 *
 * DB_PATH, LABELS_DB_PATH and METADATA_PATH are advanced settings with
 * relative defaults, so a normal setup leaves them out of the config file
 * entirely and every consumer falls back to its own `'./data/…'` literal —
 * which resolves from process.cwd(). For a git checkout that is the repo, and
 * the answer happens to be right. For an npm install it is the *package*
 * directory: `d365fo-mcp index` spawns the build scripts with cwd = repoRoot,
 * so a 2 GB index landed next to the installed package, on whatever drive npm
 * lives on, instead of in the installation directory the user chose in setup
 * (issue: build ran out of space on C: and SQLite aborted the transaction).
 *
 * Emitting the defaults here pins them to the installation directory instead.
 * A checkout is its own data directory, so its paths do not move.
 */
export function defaultPathEnv(baseDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setting of SETTINGS) {
    if (setting.type !== 'path' || typeof setting.default !== 'string' || setting.default === '') continue;
    out[setting.env] = isAbsolute(setting.default) ? setting.default : resolve(baseDir, setting.default);
  }
  return out;
}

/** Write the config file, creating its directory. Keys are emitted in registry order. */
export function writeConfigFile(configPath: string, config: ConfigObject): void {
  fs.mkdirSync(dirname(configPath), { recursive: true });
  const ordered: ConfigObject = { version: CONFIG_VERSION };
  for (const setting of SETTINGS) {
    if (setting.tier === 'secret') continue;
    const value = getAtPath(config, setting.path);
    if (value !== undefined && value !== null && value !== '') setAtPath(ordered, setting.path, value);
  }
  fs.writeFileSync(configPath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

/** Write secrets.json with owner-only permissions where the platform supports them. */
export function writeSecretsFile(secretsPath: string, secrets: ConfigObject): void {
  fs.mkdirSync(dirname(secretsPath), { recursive: true });
  const ordered: ConfigObject = {};
  for (const setting of SETTINGS) {
    if (setting.tier !== 'secret') continue;
    const value = getAtPath(secrets, setting.path);
    if (value !== undefined && value !== null && value !== '') setAtPath(ordered, setting.path, value);
  }
  if (Object.keys(ordered).length === 0) {
    if (fs.existsSync(secretsPath)) fs.rmSync(secretsPath);
    return;
  }
  fs.writeFileSync(secretsPath, JSON.stringify(ordered, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** Settings whose value in the config differs from what the environment already provides. */
export function shadowedSettings(env: NodeJS.ProcessEnv, envRecord: Record<string, string>): Setting[] {
  return SETTINGS.filter(s => {
    const fromEnv = env[s.env];
    return fromEnv !== undefined && envRecord[s.env] !== undefined && fromEnv !== envRecord[s.env];
  });
}
