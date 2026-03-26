import { z } from 'zod';
import { execFile, exec } from 'child_process';
import util from 'util';
import { access } from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);

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

    // Try to locate MSBuild
    let msbuildExe: string | null = null;
    for (const candidate of MSBUILD_CANDIDATES) {
      try {
        await access(candidate);
        msbuildExe = candidate;
        break;
      } catch { /* not found, try next */ }
    }

    // Fall back to msbuild from PATH
    if (!msbuildExe) {
      msbuildExe = 'msbuild';
    }

    // Try to locate VsDevCmd.bat — when present we chain it before MSBuild so that the
    // Visual Studio extension directories are on the probing path.  This prevents MSB4062
    // ("could not load assembly Microsoft.Dynamics.Framework.Tools.BuildTasks") which
    // occurs when MSBuild is invoked outside the VS Developer environment.
    let vsDevCmdPath: string | null = null;
    for (const candidate of VS_DEV_CMD_CANDIDATES) {
      try {
        await access(candidate);
        vsDevCmdPath = candidate;
        break;
      } catch { /* not found, try next */ }
    }

    const buildArgs = [
      resolvedProjectPath,
      '/p:Configuration=Debug',
      '/p:Platform=AnyCPU',
      '/m',
      '/v:minimal',
      '/nologo',
    ];

    let stdout: string;
    let stderr: string;

    if (vsDevCmdPath) {
      // Run MSBuild through the VS Developer Command Prompt environment.
      // `call "VsDevCmd.bat"` initialises VS environment variables in-process so that
      // D365FO MSBuild task assemblies are discoverable by the subsequent MSBuild call
      // (Node.js exec() uses cmd.exe /C on Windows, so && chaining works correctly).
      const msbuildToken = msbuildExe.includes(' ') ? `"${msbuildExe}"` : msbuildExe;
      const argsToken = buildArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ');
      const fullCmd = `call "${vsDevCmdPath}" && ${msbuildToken} ${argsToken}`;
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
