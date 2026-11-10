/**
 * Deploying a built model to its UDE environment: `build_d365fo_project(deploy: true)`.
 *
 * On UDE the D365FO runtime is in the cloud, and the code it runs — including the code
 * run_systest_class tests — is whatever was last deployed there, not the local build. This
 * module deploys the package that holds the model, the way Visual Studio's Deploy does, through
 * Power Platform Tools' own library (see udeDeployPowerShell.ts for the program and why it is
 * Windows PowerShell 5.1):
 *
 *   - only that package: the library deploys every non-Microsoft package folder in the folder it
 *     is given, so it gets a temporary folder holding one directory junction to the package;
 *   - signed in with the server's own Dataverse token (dataverseAuth.ts), passed on stdin;
 *   - by default as a Dev package with no database sync (~2-3 min); with `fullSync` as a Release
 *     package with a full sync (~20 min), which a table, view, data entity, enum or EDT change needs.
 *
 * The library does not always throw when the deployment fails — an upload error ends in a status
 * line and a normal return — so success is read from the status lines (classifyDeployOutcome).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdtemp, readdir, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getConfigManager } from '../../utils/configManager.js';
import {
  type DataverseAuthSettings,
  DEFAULT_DATAVERSE_CLIENT_ID,
  getDataverseAccessToken,
  readDataverseSettings,
} from '../../utils/dataverseAuth.js';
import { withOperationLock } from '../../utils/operationLocks.js';
import type { ProgressReporter } from '../../utils/progressReporter.js';
import { UDE_DEPLOY_LOADER, UDE_DEPLOY_POWERSHELL } from './udeDeployPowerShell.js';

const execFileAsync = promisify(execFile);

/** A full sync took ~20 min for a tiny model; past this the child is stopped. */
const DEPLOY_TIMEOUT_MS = 60 * 60_000;
/** How often a long deployment re-announces itself to the client. */
const PROGRESS_INTERVAL_MS = 10_000;
/** Staging folders are created per deployment in the temp folder under this prefix. */
const STAGING_PREFIX = 'd365deploy-';
/**
 * A staging folder older than this belongs to no running deployment: one is stopped after
 * DEPLOY_TIMEOUT_MS, and the lock wait before it is shorter than the margin.
 */
const STALE_STAGING_MS = 2 * DEPLOY_TIMEOUT_MS;

/**
 * Removes the staging folders that deployments of a server process that died left behind.
 *
 * Each holds a junction to a real package. A process killed mid-deployment never runs its
 * cleanup, and a later temp cleaner that follows junctions would delete the package's contents
 * through it. Only links are removed (rmdir/unlink, never recursively) and then the emptied
 * folder; anything else in it, and every folder young enough to be in use — by a deployment to
 * another environment, which takes a different lock — is left alone.
 */
export async function sweepStaleStaging(tempDir: string = os.tmpdir(), now: number = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(tempDir)).filter(name => name.startsWith(STAGING_PREFIX));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const folder = path.join(tempDir, name);
    try {
      if (now - (await stat(folder)).mtimeMs < STALE_STAGING_MS) continue;
      for (const entry of await readdir(folder)) {
        const link = path.join(folder, entry);
        if (!(await lstat(link)).isSymbolicLink()) continue; // a junction reports as a symbolic link
        await rmdir(link).catch(() => unlink(link));
      }
      await rmdir(folder);
      removed++;
    } catch { /* in use, not empty, or gone: leave it */ }
  }
  return removed;
}

// ── prerequisites ───────────────────────────────────────────────────────────

/**
 * Why `deploy` cannot run here, or the Dataverse settings it will use. Checked before the build
 * starts, so a deployment that cannot happen does not cost a compile first.
 */
