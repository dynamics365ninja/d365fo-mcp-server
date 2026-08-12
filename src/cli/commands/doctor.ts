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
import { isLegacyInstanceLayout, listInstances, type Instance } from '../instances.js';
import { checkRelease } from '../npmRegistry.js';
import { conflictingLegacyValues, readPath, readSetting, type SettingsStore } from '../settingsStore.js';
import { instanceTarget, rootTarget, type Target } from '../target.js';
import { isXppConfigStale, listXppConfigs, xppConfigDir } from '../xppConfig.js';
import { describePackagesRootScan, packagesRoots } from '../../utils/packagesRoot.js';
import { autoDetectD365Project } from '../../utils/workspaceDetector.js';
import { describeWorkspaceDetection } from '../../utils/workspaceDetectionStatus.js';
import { inferPrefixFromObjectNames } from '../../utils/modelPrefixInference.js';

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

/**
 * The configured packages root against what the machine actually has.
 *
 * A packagePath pointing at a drive this image does not use is the failure
 * behind "setup can't find the namespaces" (#769) — the index then builds from
 * nothing and every lookup comes back empty, with no error saying why. Naming
 * the detected volume turns that into a one-line fix.
 */
function checkPackagesRoot(store: SettingsStore, label: string): CheckResult[] {
  if (!isWindows) return [];

  const configured = String(readSetting(store, settingByPath('environment.packagePath')!) ?? '').trim();
  const detected = packagesRoots();

  if (!configured) {
    // UDE resolves its roots from the XPP config, so silence here is normal.
    if (detected.length === 0) return [];
    return [{
      severity: 'info',
      message: `${label}: packages root not configured — the server will use ${detected[0]}`,
    }];
  }
  if (fs.existsSync(configured)) {
    return [{ severity: 'ok', message: `${label}: packages root OK (${configured})` }];
  }
  return [{
    severity: 'fail',
    message: `${label}: packages root does not exist (${configured})` +
      (detected.length > 0 ? `\n   found instead: ${detected.join(', ')}` : `\n   ${describePackagesRootScan()}`),
    fix: detected.length > 0
      ? `set environment.packagePath to ${detected[0]} (${SETUP_COMMAND})`
      : `point environment.packagePath at this machine's PackagesLocalDirectory (${SETUP_COMMAND})`,
  }];
}

/**
 * Which detection source resolves the workspace — and which model it lands on.
 *
 * The server's own log used to say only that detection had failed, from a pass
 * that ran before its sources were up; the user then had to infer the real
 * resolution from an unrelated tool error (#833). Running the same detector here
 * states the answer outright, and names every source it looked at when there
 * isn't one.
 */
async function checkWorkspaceDetection(
  store: SettingsStore,
  label: string,
): Promise<{ modelName: string | null; checks: CheckResult[] }> {
  const configuredModel = String(readSetting(store, settingByPath('workspace.modelName')!) ?? '').trim();
  const workspacePath = String(readSetting(store, settingByPath('workspace.path')!) ?? '').trim();

  if (configuredModel) {
    return {
      modelName: configuredModel,
      checks: [{
        severity: 'ok',
        message: `${label}: model "${configuredModel}" comes from configuration (workspace.modelName) — no auto-detection needed`,
      }],
    };
  }

  const detected = await autoDetectD365Project(workspacePath || undefined);
  if (!detected) {
    return {
      modelName: null,
      checks: [{
        severity: 'warn',
        message: `${label}: ${describeWorkspaceDetection()}`,
        fix: `set workspace.modelName / workspace.projectPath (${SETUP_COMMAND}), or point workspace.solutionsPath at your solutions root`,
      }],
    };
  }
  return {
    modelName: detected.modelName,
    checks: [{
      severity: 'ok',
      message: `${label}: model "${detected.modelName}" detected from ${detected.detectionSource ?? 'auto-detection'}` +
        (detected.projectPath ? `\n   project: ${detected.projectPath}` : ''),
    }],
  };
}

/**
 * The configured prefix against the one the model's own objects use.
 *
 * These two disagreeing is normal — a single configured prefix cannot be right
 * for every model — but the server resolves the model's own naming ABOVE the
 * configuration, so a user reading only their config has the wrong answer. State
 * both, and how to pin the configured one.
 *
 * `pinned` is naming.prefixSource=config. This check used to call the inference
 * directly and so never saw it — modelPrefixInference reads it in
 * getInferredModelPrefix, one level above inferPrefixFromObjectNames — which
 * meant a user who had already pinned the prefix was still told their model's
 * naming wins (it does not) and offered the fix they had already applied (#893).
 */
