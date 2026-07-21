/**
 * `d365fo-mcp doctor` — environment and installation health check.
 *
 * Verifies everything SETUP.md lists as a prerequisite and prints a fix for
 * each failed check. Exit code 1 when a hard failure is found (something that
 * prevents the server from working at all), 0 otherwise.
 */
import * as fs from 'node:fs';
import { relative, resolve } from 'node:path';
import { p } from '../ui.js';
import { settingByPath } from '../../config/settings.js';
import { bridgeBuildCommand, dataRoot, installMode, isWindows, paths, repoRoot } from '../context.js';
import { commandExists } from '../exec.js';
import { listInstances } from '../instances.js';
import { checkRelease } from '../npmRegistry.js';
import { conflictingLegacyValues, readPath, readSetting, type SettingsStore } from '../settingsStore.js';
import { instanceTarget, rootTarget, type Target } from '../target.js';
import { isXppConfigStale, listXppConfigs, xppConfigDir } from '../xppConfig.js';

type Severity = 'ok' | 'warn' | 'fail' | 'info';

interface CheckResult {
  severity: Severity;
  message: string;
  fix?: string;
}

const REQUIRED_NODE_MAJOR = 24;
/**
 * How to reach the wizard from here. `npm run setup` only exists in a checkout
 * — an npm install has no package scripts of its own to run.
 */
const SETUP_COMMAND = installMode === 'git' ? 'npm run setup' : 'd365fo-mcp setup';
/** Below this size the index is almost certainly incomplete (SETUP.md troubleshooting). */
const MIN_HEALTHY_DB_BYTES = 100 * 1024 * 1024;

function report(r: CheckResult): void {
  const line = r.fix ? `${r.message}\n   fix: ${r.fix}` : r.message;
  if (r.severity === 'ok') p.log.success(line);
  else if (r.severity === 'warn') p.log.warn(line);
  else if (r.severity === 'fail') p.log.error(line);
  else p.log.info(line);
}

function checkDb(store: SettingsStore, defaultDb: string, label: string): CheckResult {
  const dbPath = readPath(store, settingByPath('index.dbPath')!, defaultDb);
  if (!fs.existsSync(dbPath)) {
    return {
      severity: 'warn',
      message: `${label}: database not found (${dbPath})`,
      fix: 'd365fo-mcp index — not needed for hybrid/azure-client setups',
    };
  }
  const size = fs.statSync(dbPath).size;
  const mb = (size / 1024 / 1024).toFixed(0);
  if (size < MIN_HEALTHY_DB_BYTES) {
    return {
      severity: 'warn',
      message: `${label}: database is only ${mb} MB — index looks incomplete`,
      fix: 'd365fo-mcp index',
    };
  }
  return { severity: 'ok', message: `${label}: database OK (${mb} MB)` };
}

/** The structured config the setup wizard writes — absent means never set up. */
function checkConfig(target: Target, label: string): CheckResult {
  if (fs.existsSync(target.store.configPath)) {
    const shown = relative(dataRoot(), target.store.configPath) || target.store.configPath;
    return { severity: 'ok', message: `${label}: configuration present (${shown})` };
  }
  if (target.envFile) {
    return {
      severity: 'warn',
      message: `${label}: no d365fo-mcp.json — running on the legacy .env only`,
      fix: `${SETUP_COMMAND} — imports the .env and writes the structured config`,
    };
  }
  return {
    severity: 'info',
    message: `${label}: not configured — fine when everything comes from the .mcp.json env block`,
    fix: SETUP_COMMAND,
  };
}

/** A legacy .env that disagrees with the config is a trap: the config wins. */
function legacyEnvChecks(target: Target, label: string): CheckResult[] {
  if (!target.envFile || !fs.existsSync(target.store.configPath)) return [];
  const conflicts = conflictingLegacyValues(target.store);
  if (conflicts.length === 0) {
    return [{ severity: 'info', message: `${label}: legacy .env present but not contradicting the config` }];
  }
  return [{
    severity: 'warn',
    message: `${label}: .env and d365fo-mcp.json disagree — the JSON config wins:\n` +
      conflicts.map(c => `   ${c.setting.env}: .env=${c.envValue} · config=${c.configValue}`).join('\n'),
    fix: 'delete the stale keys from .env (or the whole file once the config is complete)',
  }];
}

/**
 * better-sqlite3 is a native module, and npm 12 blocks install scripts that the
 * root package.json does not pre-approve in `allowScripts`. A blocked build
 * still exits 0 with only a warning, so the .node binding goes missing silently
 * and the install looks clean — the failure would otherwise first appear when
 * the server opens the index. Loading it here turns that into a named problem.
 */
async function checkNativeBinding(): Promise<CheckResult> {
  try {
    // Importing the module is not enough: better-sqlite3 resolves the addon
    // lazily on first use, so a missing binding only surfaces when a database
    // is actually opened. An in-memory one touches no disk.
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
    return { severity: 'ok', message: 'better-sqlite3 native binding loads' };
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return {
      severity: 'fail',
      message: `better-sqlite3 native binding unavailable — ${detail}`,
      fix: 'npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3',
    };
  }
}

/**
 * Whether this copy is the latest published release.
 *
 * Never a hard failure: an old copy still works, and a VM with no route to the
 * registry must not fail its health check over it.
 */
async function checkReleaseFreshness(): Promise<CheckResult> {
  const status = await checkRelease();
  if (status.latest === null) {
    return { severity: 'info', message: `d365fo-mcp ${status.current} — npm registry unreachable, cannot check for a newer release` };
  }
  if (status.behind) {
    return {
      severity: 'warn',
      message: `d365fo-mcp ${status.current} — ${status.latest} is available`,
      fix: installMode === 'npm' ? 'npm install -g d365fo-mcp@latest' : 'd365fo-mcp update',
    };
  }
  return { severity: 'ok', message: `d365fo-mcp ${status.current} (latest)` };
}

