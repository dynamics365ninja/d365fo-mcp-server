import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';

const execFileAsync = util.promisify(execFile);

export const runBpCheckToolDefinition = {
  name: 'run_bp_check',
  description: 'Runs xppbp.exe against the project to enforce Microsoft Best Practices.',
  parameters: z.object({
    projectPath: z.string().optional().describe('The absolute path to the .rnrproj file to check. Auto-detected from .mcp.json if omitted.'),
    targetFilter: z.string().optional().describe('Optional: filter results to a specific class, table, or object name'),
    modelName: z.string().optional().describe('Model name to check. Auto-detected from .mcp.json if omitted.'),
    packagePath: z.string().optional().describe('PackagesLocalDirectory root. Auto-detected if omitted.')
  })
};

export const runBpCheckTool = async (params: any, _context: any) => {
  const { targetFilter } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    // Resolve package path
    const packagesRoot = params.packagePath
      || configManager.getPackagePath()
      || 'K:\\AosService\\PackagesLocalDirectory';

    // Resolve model name
    const modelName = params.modelName || configManager.getModelName();
    if (!modelName) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    // Resolve project path (optional for xppbp, but useful for package resolution)
    const resolvedProjectPath = params.projectPath || await configManager.getProjectPath();

    // Locate xppbp.exe
    const xppbpPath = path.join(packagesRoot, 'Bin', 'xppbp.exe');
    try {
      await fs.access(xppbpPath);
    } catch {
      return {
        content: [{ type: 'text', text: `❌ xppbp.exe not found at: ${xppbpPath}\n\nMake sure PackagesLocalDirectory is correctly configured in .mcp.json (packagePath).` }],
        isError: true
      };
    }

    // Build xppbp.exe arguments
    // xppbp.exe -packagesroot:<root> -model:<model> [-filter:<object>] [-vsproj:<path>]
    const args: string[] = [
      `-packagesroot:${packagesRoot}`,
      `-model:${modelName}`
    ];
    if (targetFilter) {
      args.push(`-filter:${targetFilter}`);
    }
    if (resolvedProjectPath) {
      args.push(`-vsproj:${resolvedProjectPath}`);
    }

    console.error(`[run_bp_check] Running: "${xppbpPath}" ${args.join(' ')}`);

    const { stdout, stderr } = await execFileAsync(xppbpPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000 // 5 minutes
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasErrors = /error|BPError|BPCheck/i.test(output);

    return {
      content: [{
        type: 'text',
        text: (hasErrors ? '⚠️ BP Check completed with issues' : '✅ BP Check passed') +
          `\n\nModel: ${modelName}` +
          (targetFilter ? `\nFilter: ${targetFilter}` : '') +
          `\n\n${output || '(no output)'}` 
      }]
    };
  } catch (error: any) {
    console.error('Error running BP Check:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ BP Check failed:\n\n' + output }],
      isError: true
    };
  }
};
