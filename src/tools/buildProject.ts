import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import { access } from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';

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

export const buildProjectToolDefinition = {
  name: 'build_d365fo_project',
  description: 'Triggers a local MSBuild process on the .rnrproj to catch compiler errors.',
  parameters: z.object({
    projectPath: z.string().optional().describe('The absolute path to the .rnrproj file. Auto-detected from .mcp.json if omitted.')
  })
};

export const buildProjectTool = async (params: any, _context: any) => {
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    const resolvedProjectPath = params.projectPath || await configManager.getProjectPath();
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

    const buildCommand = `"${msbuildExe}" "${resolvedProjectPath}" /p:Configuration=Debug /p:Platform=AnyCPU /m /v:minimal /nologo`;
    console.error(`[build_d365fo_project] Running: ${buildCommand}`);

    const { stdout, stderr } = await execAsync(buildCommand, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 600_000 // 10 minutes
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasErrors = /\b(error|Error)\s+(CS|AX|X\+\+|MSB)\d+|Build FAILED/i.test(output);
    const hasWarnings = /\b(warning)\s+(CS|AX|X\+\+|MSB|BP)\d+/i.test(output);

    const status = hasErrors ? '❌ Build FAILED' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';

    return {
      content: [{ type: 'text', text: `${status}\n\nProject: ${resolvedProjectPath}\n\n${output || '(no output)'}` }]
    };
  } catch (error: any) {
    console.error('Error building project:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ Build failed:\n\n' + output }],
      isError: true
    };
  }
};
