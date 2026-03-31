import { z } from 'zod';
import { execFile, exec } from 'child_process';
import util from 'util';
import path from 'path';
import { access } from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);

/**
 * Escape an argument for safe use in a Windows cmd.exe command line.
 * Wraps in double quotes if it contains whitespace or shell metacharacters,
 * and escapes any embedded double quotes.
 */
function escapeCmdArg(arg: string): string {
  if (arg === '') {
    return '""';
  }
  // Characters that can change cmd.exe parsing semantics
  const needsQuoting = /[\s&|<>^"]/u.test(arg);
  // Escape double quotes and handle backslashes preceding them in a cmd.exe-compatible way.
  // Inside a quoted argument, each run of N backslashes followed by a quote should become
  // 2N backslashes followed by two quotes, so that the called program receives the intented characters.
  let escaped = '';
  for (let i = 0; i < arg.length; ) {
    const ch = arg[i];
    if (ch === '\\') {
      // Count run of backslashes
      let j = i;
      while (j < arg.length && arg[j] === '\\') {
        j++;
      }
      const numBackslashes = j - i;
      const nextChar = arg[j];
      if (nextChar === '"') {
        // Double the backslashes, then escape the quote by doubling it
        escaped += '\\'.repeat(numBackslashes * 2) + '""';
        i = j + 1;
      } else {
        // No following quote: keep backslashes as-is
        escaped += '\\'.repeat(numBackslashes);
        i = j;
      }
    } else if (ch === '"') {
      // Bare quote: escape by doubling
      escaped += '""';
      i++;
    } else {
      escaped += ch;
      i++;
    }
  }
  return needsQuoting ? `"${escaped}"` : escaped;
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
      // D365FO MSBuild task assemblies are discoverable by the subsequent MSBuild call
      // (Node.js exec() uses cmd.exe /C on Windows, so && chaining works correctly).
      const msbuildToken = escapeCmdArg(msbuildExe!);
      const argsToken = buildArgs.map(a => escapeCmdArg(a)).join(' ');
      const fullCmd = `call ${escapeCmdArg(vsDevCmdPath)} && ${msbuildToken} ${argsToken}`;
      console.error(`[build_d365fo_project] Running via VsDevCmd: ${fullCmd}`);
      ({ stdout, stderr } = await withOperationLock(
        `build:${resolvedProjectPath}`,
        () => execAsync(fullCmd, {
          maxBuffer: 20 * 1024 * 1024,
          timeout: 600_000, // 10 minutes
        }),
      ));
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