async function probeHealth(port: number, label: string): Promise<CheckResult> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { status?: string; symbols?: number };
    if (res.ok) {
      return { severity: 'ok', message: `${label}: running on port ${port} (${body.symbols?.toLocaleString('en-US') ?? '?'} symbols)` };
    }
    return { severity: 'info', message: `${label}: starting on port ${port} (${body.status ?? res.status})` };
  } catch {
    return { severity: 'info', message: `${label}: not running on port ${port} (fine unless you expect an HTTP server)` };
  }
}

export async function doctorCommand(): Promise<void> {
  p.intro('d365fo-mcp doctor');
  let failures = 0;
  const emit = (r: CheckResult) => {
    if (r.severity === 'fail') failures++;
    report(r);
  };

  // Release freshness — advisory, and silent about a registry it cannot reach.
  emit(await checkReleaseFreshness());

  // Runtime
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  emit(nodeMajor >= REQUIRED_NODE_MAJOR
    ? { severity: 'ok', message: `Node.js ${process.versions.node}` }
    : { severity: 'fail', message: `Node.js ${process.versions.node} — ${REQUIRED_NODE_MAJOR}.x required (package.json engines)`, fix: 'install Node 24 LTS' });

  // Install + build. A global npm install resolves its dependencies from the
  // parent node_modules, so a package-local one neither exists nor means
  // anything there — the binding check below is the honest signal in both
  // layouts, and the only one worth failing on.
  if (installMode === 'git') {
    const hasNodeModules = fs.existsSync(resolve(repoRoot, 'node_modules'));
    emit(hasNodeModules
      ? { severity: 'ok', message: 'Dependencies installed (node_modules)' }
      : { severity: 'fail', message: 'node_modules missing', fix: 'npm install' });
    // Only meaningful once the dependencies exist — otherwise it just restates the failure above.
    if (hasNodeModules) emit(await checkNativeBinding());
  } else {
    emit(await checkNativeBinding());
  }
  emit(fs.existsSync(paths.distEntry)
    ? { severity: 'ok', message: 'Server built (dist/index.js)' }
    : { severity: 'fail', message: 'dist/index.js missing — server not built', fix: 'npm run build' });

  // Where this installation keeps its state — the first thing to check when
  // the wizard's answers appear to have vanished after an update.
  emit({ severity: 'info', message: `Installed from ${installMode}; data directory: ${dataRoot()}` });

  // Configuration
  const root = rootTarget();
  emit(checkConfig(root, 'Root'));
  for (const r of legacyEnvChecks(root, 'Root')) emit(r);

  // Database (root)
  emit(checkDb(root.store, paths.defaultDb, 'Root'));

  // C# bridge: the only write path; Windows-only.
  if (isWindows) {
    if (fs.existsSync(paths.bridgeExe)) {
      emit({ severity: 'ok', message: `C# bridge built (${paths.bridgeExe})` });
    } else if (await commandExists('dotnet')) {
      // Absolute path: outside a checkout the user is nowhere near the bridge,
      // and a relative `cd bridge\...` would just fail.
      emit({ severity: 'warn', message: 'C# bridge not built — server runs read-only', fix: bridgeBuildCommand() });
    } else {
      // Naming the real prerequisite beats printing a build command that
      // cannot run. Only checked when the bridge is missing — a built bridge
      // needs no SDK, and asking would be noise on every healthy install.
      emit({ severity: 'warn', message: 'C# bridge not built and no .NET SDK to build it — server runs read-only', fix: 'install the .NET SDK from https://dotnet.microsoft.com/download, then: d365fo-mcp setup' });
    }
    const dir = xppConfigDir();
    const configs = listXppConfigs();
    if (dir && fs.existsSync(dir)) {
      emit({ severity: 'ok', message: `UDE: ${configs.length} XPP config(s) in ${dir}` });
    } else {
      emit({ severity: 'info', message: 'No UDE XPPConfig directory — traditional VM or UDE tools not installed' });
    }
  } else {
    emit({ severity: 'info', message: `C# bridge skipped (Windows-only) — platform is ${process.platform}` });
  }

  // Instances
  const instances = listInstances();
  if (instances.length > 0) {
    p.log.step(`Instances (${instances.length})`);
    for (const inst of instances) {
      const target = instanceTarget(inst);
      emit(checkConfig(target, `Instance '${inst.name}'`));
      for (const r of legacyEnvChecks(target, `Instance '${inst.name}'`)) emit(r);
      emit(checkDb(target.store, resolve(inst.dir, 'data', 'xpp-metadata.db'), `Instance '${inst.name}'`));
      if (isWindows && isXppConfigStale(target.store)) {
        emit({
          severity: 'warn',
          message: `Instance '${inst.name}': XPP_CONFIG_NAME no longer resolves — UDE upgraded since configuration`,
          fix: `d365fo-mcp instance upgrade ${inst.name}`,
        });
      }
    }
  }

  // Live servers
  const configuredPort = readSetting(root.store, settingByPath('server.port')!);
  const rootPort = typeof configuredPort === 'number' ? configuredPort : 8080;
  emit(await probeHealth(rootPort, 'Server'));
  for (const inst of instances) {
    if (inst.port !== null) emit(await probeHealth(inst.port, `Instance '${inst.name}'`));
  }

  if (failures > 0) {
    p.outro(`${failures} problem(s) found — apply the fixes above and re-run.`);
    process.exitCode = 1;
  } else {
    p.outro('No blocking problems found.');
  }
}
