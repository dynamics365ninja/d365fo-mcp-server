import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';

const execFileAsync = util.promisify(execFile);

export const sysTestRunnerToolDefinition = {
  name: 'run_systest_class',
  description: 'Invoke D365FO SysTest framework against a specific test class.',
  parameters: z.object({
    className: z.string().describe('The name of the SysTest class to run'),
    modelName: z.string().optional().describe('The model containing the test class. Auto-detected from .mcp.json if omitted.'),
    packagePath: z.string().optional().describe('PackagesLocalDirectory root. Auto-detected if omitted.'),
    testMethod: z.string().optional().describe('Optional: run only this specific test method within the class.')
  })
};

export const sysTestRunnerTool = async (params: any, _context: any) => {
  const { className, testMethod } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    const resolvedModelName = params.modelName || configManager.getModelName();
    if (!resolvedModelName) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    const packagesRoot = params.packagePath
      || configManager.getPackagePath()
      || 'K:\\AosService\\PackagesLocalDirectory';

    // xppbp.exe can also run SysTest classes via -runtest flag
    // Alternatively use SysTestRunner.exe if available
    const xppbpPath = path.join(packagesRoot, 'Bin', 'xppbp.exe');
    const sysTestRunnerPath = path.join(packagesRoot, 'Bin', 'SysTestRunner.exe');

    // Prefer SysTestRunner.exe, fall back to xppbp.exe
    let runnerPath: string;
    try {
      await fs.access(sysTestRunnerPath);
      runnerPath = sysTestRunnerPath;
    } catch {
      try {
        await fs.access(xppbpPath);
        runnerPath = xppbpPath;
      } catch {
        return {
          content: [{ type: 'text', text: `❌ Neither SysTestRunner.exe nor xppbp.exe found in:\n${path.join(packagesRoot, 'Bin')}\n\nMake sure PackagesLocalDirectory is correctly configured.` }],
          isError: true
        };
      }
    }

    let args: string[];
    if (runnerPath === sysTestRunnerPath) {
      // SysTestRunner.exe: -name:<className>[::testMethod] -packagePath:<path>
      const testTarget = testMethod ? `${className}::${testMethod}` : className;
      args = [
        `-name:${testTarget}`,
        `-packagePath:${packagesRoot}`,
        `-model:${resolvedModelName}`
      ];
    } else {
      // xppbp.exe: -packagesroot:<root> -model:<model> -runtest:<class>
      args = [
        `-packagesroot:${packagesRoot}`,
        `-model:${resolvedModelName}`,
        `-runtest:${className}`
      ];
      if (testMethod) args.push(`-testmethod:${testMethod}`);
    }

    console.error(`[run_systest_class] Running: "${runnerPath}" ${args.join(' ')}`);

    const { stdout, stderr } = await execFileAsync(runnerPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000 // 5 minutes
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasFailed = /failed|error|exception/i.test(output);
    const passed = /passed|success/i.test(output);

    const status = hasFailed ? '❌ Tests FAILED' : passed ? '✅ Tests passed' : '⚠️ Tests completed (check output)';

    return {
      content: [{
        type: 'text',
        text: `${status}\n\nClass: ${className}` +
          (testMethod ? `::${testMethod}` : '') +
          `\nModel: ${resolvedModelName}` +
          `\n\n${output || '(no output)'}`
      }]
    };
  } catch (error: any) {
    console.error('Error running test:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ Tests failed:\n\n' + output }],
      isError: true
    };
  }
};
