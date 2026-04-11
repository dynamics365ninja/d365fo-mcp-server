/**
 * Shared dotenv loader with ENV_FILE support.
 *
 * Allows running multiple server instances (or build scripts) from a single
 * source folder by pointing each instance at its own .env file:
 *
 *   ENV_FILE=.env.alpha node dist/index.js
 *   ENV_FILE=.env.beta  npm run build-database
 *
 * When ENV_FILE is not set, falls back to the repo-root .env file.
 *
 * Relative paths in DB_PATH, LABELS_DB_PATH, and METADATA_PATH are resolved
 * relative to the .env file's directory, so instance .env files can use
 * portable paths like ./data/xpp-metadata.db that survive folder renames.
 */

import dotenv from 'dotenv';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';

/** Env vars whose relative paths should resolve from the .env file directory. */
const PATH_VARS = ['DB_PATH', 'LABELS_DB_PATH', 'METADATA_PATH'] as const;

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
    : resolve(callerDir, '../.env');

  const result = dotenv.config({ path: envPath });
  if (result.error && !process.env.ENV_FILE) {
    // Fallback: let dotenv try process.cwd() the normal way.
    // Only fall back when ENV_FILE was not explicitly set — if the user pointed
    // at a specific file that is missing, we surface the error rather than
    // silently loading a different config.
    dotenv.config();
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
}