export async function checkDeployPrerequisites(
  configManager: Pick<ReturnType<typeof getConfigManager>, 'getDevEnvironmentType'>,
  params: { restartAos?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; dataverse: DataverseAuthSettings } | { ok: false; message: string }> {
  if (params.restartAos === true) {
    return {
      ok: false,
      message: 'deploy and restartAos do not go together: deploy sends the model to a UDE environment\'s cloud ' +
        'runtime, restartAos restarts a local AOS (a UDE machine has none). Nothing was built.',
    };
  }
  if (await configManager.getDevEnvironmentType() !== 'ude') {
    return {
      ok: false,
      message: 'deploy is for UDE environments, whose runtime is in the cloud. This machine is not configured as a UDE ' +
        '(no XPP config), and on a development VM the local AOS runs the build directly. Nothing was built.',
    };
  }
  if (process.platform !== 'win32') {
    return { ok: false, message: 'deploy needs Windows PowerShell 5.1 and Visual Studio on this machine. Nothing was built.' };
  }
  const dataverse = readDataverseSettings(env);
  if (!dataverse) {
    return {
      ok: false,
      message: 'deploy sends the model to the Dataverse environment the UDE belongs to, and no Dataverse URL is ' +
        'configured. Nothing was built.\n\nSet `environment.dataverseUrl` (D365FO_DATAVERSE_URL) to that environment\'s ' +
        'URL, e.g. https://contoso-dev.crm.dynamics.com — not the Finance and Operations URL. `pac org list` or the ' +
        'Power Platform admin center shows it. Then restart the server.',
    };
  }
  return { ok: true, dataverse };
}

/** Signs in now (it may open the browser), so a deployment after a long build does not wait on it. */
export async function signInForDeploy(dataverse: DataverseAuthSettings): Promise<string | undefined> {
  try {
    await getDataverseAccessToken(dataverse);
    return undefined;
  } catch (error: any) {
    return `Signing in to ${dataverse.url} failed: ${error?.message ?? error}. Nothing was built. Run the tool again ` +
      'to get a new sign-in page.' +
      (dataverse.clientId === DEFAULT_DATAVERSE_CLIENT_ID
        ? ' If your tenant blocks the default client, set `environment.dataverseClientId` to your own public client ' +
          '(redirect URI http://localhost).'
        : '');
  }
}

// ── locating things ─────────────────────────────────────────────────────────

/** Installation folders from `vswhere -property installationPath`, one per line. */
export function parseVswhereOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^[A-Za-z]:\\/.test(l));
}

/**
 * Visual Studio installation folders: every instance vswhere knows (2022, 2026, previews, any
 * edition), else the standard paths. Power Platform Tools may be in any of them.
 */
async function visualStudioInstallations(): Promise<string[]> {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const found = new Set<string>();
  if (existsSync(vswhere)) {
    try {
      const { stdout } = await execFileAsync(vswhere, ['-all', '-prerelease', '-products', '*', '-property', 'installationPath'],
        { timeout: 15_000, windowsHide: true });
      for (const p of parseVswhereOutput(stdout)) found.add(p);
    } catch { /* fall back to the standard paths */ }
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  for (const version of ['18', '2022']) {
    for (const edition of ['Enterprise', 'Professional', 'Community']) {
      const p = path.join(programFiles, 'Microsoft Visual Studio', version, edition);
      if (existsSync(p)) found.add(p);
    }
  }
  return [...found];
}

/**
 * Extension folders holding Power Platform Tools' deployment library. VSIX extensions live one
 * level below Common7\IDE\Extensions, in a folder with a random name.
 */
export async function findPowerPlatformToolsDirs(installations?: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const install of installations ?? await visualStudioInstallations()) {
    const extensions = path.join(install, 'Common7', 'IDE', 'Extensions');
    let entries: string[];
    try {
      entries = await readdir(extensions);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(extensions, entry);
      if (existsSync(path.join(dir, 'Microsoft.PowerPlatform.VSShared.Util.dll'))) dirs.push(dir);
    }
  }
  return dirs;
}

/** A single folder or file name: no path separator, drive colon or NUL, and not `.` or `..`. */
export function isPlainName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/:]/.test(name) && !name.includes('\0');
}

/** The package folder (module) in `customPackagesPath` whose Descriptor declares `modelName`. */
export async function findModelPackage(customPackagesPath: string, modelName: string): Promise<string | undefined> {
  const descriptor = (pkg: string) => path.join(customPackagesPath, pkg, 'Descriptor', `${modelName}.xml`);
  if (existsSync(descriptor(modelName))) return modelName;
  let entries: string[];
  try {
    entries = await readdir(customPackagesPath);
  } catch {
    return undefined;
  }
  return entries.find(pkg => existsSync(descriptor(pkg)));
}

// ── output ──────────────────────────────────────────────────────────────────

export interface DeployLine {
  type: 'status' | 'module' | 'tools' | 'contract' | 'error' | 'done' | 'other';
  message: string;
}

