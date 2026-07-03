/**
 * `d365fo-mcp doctor` — environment and installation health check.
 *
 * Verifies everything SETUP.md lists as a prerequisite and prints a fix for
 * each failed check. Exit code 1 when a hard failure is found (something that
 * prevents the server from working at all), 0 otherwise.
 */
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { p } from '../ui.js';
import { isWindows, paths, repoRoot } from '../context.js';
import { readEnvValue } from '../envFile.js';
import { listInstances } from '../instances.js';
import { isXppConfigStale, listXppConfigs, xppConfigDir } from '../xppConfig.js';

type Severity = 'ok' | 'warn' | 'fail' | 'info';

interface CheckResult {
  severity: Severity;
  message: string;
  fix?: string;
}

const REQUIRED_NODE_MAJOR = 24;
/** Below this size the index is almost certainly incomplete (SETUP.md troubleshooting). */
const MIN_HEALTHY_DB_BYTES = 100 * 1024 * 1024;

function report(r: CheckResult): void {
  const line = r.fix ? `${r.message}\n   fix: ${r.fix}` : r.message;
  if (r.severity === 'ok') p.log.success(line);
  else if (r.severity === 'warn') p.log.warn(line);
  else if (r.severity === 'fail') p.log.error(line);
  else p.log.info(line);
}

function checkDb(envFile: string | null, defaultDb: string, label: string): CheckResult {
  const configured = envFile ? readEnvValue(envFile, 'DB_PATH') : null;
  const base = envFile ? resolve(envFile, '..') : repoRoot;
  const dbPath = configured ? resolve(base, configured) : defaultDb;
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

  // Runtime
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  emit(nodeMajor >= REQUIRED_NODE_MAJOR
    ? { severity: 'ok', message: `Node.js ${process.versions.node}` }
    : { severity: 'fail', message: `Node.js ${process.versions.node} — ${REQUIRED_NODE_MAJOR}.x required (package.json engines)`, fix: 'install Node 24 LTS' });

  // Install + build
  emit(fs.existsSync(resolve(repoRoot, 'node_modules'))
    ? { severity: 'ok', message: 'Dependencies installed (node_modules)' }
    : { severity: 'fail', message: 'node_modules missing', fix: 'npm install' });
  emit(fs.existsSync(paths.distEntry)
    ? { severity: 'ok', message: 'Server built (dist/index.js)' }
    : { severity: 'fail', message: 'dist/index.js missing — server not built', fix: 'npm run build' });

  // Configuration
  emit(fs.existsSync(paths.rootEnv)
    ? { severity: 'ok', message: 'Root .env present' }
    : { severity: 'info', message: 'No root .env — fine when config comes from .mcp.json env or instances/', fix: 'd365fo-mcp setup' });

  // Database (root)
  emit(checkDb(fs.existsSync(paths.rootEnv) ? paths.rootEnv : null, paths.defaultDb, 'Root'));

  // C# bridge — the only write path; Windows-only.
  if (isWindows) {
    emit(fs.existsSync(paths.bridgeExe)
      ? { severity: 'ok', message: 'C# bridge built (D365MetadataBridge.exe)' }
      : { severity: 'warn', message: 'C# bridge not built — server runs read-only', fix: 'cd bridge\\D365MetadataBridge && dotnet build -c Release' });
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
      emit(checkDb(inst.envFile, resolve(inst.dir, 'data', 'xpp-metadata.db'), `Instance '${inst.name}'`));
      if (isWindows && isXppConfigStale(inst.envFile)) {
        emit({
          severity: 'warn',
          message: `Instance '${inst.name}': XPP_CONFIG_NAME no longer resolves — UDE upgraded since configuration`,
          fix: `d365fo-mcp instance upgrade ${inst.name}`,
        });
      }
    }
  }

  // Live servers
  const rootPortRaw = readEnvValue(paths.rootEnv, 'PORT');
  const rootPort = rootPortRaw && /^\d+$/.test(rootPortRaw) ? parseInt(rootPortRaw, 10) : 8080;
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
