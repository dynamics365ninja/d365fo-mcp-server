/**
 * Ratchet on the gap between "environment variables src/ actually reads" and
 * "environment variables src/config/settings.ts documents".
 *
 * The registry is meant to be the single source of truth — the wizard, the
 * doctor, the config loader and docs/CONFIGURATION.md are all generated from
 * it. A variable read straight from process.env without an entry is invisible
 * to every one of them: `d365fo-mcp doctor` cannot report it, the config file
 * cannot set it, and the docs never mention it. LABEL_LANGUAGES is what that
 * costs when it goes wrong (see tests/metadata/labelLanguagesDefault.test.ts).
 *
 * Closing the whole gap at once would be a large, risky change, so this test
 * does the next best thing: it pins the list. Registering a variable makes the
 * count go down and the expectation has to be lowered with it; adding a new
 * unregistered read makes the test fail with the variable named.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS, settingByEnv } from '../../src/config/settings.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = join(repoRoot, 'src');

/**
 * Platform/runtime inputs, not configuration — the registry header calls these
 * out as deliberately absent. They are things the OS, the host or the launcher
 * supplies; asking a user to set HOME or CI in a wizard would be nonsense.
 */
const NOT_CONFIGURATION = new Set([
  // OS-provided
  'HOME', 'LOCALAPPDATA', 'USERNAME', 'USERPROFILE', 'XDG_CONFIG_HOME',
  // terminal / CI detection
  'CI', 'ConEmuTask', 'FORCE_COLOR', 'FORCE_UNICODE', 'GITHUB_ACTIONS', 'TERM',
  'TERM_PROGRAM', 'TF_BUILD', 'WSLENV', 'WT_SESSION',
  // how the process was launched / where it reads its own config from
  'D365FO_CONFIG', 'D365FO_MCP_HOME', 'ENV_FILE', 'MCP_CONFIG_PATH',
  'ALLOW_UNAUTHENTICATED', 'MCP_STDIO_MODE', 'NODE_ENV', 'WEBSITES_PORT',
  // npm / IDE ambient
  'VSCODE_WORKSPACE_FOLDER_PATHS', 'npm_config_registry',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every `process.env.FOO` / `process.env['FOO']` read under src/. */
function collectEnvReads(): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const file of walk(srcRoot)) {
    const source = readFileSync(file, 'utf8');
    const re = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = (m[1] ?? m[2])!;
      const where = relative(repoRoot, file).replace(/\\/g, '/');
      const list = reads.get(name) ?? [];
      if (!list.includes(where)) list.push(where);
      reads.set(name, list);
    }
  }
  return reads;
}

describe('environment variable registry coverage', () => {
  const reads = collectEnvReads();
  const unregistered = [...reads.keys()]
    .filter(name => !settingByEnv(name) && !NOT_CONFIGURATION.has(name))
    .sort();

  it('does not grow the set of unregistered configuration variables', () => {
    // Shrink this list as variables get registered; growing it needs a reason
    // in the commit message, because an unregistered variable is one the
    // doctor, the wizard and docs/CONFIGURATION.md cannot see.
    //
    // What is left today, and why each is still here:
    //   DEV_ENVIRONMENT_TYPE — legacy alias; loadEnv.ts mirrors
    //                          D365FO_DEV_ENVIRONMENT_TYPE onto it
    //   PACKAGES_PATH        — legacy alias for D365FO_PACKAGE_PATH
    //   WORKSPACE_PATH       — legacy alias for D365FO_WORKSPACE_PATH
    //   RESUME / SKIP_FTS    — flags of the two-phase CI index build, set by the
    //                          pipeline, not by a developer (see scripts/build-fts.ts)
    // Registering an alias would put a second key for the same value in the
    // config file, which is why they are listed rather than added.
    expect(
      unregistered,
      `unregistered process.env reads:\n${unregistered.map(n => `  ${n} — ${reads.get(n)!.join(', ')}`).join('\n')}`,
    ).toEqual(['DEV_ENVIRONMENT_TYPE', 'PACKAGES_PATH', 'RESUME', 'SKIP_FTS', 'WORKSPACE_PATH']);
  });

  it('registers every variable the setting registry claims to own', () => {
    // The reverse direction: a registry entry whose variable nothing reads is a
    // promise the runtime does not keep. Scripts read some of these, so the
    // check is that the name appears somewhere in src/ or scripts/, not that it
    // is a process.env read specifically.
    const haystack = [...walk(srcRoot), ...walk(join(repoRoot, 'scripts'))]
      .map(f => readFileSync(f, 'utf8'))
      .join('\n');
    const orphans = SETTINGS.map(s => s.env).filter(env => !haystack.includes(env));
    expect(orphans).toEqual([]);
  });
});
