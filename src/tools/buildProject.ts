import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { access, writeFile, unlink } from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

/**
 * Validate that a value looks like a legitimate Windows filesystem path.
 * Rejects values containing shell metacharacters that could alter command semantics.
 * This is a defense-in-depth check — paths come from vswhere.exe output,
 * hardcoded candidates, or user-provided .mcp.json config, but we validate
 * before passing them to any shell invocation.
 */
function assertSafePath(value: string, label: string): void {
  // Block characters that can change shell semantics even inside quotes.
  // Allowed: letters, digits, spaces, backslash, forward slash, colon, dot, hyphen, underscore, parens, equals
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a build command: ${value}`
    );
  }
}

/**
 * Quote a Windows cmd.exe argument by wrapping in double-quotes.
 * Only used for values that have already passed assertSafePath().
 */
function quoteCmdArg(arg: string): string {
  return `"${arg}"`;
}

// Known MSBuild locations on D365FO development VMs (in order of preference)
const MSBUILD_CANDIDATES = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
];

// VS Developer Command Prompt batch files — initialises the VS environment so that
// D365FO MSBuild task assemblies (e.g. Microsoft.Dynamics.Framework.Tools.BuildTasks.17.0)
// are discoverable by MSBuild (fixes MSB4062 / "could not load assembly" errors).
const VS_DEV_CMD_CANDIDATES = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\Common7\\Tools\\VsDevCmd.bat',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\Common7\\Tools\\VsDevCmd.bat',
];

const D365_BUILD_TASKS_ASSEMBLY = 'Microsoft.Dynamics.Framework.Tools.BuildTasks';

// Relative path from MSBuild extensions root to the D365FO .targets file
const D365_TARGETS_RELATIVE = 'Dynamics365\\Microsoft.Dynamics.Framework.Tools.BuildTasks.Xpp.targets';

// vswhere.exe — ships with the Visual Studio Installer and can locate any VS edition/version
const VSWHERE_PATH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

/**
 * Use vswhere.exe to dynamically find the latest VS installation with MSBuild.
 * Covers VS 2019, 2022, 2026+ and any edition without hardcoded path assumptions.
 */
async function findVsWithVswhere(): Promise<{
  msbuildExe: string;
  vsDevCmdPath: string | null;
  msbuildExtensionsPath: string;
} | null> {
  try {
    await access(VSWHERE_PATH);
  } catch {
    return null; // VS Installer not present
  }
  try {
    const { stdout } = await execFileAsync(VSWHERE_PATH, [
      '-latest',
      '-requires', 'Microsoft.Component.MSBuild',
      '-property', 'installationPath',
    ], { timeout: 10_000, windowsHide: true });

    const installPath = stdout.trim().split(/\r?\n/)[0];
    if (!installPath) return null;

    const msbuildExe = path.join(installPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
    try { await access(msbuildExe); } catch { return null; }

    const vsDevCmdPath = path.join(installPath, 'Common7', 'Tools', 'VsDevCmd.bat');
    let hasDevCmd = false;
    try { await access(vsDevCmdPath); hasDevCmd = true; } catch { /* not found */ }

    return {
      msbuildExe,
      vsDevCmdPath: hasDevCmd ? vsDevCmdPath : null,
      msbuildExtensionsPath: path.join(installPath, 'MSBuild'),
    };
  } catch {
    return null;
  }
}

export const buildProjectToolDefinition = {
  name: 'build_d365fo_project',
  description: 'Triggers a local MSBuild process on the .rnrproj to catch compiler errors.',
  parameters: z.object({
    projectPath: z.string().optional().describe('The absolute path to the .rnrproj file. Auto-detected from .mcp.json if omitted.')
  })
};

export const buildProjectTool = async (params: any, _context: any) => {
  let resolvedProjectPath: string | undefined;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    resolvedProjectPath = params.projectPath || await configManager.getProjectPath();
    if (!resolvedProjectPath) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine project path.\n\nProvide projectPath parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    // --- Locate MSBuild + VS Developer environment ---
    // 1. Try vswhere.exe (dynamic — covers any VS version/edition)
    const vsInfo = await findVsWithVswhere();
    let msbuildExe: string | null = vsInfo?.msbuildExe ?? null;
    let vsDevCmdPath: string | null = vsInfo?.vsDevCmdPath ?? null;
    let msbuildExtensionsPath: string | null = vsInfo?.msbuildExtensionsPath ?? null;

    // 2. Fall back to hardcoded candidate paths
    if (!msbuildExe) {
      for (const candidate of MSBUILD_CANDIDATES) {
        try {
          await access(candidate);
          msbuildExe = candidate;
          break;
        } catch { /* not found, try next */ }
      }
    }
    if (!vsDevCmdPath) {
      for (const candidate of VS_DEV_CMD_CANDIDATES) {
        try {
          await access(candidate);
          vsDevCmdPath = candidate;
          break;
        } catch { /* not found, try next */ }
      }
    }

    // 3. Last resort: hope msbuild is on PATH
    if (!msbuildExe) {
      msbuildExe = 'msbuild';
    }

    // 4. When VsDevCmd is unavailable, check if the D365FO .targets file exists under
    //    the MSBuild extensions path.  If so, we pass /p:MSBuildExtensionsPath explicitly
    //    so the .rnrproj Import can resolve the D365 targets/assembly without VsDevCmd.
    if (!vsDevCmdPath && msbuildExtensionsPath) {
      const targetsFile = path.join(msbuildExtensionsPath, D365_TARGETS_RELATIVE);
      try {
        await access(targetsFile);
        console.error(`[build_d365fo_project] VsDevCmd not found, but D365 targets exist at: ${targetsFile}`);
      } catch {
        msbuildExtensionsPath = null; // targets not here — property won't help
      }
    }

    const buildArgs = [
      resolvedProjectPath,
      '/p:Configuration=Debug',
      '/p:Platform=AnyCPU',
      '/m',
      '/v:minimal',
      '/nologo',
    ];

    // When running without VsDevCmd but with a known extensions path, inject it so
    // that $(MSBuildExtensionsPath)\Dynamics365\...targets resolves correctly.
    if (!vsDevCmdPath && msbuildExtensionsPath) {
      buildArgs.push(`/p:MSBuildExtensionsPath=${msbuildExtensionsPath}\\`);
    }

    let stdout: string;
    let stderr: string;

    if (vsDevCmdPath) {
      // Run MSBuild through the VS Developer Command Prompt environment.
      // `call "VsDevCmd.bat"` initialises VS environment variables in-process so that
      // D365FO MSBuild task assemblies are discoverable by the subsequent MSBuild call.
      //
      // We write a temporary batch file instead of using `cmd /C call "..." && msbuild`
      // because Node's execFile quoting and cmd.exe's /C quote-stripping interact badly:
      // Node escapes embedded " as \" (MSVCRT convention) but cmd.exe treats \ as literal,
      // producing mangled paths like '..\..\Tools\VsDevCmd.bat\"' (see #400).
      // A temp .cmd file puts each command on its own line, completely sidestepping
      // the cmd.exe /C quoting heuristic.
      //
      // Security: all dynamic values are validated via assertSafePath() which rejects
      // shell metacharacters.  The temp file contains only those validated paths.
      assertSafePath(vsDevCmdPath, 'VsDevCmd.bat path');
      assertSafePath(msbuildExe!, 'MSBuild.exe path');
      for (const arg of buildArgs) {
        assertSafePath(arg, 'MSBuild argument');
      }

      const msbuildToken = quoteCmdArg(msbuildExe!);
      const argsToken = buildArgs.map(a => quoteCmdArg(a)).join(' ');

      // Write a temporary batch file — each command on its own line avoids all
      // cmd.exe /C quote-stripping and `call` double-expansion issues.
      const tempBat = path.join(os.tmpdir(), `d365build_${crypto.randomBytes(4).toString('hex')}.cmd`);
      const batContent = `@echo off\r\ncall ${quoteCmdArg(vsDevCmdPath)}\r\nif errorlevel 1 exit /b 1\r\n${msbuildToken} ${argsToken}\r\n`;

      console.error(`[build_d365fo_project] Writing temp build script: ${tempBat}`);
      console.error(`[build_d365fo_project] VsDevCmd: ${vsDevCmdPath}`);
      console.error(`[build_d365fo_project] MSBuild:  ${msbuildExe}`);
      await writeFile(tempBat, batContent, 'utf-8');

      try {
        ({ stdout, stderr } = await withOperationLock(
          `build:${resolvedProjectPath}`,
          () => execFileAsync('cmd.exe', ['/C', tempBat], {
            maxBuffer: 20 * 1024 * 1024,
            timeout: 600_000, // 10 minutes
            windowsHide: true,
          }),
        ));
      } finally {
        await unlink(tempBat).catch(() => { /* best-effort cleanup */ });
      }
    } else {
      console.error(`[build_d365fo_project] Running: ${msbuildExe} ${buildArgs.join(' ')}`);
      ({ stdout, stderr } = await withOperationLock(
        `build:${resolvedProjectPath}`,
        () => execFileAsync(msbuildExe!, buildArgs, {
          maxBuffer: 20 * 1024 * 1024,
          timeout: 600_000, // 10 minutes
          windowsHide: true,
        }),
      ));
    }

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasErrors = /\b(error|Error)\s+(CS|AX|X\+\+|MSB)\d+|Build FAILED/i.test(output);
    const hasWarnings = /\b(warning)\s+(CS|AX|X\+\+|MSB|BP)\d+/i.test(output);

    // Detect the specific D365FO task-assembly load failure even when it is reported as a
    // warning/info line rather than a hard error.
    const hasBuildTasksError = output.includes(D365_BUILD_TASKS_ASSEMBLY) && output.includes('MSB4062');
    if (hasBuildTasksError) {
      return {
        content: [{
          type: 'text',
          text: `❌ Build FAILED — D365FO MSBuild task assembly not found (MSB4062)\n\n` +
            `Project: ${resolvedProjectPath}\n\n` +
            `The assembly \`${D365_BUILD_TASKS_ASSEMBLY}\` could not be loaded.\n\n` +
            `**Root cause:** MSBuild was invoked outside the Visual Studio Developer environment, ` +
            `so the D365FO extension task DLLs are not on the assembly probing path.\n\n` +
            `**How to fix:**\n` +
            `1. Ensure the "Dynamics 365" Visual Studio extension is fully installed (repair if needed).\n` +
            `2. Verify that \`VsDevCmd.bat\` exists in \`Common7\\Tools\` under your VS installation — ` +
            `this tool automatically chains through it when found.\n` +
            `3. If the extension is installed but the error persists, run MSBuild from a ` +
            `**Developer Command Prompt for VS 2022** (Start menu) and confirm the build ` +
            `succeeds there first.\n\n` +
            `Raw output:\n${output}`
        }],
        isError: true
      };
    }

    const status = hasErrors ? '❌ Build FAILED' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';

    return {
      content: [{ type: 'text', text: `${status}\n\nProject: ${resolvedProjectPath}\n\n${output || '(no output)'}` }]
    };
  } catch (error: any) {
    console.error('Error building project:', error);
    const rawOutput = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');

    // Surface a targeted hint when the process exits non-zero due to the D365FO task assembly issue.
    if (rawOutput.includes(D365_BUILD_TASKS_ASSEMBLY) && rawOutput.includes('MSB4062')) {
      return {
        content: [{
          type: 'text',
          text: `❌ Build failed — D365FO MSBuild task assembly not found (MSB4062)\n\n` +
            `The assembly \`${D365_BUILD_TASKS_ASSEMBLY}\` could not be loaded by MSBuild.\n\n` +
            `**Root cause:** The D365FO Visual Studio extension task DLLs are not discoverable ` +
            `when MSBuild is run outside a Developer Command Prompt environment.\n\n` +
            `**How to fix:**\n` +
            `1. Ensure the "Dynamics 365" Visual Studio extension is fully installed.\n` +
            `2. Verify \`VsDevCmd.bat\` exists at \`Common7\\Tools\` inside your VS 2022 install ` +
            `folder — this tool chains through it automatically when present.\n` +
            `3. As a fallback, open a **Developer Command Prompt for VS 2022** and confirm ` +
            `\`msbuild "${resolvedProjectPath}"\` succeeds there.\n\n` +
            `Raw output:\n${rawOutput}`
        }],
        isError: true
      };
    }

    return {
      content: [{ type: 'text', text: '❌ Build failed:\n\n' + rawOutput }],
      isError: true
    };
  }
};