export function checkPrefixResolution(
  configuredPrefix: string,
  modelName: string | null,
  modelObjectNames: string[],
  label: string,
  pinned = false,
): CheckResult[] {
  const inferred = modelName ? inferPrefixFromObjectNames(modelObjectNames, modelName) : null;
  const bare = (s: string) => s.replace(/_+$/, '').toLowerCase();

  if (pinned) {
    // Inference is off, so naming.prefix is the whole answer — and an empty one
    // is worse here than anywhere else: pinning it leaves nothing to fall back
    // to but the model name.
    if (!configuredPrefix) {
      return [{
        severity: 'warn',
        message: `${label}: naming.prefixSource=config pins the configured prefix, but naming.prefix is empty ` +
          `— new objects will be prefixed with the model name`,
        fix: `set naming.prefix to your ISV prefix (${SETUP_COMMAND})`,
      }];
    }
    const ignored = inferred?.regular && bare(inferred.regular) !== bare(configuredPrefix)
      ? ` — model "${modelName}"'s objects use "${inferred.regular}", ignored while the prefix is pinned`
      : '';
    return [{
      severity: 'ok',
      message: `${label}: prefix "${configuredPrefix}" (naming.prefix, pinned by naming.prefixSource=config)${ignored}`,
    }];
  }

  if (!inferred?.regular) {
    if (!configuredPrefix) {
      return [{
        severity: 'warn',
        message: `${label}: no prefix configured and none inferable — new objects will be prefixed with the model name`,
        fix: `set naming.prefix to your ISV prefix (${SETUP_COMMAND})`,
      }];
    }
    return [{ severity: 'ok', message: `${label}: prefix "${configuredPrefix}" (naming.prefix)` }];
  }
  if (!configuredPrefix || bare(inferred.regular) === bare(configuredPrefix)) {
    return [{
      severity: 'ok',
      message: `${label}: prefix "${inferred.regular}" — model "${modelName}"'s own objects and the configuration agree`,
    }];
  }
  return [{
    severity: 'warn',
    message: `${label}: prefix conflict — model "${modelName}"'s objects use "${inferred.regular}" ` +
      `(${inferred.coverage}/${inferred.sampleSize}), naming.prefix says "${configuredPrefix}". ` +
      `The model's own naming wins, so new objects are named "${inferred.regular}…".`,
    fix: `set naming.prefixSource=config to pin the configured value instead (${SETUP_COMMAND}, or ` +
      `EXTENSION_PREFIX_SOURCE=config in the environment)`,
  }];
}

/**
 * The object names doctor infers a prefix from. Read straight out of the symbol
 * index — the same rows the server's inference reads (SymbolIndex.getModelObjectNames)
 * — and empty whenever there is no index to read, which is not a prefix problem.
 */
async function modelObjectNames(dbPath: string, modelName: string): Promise<string[]> {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const { default: Database } = await import('../../database/sqlite.js');
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT name FROM symbols
         WHERE model = ?
           AND parent_name IS NULL
           AND type NOT IN ('method', 'field')
         LIMIT 400`
      ).all(modelName) as Array<{ name: string }>;
      return rows.map(r => r.name);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
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
 * An instance whose config still lives under instances/<name>/config/.
 * It runs, so this is not a failure — but the docs, the template and
 * add-instance.ps1 all name the top-level path, so following any of them
 * points D365FO_CONFIG at a file that does not exist and the server starts on
 * defaults instead. Say which file is real and how to end up where the docs
 * already claim it is.
 */
function layoutChecks(inst: Instance): CheckResult[] {
  if (!isLegacyInstanceLayout(inst)) return [];
  const target = resolve(inst.dir, 'd365fo-mcp.json');
  return [{
    severity: 'warn',
    message: `Instance '${inst.name}': config is in the old layout (${inst.configFile}) — the docs all say ${target}`,
    fix: `d365fo-mcp instance upgrade ${inst.name} moves it, or move d365fo-mcp.json and secrets.json up one level by hand`,
  }];
}

/**
 * The symbol index is SQLite, served by node:sqlite — core since Node 22, and
 * the reason this package has no native dependency and installs without
 * lifecycle scripts. Two things can still be absent on an unusual runtime: the
 * module itself (Node older than our `engines` floor, which npm only warns
 * about) and FTS5, which every search query needs and which a custom Node build
 * can omit. Both would otherwise first surface as a failing tool call.
 */
async function checkSqliteEngine(): Promise<CheckResult> {
  try {
    const { default: Database } = await import('../../database/sqlite.js');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE probe USING fts5(content)');
    } finally {
      db.close();
    }
    return { severity: 'ok', message: 'node:sqlite available with FTS5' };
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return {
      severity: 'fail',
      message: `node:sqlite unusable — ${detail}`,
      fix: `install Node 24 or newer (running ${process.version})`,
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
  // anything there — only a git checkout is worth checking.
  if (installMode === 'git') {
    emit(fs.existsSync(resolve(repoRoot, 'node_modules'))
      ? { severity: 'ok', message: 'Dependencies installed (node_modules)' }
      : { severity: 'fail', message: 'node_modules missing', fix: 'npm install' });
  }
  // Core module, so this holds in both layouts and needs no dependencies present.
  emit(await checkSqliteEngine());
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
  for (const r of checkPackagesRoot(root.store, 'Root')) emit(r);

  // Database (root)
  emit(checkDb(root.store, paths.defaultDb, 'Root'));

  // Which source resolves the workspace, and the prefix that follows from it —
  // both were previously only inferable from a tool error (#833).
  const detection = await checkWorkspaceDetection(root.store, 'Workspace');
  for (const r of detection.checks) emit(r);
  const configuredPrefix = String(readSetting(root.store, settingByPath('naming.prefix')!) ?? '').trim();
  const names = detection.modelName
    ? await modelObjectNames(readPath(root.store, settingByPath('index.dbPath')!, paths.defaultDb), detection.modelName)
    : [];
  // Same precedence the server applies: the real environment outranks the
  // config file (loadEnv), and the CLI never projects one onto the other.
  const prefixSource = (
    process.env.EXTENSION_PREFIX_SOURCE
    ?? String(readSetting(root.store, settingByPath('naming.prefixSource')!) ?? '')
  ).trim().toLowerCase();
  for (const r of checkPrefixResolution(
    configuredPrefix, detection.modelName, names, 'Naming', prefixSource === 'config',
  )) emit(r);

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
      for (const r of layoutChecks(inst)) emit(r);
      for (const r of legacyEnvChecks(target, `Instance '${inst.name}'`)) emit(r);
      for (const r of checkPackagesRoot(target.store, `Instance '${inst.name}'`)) emit(r);
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
