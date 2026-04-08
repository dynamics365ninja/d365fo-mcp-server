import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { access, writeFile, unlink, appendFile } from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock, isOperationLockHeld, forceReleaseLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// Build-tool file logger
// Writes structured entries to the bridge log file so stuck builds are visible.
// ---------------------------------------------------------------------------

async function buildLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
  console.error(`[build_d365fo_project] ${message}`);
  try {
    const configManager = getConfigManager();
    const logFile = configManager.getContext()?.bridgeLogFile;
    if (!logFile) return;
    const line = `[${new Date().toISOString()}] [BuildTool] [${level}] ${message}\n`;
    await appendFile(logFile, line, 'utf-8');
  } catch {
    // Best-effort — never throw from logging
  }
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function assertSafePath(value: string, label: string): void {
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a build command: ${value}`
    );
  }
}

function quoteCmdArg(arg: string): string {
  return `"${arg}"`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const D365_BUILD_TASKS_ASSEMBLY = 'Microsoft.Dynamics.Framework.Tools.BuildTasks';
const VSWHERE_PATH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

const MSBUILD_CANDIDATES = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
];

const VS_DEV_CMD_CANDIDATES = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\Common7\\Tools\\VsDevCmd.bat',
];

const DEVENV_COM_CANDIDATES = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.com',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.com',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.com',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\Common7\\IDE\\devenv.com',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\Common7\\IDE\\devenv.com',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\Common7\\IDE\\devenv.com',
];

const PACKAGES_CANDIDATES = [
  'C:\\AOSService\\PackagesLocalDirectory',
  'K:\\AOSService\\PackagesLocalDirectory',
  'J:\\AOSService\\PackagesLocalDirectory',
  'I:\\AOSService\\PackagesLocalDirectory',
];

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

async function killOrphanedBuildProcesses(): Promise<void> {
  // Kills any MSBuild and devenv processes that may be stuck from a previous build.
  // Uses taskkill /F /IM — safe on a D365FO developer VM where these are build-only processes.
  const targets = ['MSBuild.exe', 'devenv.com', 'devenv.exe'];
  await Promise.allSettled(
    targets.map(name =>
      execFileAsync('taskkill', ['/F', '/IM', name], { timeout: 10_000, windowsHide: true })
        .then(() => console.error(`[build_d365fo_project] killed ${name}`))
        .catch(() => { /* process was not running — that's fine */ }),
    ),
  );
}

async function isProcessImageRunning(imageName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tasklist', [
      '/FI', `IMAGENAME eq ${imageName}`,
      '/FO', 'CSV',
      '/NH',
    ], { timeout: 10_000, windowsHide: true });

    return stdout.toLowerCase().includes(`"${imageName.toLowerCase()}"`);
  } catch {
    return false;
  }
}

async function getRunningBuildProcesses(): Promise<string[]> {
  const targets = ['MSBuild.exe', 'devenv.com', 'devenv.exe'];
  const states = await Promise.all(targets.map(async name => ({
    name,
    running: await isProcessImageRunning(name),
  })));
  return states.filter(state => state.running).map(state => state.name);
}

async function resolvePackagesPath(): Promise<string | null> {
  try {
    const configManager = getConfigManager();
    const configPath = configManager.getPackagePath();
    if (configPath) {
      try { await access(configPath); return configPath; } catch { /* fall through */ }
    }
  } catch { /* configManager not ready */ }

  for (const candidate of PACKAGES_CANDIDATES) {
    try { await access(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

async function findFirstExisting(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    try { await access(c); return c; } catch { /* next */ }
  }
  return null;
}

async function findVsWithVswhere(): Promise<{
  msbuildExe: string;
  vsDevCmdPath: string | null;
  devenvComPath: string | null;
} | null> {
  try { await access(VSWHERE_PATH); } catch { return null; }
  try {
    const { stdout } = await execFileAsync(VSWHERE_PATH, [
      '-latest', '-requires', 'Microsoft.Component.MSBuild', '-property', 'installationPath',
    ], { timeout: 10_000, windowsHide: true });

    const installPath = stdout.trim().split(/\r?\n/)[0];
    if (!installPath) return null;

    const msbuildExe = path.join(installPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
    try { await access(msbuildExe); } catch { return null; }

    const vsDevCmdPath = path.join(installPath, 'Common7', 'Tools', 'VsDevCmd.bat');
    const devenvComPath = path.join(installPath, 'Common7', 'IDE', 'devenv.com');

    return {
      msbuildExe,
      vsDevCmdPath: await access(vsDevCmdPath).then(() => vsDevCmdPath, () => null),
      devenvComPath: await access(devenvComPath).then(() => devenvComPath, () => null),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// devenv.com /build — headless VS fallback for MSB4062
// ---------------------------------------------------------------------------

async function buildWithDevenv(
  devenvComPath: string,
  projectPath: string,
): Promise<{ success: boolean; output: string }> {
  assertSafePath(devenvComPath, 'devenv.com path');
  assertSafePath(projectPath, 'Project path');
  await buildLog('INFO', `devenv.com fallback started — pid: ${process.pid} | devenv: ${devenvComPath}`);

  try {
    const { stdout, stderr } = await withOperationLock(
      `build:devenv:${projectPath}`,
      () => execFileAsync(devenvComPath, [projectPath, '/build', 'Debug'], {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 900_000,
        windowsHide: true,
      }),
    );
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const failed = /\d+\s+failed/.test(output)
      ? !/0\s+failed/.test(output)
      : /\b(error|Error)\s+(CS|AX|X\+\+|MSB)\d+|Build FAILED/i.test(output);
    await buildLog(failed ? 'ERROR' : 'INFO', `devenv.com fallback finished — success: ${!failed}`);
    return { success: !failed, output };
  } catch (error: any) {
    await buildLog('ERROR', `devenv.com fallback error: ${error?.message}`);
    return { success: false, output: [error.stdout, error.stderr, error.message].filter(Boolean).join('\n') };
  }
}

function isMSB4062(output: string): boolean {
  return output.includes('MSB4062') && output.includes(D365_BUILD_TASKS_ASSEMBLY);
}

// ---------------------------------------------------------------------------
// Tool definition + handler
// ---------------------------------------------------------------------------

export const buildProjectToolDefinition = {
  name: 'build_d365fo_project',
  description: 'Triggers a local MSBuild process on the .rnrproj to catch compiler errors.',
  parameters: z.object({
    projectPath: z.string().optional().describe('The absolute path to the .rnrproj file. Auto-detected from .mcp.json if omitted.'),
    force: z.boolean().optional().describe('Kill any running MSBuild/devenv.com processes and clear a stuck build lock before starting. Use when a previous build is stuck.'),
  })
};

export const buildProjectTool = async (params: any, _context: any) => {
  let resolvedProjectPath: string | undefined;
  let devenvComPath: string | null = null;
  const force = params.force === true;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    resolvedProjectPath = params.projectPath || await configManager.getProjectPath();
    if (!resolvedProjectPath) {
      return { content: [{ type: 'text', text: '❌ Cannot determine project path.\n\nProvide projectPath parameter or set it in .mcp.json.' }], isError: true };
    }

    const buildLockKey = `build:${resolvedProjectPath}`;
    const devenvLockKey = `build:devenv:${resolvedProjectPath}`;

    if (force) {
      // Kill orphaned build processes and clear any stale lock so we can proceed.
      await buildLog('WARN', `force=true requested — killing orphaned build processes and clearing lock for: ${resolvedProjectPath}`);
      await killOrphanedBuildProcesses();
      await forceReleaseLock(buildLockKey);
      await forceReleaseLock(devenvLockKey);
    } else {
      // Fail fast rather than queueing behind a potentially-stuck build.
      // Check BOTH the main MSBuild lock and the devenv.com fallback lock —
      // the devenv lock survives even after the main lock is released (it's
      // acquired inside formatResult's MSB4062 fallback, outside the main lock).
      const [mainLocked, devenvLocked] = await Promise.all([
        isOperationLockHeld(buildLockKey),
        isOperationLockHeld(devenvLockKey),
      ]);
      if (mainLocked || devenvLocked) {
        const runningProcesses = await getRunningBuildProcesses();

        if (runningProcesses.length === 0) {
          await buildLog('WARN', `Detected stale build lock with no active build processes for: ${resolvedProjectPath} — clearing locks`);
          await forceReleaseLock(buildLockKey);
          await forceReleaseLock(devenvLockKey);
        } else {
          const which = mainLocked ? 'MSBuild' : 'devenv.com fallback';
          await buildLog('WARN', `Build already in progress (${which} lock held, active processes: ${runningProcesses.join(', ')}) for: ${resolvedProjectPath} — rejecting new request`);
          return {
            content: [{
              type: 'text',
              text: `⚠️ A build is already in progress (${which}) for this project.\n\n` +
                `Active processes: ${runningProcesses.join(', ')}\n\n` +
                'Wait for it to finish, or call `build_d365fo_project` with `force: true` to kill the stuck build and start fresh.',
            }],
            isError: true,
          };
        }
      }
    }

    // --- Locate tools ---
    const vsInfo = await findVsWithVswhere();
    let msbuildExe: string | null = vsInfo?.msbuildExe ?? null;
    let vsDevCmdPath: string | null = vsInfo?.vsDevCmdPath ?? null;
    devenvComPath = vsInfo?.devenvComPath ?? null;

    if (!msbuildExe) msbuildExe = await findFirstExisting(MSBUILD_CANDIDATES) ?? 'msbuild';
    if (!vsDevCmdPath) vsDevCmdPath = await findFirstExisting(VS_DEV_CMD_CANDIDATES);
    if (!devenvComPath) devenvComPath = await findFirstExisting(DEVENV_COM_CANDIDATES);

    const packagesPath = await resolvePackagesPath();

    // --- Build args ---
    const buildArgs = [
      resolvedProjectPath,
      '/p:Configuration=Debug',
      '/p:Platform=AnyCPU',
      '/m', '/v:minimal', '/nologo',
    ];
    if (packagesPath) {
      assertSafePath(packagesPath, 'PackagesLocalDirectory path');
      buildArgs.push(`/p:PackagesFolder=${packagesPath}`);
      buildArgs.push(`/p:MetadataDir=${packagesPath}`);
    }

    // --- Execute ---
    let stdout: string;
    let stderr: string;

    await buildLog('INFO', `Build started — project: ${resolvedProjectPath} | pid: ${process.pid}`);

    if (vsDevCmdPath) {
      assertSafePath(vsDevCmdPath, 'VsDevCmd.bat path');
      assertSafePath(msbuildExe, 'MSBuild.exe path');
      for (const arg of buildArgs) assertSafePath(arg, 'MSBuild argument');

      const batLines = ['@echo off'];
      if (packagesPath) {
        batLines.push(`set "PackagesFolder=${packagesPath}"`);
        batLines.push(`set "MetadataDir=${packagesPath}"`);
        batLines.push(`set "PATH=%PATH%;${packagesPath}\\bin"`);
      }
      batLines.push(`call ${quoteCmdArg(vsDevCmdPath)}`);
      batLines.push('if errorlevel 1 exit /b 1');
      batLines.push(`${quoteCmdArg(msbuildExe)} ${buildArgs.map(a => quoteCmdArg(a)).join(' ')}`);

      const tempBat = path.join(os.tmpdir(), `d365build_${crypto.randomBytes(4).toString('hex')}.cmd`);
      await buildLog('INFO', `VsDevCmd: ${vsDevCmdPath} | MSBuild: ${msbuildExe} | bat: ${tempBat}`);
      await writeFile(tempBat, batLines.join('\r\n') + '\r\n', 'utf-8');

      try {
        ({ stdout, stderr } = await withOperationLock(
          buildLockKey,
          () => execFileAsync('cmd.exe', ['/C', tempBat], {
            maxBuffer: 20 * 1024 * 1024,
            timeout: 600_000,
            windowsHide: true,
          }),
        ));
      } finally {
        await unlink(tempBat).catch(() => {});
      }
    } else {
      await buildLog('INFO', `Running MSBuild directly: ${msbuildExe}`);
      ({ stdout, stderr } = await withOperationLock(
        buildLockKey,
        () => execFileAsync(msbuildExe!, buildArgs, {
          maxBuffer: 20 * 1024 * 1024,
          timeout: 600_000,
          windowsHide: true,
        }),
      ));
    }

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    await buildLog('INFO', `Build finished — project: ${resolvedProjectPath}`);
    return formatResult(output, resolvedProjectPath, devenvComPath);
  } catch (error: any) {
    await buildLog('ERROR', `Build error — project: ${resolvedProjectPath ?? '(unknown)'}: ${error?.message}`);
    const rawOutput = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return formatResult(rawOutput, resolvedProjectPath ?? '(unknown)', devenvComPath);
  }
};

// ---------------------------------------------------------------------------
// Result formatting + MSB4062 fallback
// ---------------------------------------------------------------------------

async function formatResult(
  output: string,
  projectPath: string,
  devenvComPath: string | null,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  if (isMSB4062(output)) {
    if (devenvComPath) {
      console.error('[build_d365fo_project] MSB4062 detected — falling back to devenv.com /build');
      const result = await buildWithDevenv(devenvComPath, projectPath);
      const status = result.success ? '✅ Build succeeded (via devenv.com)' : '❌ Build FAILED (via devenv.com)';
      return {
        content: [{
          type: 'text',
          text: `${status}\n\nProject: ${projectPath}\n\n` +
            `ℹ️ MSBuild could not load D365FO build tasks (MSB4062). Retried with devenv.com /build.\n\n` +
            `${result.output || '(no output)'}`
        }],
        isError: !result.success,
      };
    }
    return {
      content: [{
        type: 'text',
        text: `❌ Build FAILED — D365FO MSBuild task assembly not found (MSB4062)\n\n` +
          `Project: ${projectPath}\n\n` +
          `The assembly \`${D365_BUILD_TASKS_ASSEMBLY}\` could not be loaded and devenv.com was not found.\n\n` +
          `**How to fix:** Build from **Visual Studio 2022** directly (Ctrl+Shift+B).\n\n` +
          `Raw output:\n${output}`
      }],
      isError: true,
    };
  }

  const hasErrors = /\b(error|Error)\s+(CS|AX|X\+\+|MSB)\d+|Build FAILED/i.test(output);
  const hasWarnings = /\b(warning)\s+(CS|AX|X\+\+|MSB|BP)\d+/i.test(output);
  const status = hasErrors ? '❌ Build FAILED' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';

  return {
    content: [{ type: 'text', text: `${status}\n\nProject: ${projectPath}\n\n${output || '(no output)'}` }],
    ...(hasErrors ? { isError: true } : {}),
  };
}