/** One line of the program's output; anything that is not its JSON is kept as `other`. */
export function parseDeployLine(raw: string): DeployLine | undefined {
  const line = raw.replace(/^\uFEFF/, '').trim();
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line);
    const known = ['status', 'module', 'tools', 'contract', 'error', 'done'];
    if (parsed && typeof parsed === 'object' && known.includes(parsed.type)) {
      return { type: parsed.type, message: String(parsed.message ?? '') };
    }
  } catch { /* not ours */ }
  return { type: 'other', message: line };
}

/** Status lines that mean the deployment did not go through, though the library returned normally. */
const FAILURE_STATUS = /Upload Error|Installation failed|\s-\s(Failed|Error)\b/i;
/**
 * Package Deployer's line for a module the environment applied: `<module>_<a>_<b>_<c>_<d>_managed.zip`,
 * the four-part version from the model descriptor. Matched per known module name, never by
 * splitting the file name: a module may itself end in `_<digits>` (`ContosoExt_2`), and exactly
 * four version parts keep `ContosoExt` from matching `ContosoExt_2`'s line too.
 */
function moduleSucceeded(module: string): RegExp {
  const name = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Upload Finance and Operations Module ${name}(_\\d+){4}_managed\\.zip - Succeeded\\s*$`, 'i');
}

export interface DeployOutcome {
  succeeded: boolean;
  /** The first line that explains a failure. */
  reason?: string;
  modules: string[];
  toolsVersion?: string;
}

/**
 * Whether the deployment went through. Only a module the environment reported as Succeeded counts,
 * and a failure line anywhere wins: DeployFinOpsPackage returns normally after an upload error.
 */
export function classifyDeployOutcome(lines: readonly DeployLine[], exitCode: number | null): DeployOutcome {
  const modules = lines.filter(l => l.type === 'module').map(l => l.message);
  const toolsVersion = lines.find(l => l.type === 'tools')?.message.split(' ')[0];
  const contract = lines.find(l => l.type === 'contract');
  if (contract) {
    const at = contract.message.indexOf(':');
    const version = at > 0 ? contract.message.slice(0, at).trim() : 'unknown';
    const missing = at > 0 ? contract.message.slice(at + 1).trim() : contract.message;
    return {
      succeeded: false,
      modules,
      toolsVersion: toolsVersion ?? version,
      reason: `Power Platform Tools ${version} changed its undocumented deployment library, which no longer has what ` +
        `this server uses (${missing}). Nothing was uploaded. Deploy from Visual Studio until the server supports ` +
        'this version.',
    };
  }
  const error = lines.find(l => l.type === 'error');
  if (error) return { succeeded: false, modules, toolsVersion, reason: error.message };
  const failure = lines.find(l => l.type === 'status' && FAILURE_STATUS.test(l.message));
  if (failure) return { succeeded: false, modules, toolsVersion, reason: failure.message };
  const statuses = lines.filter(l => l.type === 'status').map(l => l.message);
  const notApplied = modules.filter(m => {
    const succeeded = moduleSucceeded(m);
    return !statuses.some(s => succeeded.test(s));
  });
  if (!lines.some(l => l.type === 'done') || exitCode !== 0) {
    const last = lines.filter(l => l.type === 'status' || l.type === 'other').at(-1)?.message;
    return {
      succeeded: false, modules, toolsVersion,
      reason: `The deployment program ended without reporting completion (exit code ${exitCode ?? 'none'}).` +
        (last ? ` Last line: ${last}` : ''),
    };
  }
  if (modules.length === 0 || notApplied.length > 0) {
    return {
      succeeded: false, modules, toolsVersion,
      reason: `The environment never reported ${notApplied.length ? notApplied.join(', ') : 'a module'} as applied.`,
    };
  }
  return { succeeded: true, modules, toolsVersion };
}

/** A status line without the repetition of a long wait: `… - InProgress; Starting services …`. */
function progressText(message: string): string {
  return message.replace(/^Upload Finance and Operations Module \S+ - /, '').trim();
}

// ── running ─────────────────────────────────────────────────────────────────

export interface DeployScriptRequest {
  extensionDirs: string[];
  packagesLocalDirectory: string;
  modulesDir: string;
  orgUrl: string;
  token: string;
  packageType: 'Dev' | 'Release';
  syncKind: 'None' | 'Full';
}

/** The powershell.exe arguments: only the constant loader, never the program or a caller value. */
export function deployPowerShellArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(UDE_DEPLOY_LOADER, 'utf16le').toString('base64')];
}

/**
 * What the loader reads: the program and the request, as JSON with every non-ASCII character
 * escaped. Windows PowerShell reads redirected stdin in the console's code page, not UTF-8, so
 * a path such as C:\Users\José\… would otherwise arrive garbled; \uXXXX escapes survive any
 * code page, and ConvertFrom-Json turns them back.
 */
export function deployStdin(request: DeployScriptRequest): string {
  return JSON.stringify({ script: UDE_DEPLOY_POWERSHELL, request })
    .replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function runDeployScript(
  request: DeployScriptRequest,
  onLine: (line: DeployLine) => void,
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', deployPowerShellArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = parseDeployLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 8000) stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const last = parseDeployLine(buffered);
      if (last) onLine(last);
      resolve({ exitCode: code, timedOut, stderr: stderr.trim() });
    });
    child.stdin.on('error', () => { /* close reports the outcome */ });
    child.stdin.end(deployStdin(request));
  });
}

export interface DeployOptions {
  modelName: string;
  customPackagesPath: string;
  microsoftPackagesPath: string;
  dataverse: DataverseAuthSettings;
  fullSync: boolean;
  /** Where the complete status log is written. */
  logFile: string;
  onProgress?: ProgressReporter;
  /** Where staging folders are created and swept; the system temp folder by default. */
  tempDir?: string;
}

export interface DeployResult {
  section: string;
  failed: boolean;
}

/** Deploys the package holding `modelName`; never throws — failures come back as a section. */
export async function deployModelToUde(options: DeployOptions): Promise<DeployResult> {
  const { modelName, dataverse, fullSync } = options;
  const kind = fullSync ? 'Release package, full database sync' : 'Dev package, no database sync';
  const failed = (text: string): DeployResult => ({
    section: `\n\n--- Deployment (deploy) — FAILED, the build did not ---\n❌ ${text}`,
    failed: true,
  });

  // The name becomes part of paths (the descriptor lookup, the junction): a separator or `..`
  // could point them outside the packages and staging folders.
  if (!isPlainName(modelName)) {
    return failed(`"${modelName}" is not a model name (it contains a path separator or is . or ..). Nothing was deployed.`);
  }
  const requested = Date.now();
  let stage = 'looking for Power Platform Tools';
  // Progress on a timer, not per status line, from the start: vswhere, a sign-in in the browser,
  // the wait for the lock, and the library zipping or uploading the package all write nothing,
  // and a client drops a call it hears nothing from for about a minute. Each tick repeats the
  // latest status.
  const heartbeat = options.onProgress && setInterval(() => {
    const elapsed = Math.round((Date.now() - requested) / 1000);
    try {
      Promise.resolve(options.onProgress!(`🚀 Deploying ${modelName} — ${stage}, ${elapsed}s`, elapsed)).catch(() => {});
    } catch { /* progress is best-effort */ }
  }, PROGRESS_INTERVAL_MS);
  heartbeat?.unref?.();
  try {
    return await deployWithProgress();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  async function deployWithProgress(): Promise<DeployResult> {
    const pkg = await findModelPackage(options.customPackagesPath, modelName);
    if (!pkg) return failed(`No package folder in ${options.customPackagesPath} declares model ${modelName}. Nothing was deployed.`);
    const toolsDirs = await findPowerPlatformToolsDirs();
    if (toolsDirs.length === 0) {
      return failed('Power Platform Tools for Visual Studio was not found in any Visual Studio installation. It is a UDE ' +
        'prerequisite: install it from the Visual Studio Marketplace. Nothing was deployed.');
    }

    // Signed in before the lock: a sign-in that needs the browser can take minutes, and must not
    // hold up other deployments to this environment. The token itself is fetched inside the lock.
    stage = 'signing in';
    try {
      await getDataverseAccessToken(dataverse);
    } catch (error: any) {
      return failed(`Signing in to ${dataverse.url} failed: ${error?.message ?? error}. Nothing was deployed.`);
    }

    const lockRequested = Date.now();
    let started = lockRequested;
    const lines: DeployLine[] = [];
    stage = 'waiting for another deployment to this environment';
    let staging: string | undefined;
    let link: string | undefined;
    try {
      return await withOperationLock(`deploy:${dataverse.url}`, async () => {
        // The duration is the deployment's own, not the wait for another one to finish.
        started = Date.now();
        // The token the child uses for the whole deployment, which cannot renew it: fetched now,
        // after any wait for the lock, so it lasts its full lifetime from the start. Already signed
        // in above, so this is a silent refresh.
        let token: string;
        try {
          token = await getDataverseAccessToken(dataverse, undefined, { forceRefresh: true });
        } catch (error: any) {
          return failed(`Signing in to ${dataverse.url} failed: ${error?.message ?? error}. Nothing was deployed.`);
        }
        stage = 'preparing the package';
        const waited = Math.round((started - lockRequested) / 1000);
        // One package, through a junction: the library deploys every package folder it sees.
        const tempDir = options.tempDir ?? os.tmpdir();
        await sweepStaleStaging(tempDir);
        staging = await mkdtemp(path.join(tempDir, STAGING_PREFIX));
        link = path.join(staging, pkg);
        await symlink(path.join(options.customPackagesPath, pkg), link, 'junction');
        await writeFile(options.logFile, `Deploying ${pkg} to ${dataverse.url} (${kind})\n`, 'utf-8').catch(() => {});

        const run = await runDeployScript({
          extensionDirs: toolsDirs,
          packagesLocalDirectory: options.microsoftPackagesPath,
          modulesDir: staging,
          orgUrl: dataverse.url,
          token,
          packageType: fullSync ? 'Release' : 'Dev',
          syncKind: fullSync ? 'Full' : 'None',
        }, line => {
          lines.push(line);
          void appendFile(options.logFile, `${new Date().toISOString()} [${line.type}] ${line.message}\n`, 'utf-8').catch(() => {});
          // The heartbeat reports it at its next tick.
          if (line.type === 'status' && line.message.trim()) stage = progressText(line.message);
        }, DEPLOY_TIMEOUT_MS);

        const seconds = Math.round((Date.now() - started) / 1000);
        if (run.timedOut) {
          return failed(`The deployment did not finish within ${DEPLOY_TIMEOUT_MS / 60_000} minutes and was stopped here. ` +
            'The environment may still be applying it: check Operation History in the Finance and Operations Package ' +
            `Manager app of ${dataverse.url} before deploying again.\nLog: ${options.logFile}`);
        }
        const outcome = classifyDeployOutcome(lines, run.exitCode);
        if (!outcome.succeeded) {
          const detail = run.stderr && !lines.some(l => l.type === 'error') ? `\n${run.stderr.slice(0, 2000)}` : '';
          return failed(`Deploying ${pkg} to ${dataverse.url} (${kind}) failed after ${seconds}s: ${outcome.reason}${detail}\n` +
            `The environment still runs what was deployed before. Log: ${options.logFile}`);
        }
        return {
          section: `\n\n--- Deployment (deploy) ---\n✅ Deployed ${outcome.modules.join(', ')} to ${dataverse.url} ` +
            `(${kind}) in ${seconds}s${waited >= 5 ? `, after waiting ${waited}s for another deployment to this environment` : ''}. ` +
            'run_systest_class now runs against this build.' +
            (fullSync ? '' : '\nNo database sync ran: after a table, view, data entity, enum or EDT change, deploy with dbSync: true.') +
            `\nLog: ${options.logFile}`,
          failed: false,
        };
      });
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (/Timeout waiting for filesystem lock/i.test(message)) {
        return failed(`Another deployment to ${dataverse.url} was still running and did not finish in time, so this one ` +
          'did not start. Nothing was deployed. Build with deploy: true again once it has finished.');
      }
      return failed(`The deployment could not run: ${message}. Nothing was deployed.`);
    } finally {
      // rmdir, never a recursive delete: the junction must go, the package it points to must not.
      // unlink for a symbolic link (what 'junction' creates off Windows); neither ever removes a
      // directory's contents.
      if (link) await rmdir(link).catch(() => unlink(link!)).catch(() => {});
      if (staging) await rmdir(staging).catch(() => {});
    }
  }
}

/** The custom and Microsoft packages folders of the active UDE configuration. */
export async function udePackagePaths(): Promise<{ customPackagesPath: string; microsoftPackagesPath: string } | undefined> {
  const config = await getConfigManager().getActiveXppConfig();
  if (!config?.customPackagesPath || !config.microsoftPackagesPath) return undefined;
  return { customPackagesPath: config.customPackagesPath, microsoftPackagesPath: config.microsoftPackagesPath };
}
