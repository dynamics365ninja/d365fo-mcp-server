/**
 * Configuration loader: structured JSON config first, legacy .env as fallback.
 *
 * `npm run setup` writes config/d365fo-mcp.json (+ config/secrets.json); this
 * module projects it onto process.env so every consumer keeps reading plain
 * environment variables. Precedence, highest first:
 *
 *   1. the real environment — shell, .mcp.json env{} block, Azure App Settings
 *   2. a .env named explicitly via ENV_FILE (an instance or eval profile the
 *      caller picked on purpose)
 *   3. config/d365fo-mcp.json + config/secrets.json
 *   4. the ambient repo-root .env (pre-wizard installations keep working)
 *   5. the built-in defaults for path settings, resolved against the
 *      installation directory (see defaultPathEnv)
 *
 * Multiple instances run from one source folder by pointing each at its own
 * config or .env file:
 *
 *   D365FO_CONFIG=instances/alpha/d365fo-mcp.json node dist/index.js
 *   ENV_FILE=.env.alpha  npm run build-database
 *
 * Relative paths in DB_PATH, LABELS_DB_PATH, and METADATA_PATH are resolved
 * relative to the config (or .env) file's directory, so instance files can use
 * portable paths like ./data/xpp-metadata.db that survive folder renames.
 */

import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defaultPathEnv, resolveConfigFiles, toEnvRecord } from '../config/configFile.js';

/** Env vars whose relative paths should resolve from the .env file directory. */
const PATH_VARS = ['DB_PATH', 'LABELS_DB_PATH', 'METADATA_PATH'] as const;

/**
 * The installation directory a module should read its configuration from.
 *
 * Callers sit at different depths: the server is `dist/index.js` and the index
 * scripts are `scripts/*.ts` in a checkout, all one level down — but their
 * bundled counterparts are `dist/scripts/*.js`, two levels down. Assuming one
 * level, as this used to, made a bundle look for `dist/config/` and silently
 * fall through to every default: the wrong packages path, and worse, the
 * default DB_PATH, so a standalone run would write beside the real index
 * instead of the configured one.
 *
 * The search starts one level up, so any caller that resolved correctly before
 * still matches on the first try and nothing about its behaviour changes. Only
 * a caller that finds nothing keeps climbing, and only for two more levels —
 * enough for `dist/scripts`, and short enough that a machine with no
 * configuration at all cannot wander into an unrelated directory above the
 * installation.
 */
function installRootFrom(callerDir: string): string {
  let dir = resolve(callerDir, '..');
  for (let up = 0; up < 3; up++) {
    const hasConfig = existsSync(join(dir, 'config', 'd365fo-mcp.json'))
      || existsSync(join(dir, 'd365fo-mcp.json'))
      || existsSync(join(dir, '.env'));
    if (hasConfig) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing found: keep the historical answer, so the caller ends up reporting
  // a missing file at the path it always looked at.
  return resolve(callerDir, '..');
}

/**
 * Load environment variables from a .env file.
 *
 * @param callerImportMetaUrl - pass `import.meta.url` from the calling module
 *   so the default .env path resolves relative to the repo root regardless of
 *   the process working directory.
 */
export function loadEnv(callerImportMetaUrl: string): void {
  const callerDir = dirname(fileURLToPath(callerImportMetaUrl));

  const envPath = process.env.ENV_FILE
    ? resolve(process.env.ENV_FILE)
    : resolve(installRootFrom(callerDir), '.env');

  // Everything already present is a real environment variable (shell, .mcp.json
  // env{} block, App Settings) and outranks both files below.
  const fromRealEnv = new Set(Object.keys(process.env));

  // quiet: true suppresses dotenv v17's stdout logging, which would otherwise
  // corrupt the MCP JSON-RPC channel in stdio mode (writes to process.stdout
  // before the MCP stdio redirects are set up).
  const result = dotenv.config({ path: envPath, quiet: true });
  if (result.error && !process.env.ENV_FILE) {
    // Only fall back to process.cwd() when ENV_FILE wasn't explicitly set;
    // an explicit-but-missing file should surface as an error, not fall back silently.
    dotenv.config({ quiet: true });
  }

  // Resolve relative paths in key variables relative to the .env file's
  // directory, not process.cwd(). This makes instance .env files portable.
  const envDir = dirname(envPath);
  for (const key of PATH_VARS) {
    const val = process.env[key];
    if (val && !isAbsolute(val)) {
      process.env[key] = resolve(envDir, val);
    }
  }

  // The structured config wins over an ambient .env — the wizard writes it, so a
  // stale .env left over from a manual installation must not silently override
  // the answers the user just gave. Two things still outrank it: the real
  // environment, and a .env the caller asked for by name (ENV_FILE=.env.eval
  // picks that file deliberately, and no D365FO_CONFIG was given to go with it).
  const pinnedByEnvFile = process.env.ENV_FILE && !process.env.D365FO_CONFIG
    ? new Set(Object.keys(result.parsed ?? {}))
    : new Set<string>();

  const files = resolveConfigFiles(envDir);
  for (const [key, value] of Object.entries(toEnvRecord(files))) {
    if (!fromRealEnv.has(key) && !pinnedByEnvFile.has(key)) process.env[key] = value;
  }

  // Lowest precedence of all: the defaults for the path settings nobody writes
  // out, anchored to the installation directory rather than process.cwd(). See
  // defaultPathEnv — without this the index of an npm install is built beside
  // the package instead of in the directory chosen during setup.
  for (const [key, value] of Object.entries(defaultPathEnv(files.baseDir))) {
    if (!process.env[key]) process.env[key] = value;
  }

  // Bridge the public D365FO_-prefixed setting name to the internal
  // DEV_ENVIRONMENT_TYPE that consumers read. Prefixed wins when both are set;
  // a lone plain entry is tolerated for backward compatibility.
  if (process.env.D365FO_DEV_ENVIRONMENT_TYPE) {
    process.env.DEV_ENVIRONMENT_TYPE = process.env.D365FO_DEV_ENVIRONMENT_TYPE;
  }
}
