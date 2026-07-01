import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

/**
 * Guard against shell-injection characters in values that are embedded in
 * execFile argument arrays.  execFile() does NOT use a shell, but embedded
 * newlines or quotes can still corrupt the argument stream on some platforms.
 */
function assertSafePath(value: string, label: string): void {
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a command: ${value}`
    );
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

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

    // SysTestConsole.exe is the binary D365FO actually ships for running SysTest
    // classes from the command line (verified CLI: `/test:<class> /xml:<file>`).
    // xppbp.exe is the BP checker and has NO test-running capability — an earlier
    // version of this tool assumed a `-runtest:` flag that does not exist on it.
    // SysTestRunner.exe is kept as a legacy/forward-compat fallback in case a
    // future or differently-packaged install ships it; it has not been observed
    // on a real D365FO install.
    const sysTestConsolePath = path.join(packagesRoot, 'Bin', 'SysTestConsole.exe');
    const sysTestRunnerPath = path.join(packagesRoot, 'Bin', 'SysTestRunner.exe');

    let runnerPath: string;
    try {
      await fs.access(sysTestConsolePath);
      runnerPath = sysTestConsolePath;
    } catch {
      try {
        await fs.access(sysTestRunnerPath);
        runnerPath = sysTestRunnerPath;
      } catch {
        return {
          content: [{ type: 'text', text: `❌ Neither SysTestConsole.exe nor SysTestRunner.exe found in:\n${path.join(packagesRoot, 'Bin')}\n\nMake sure PackagesLocalDirectory is correctly configured.` }],
          isError: true
        };
      }
    }

    let args: string[];
    // Validate user-supplied values before embedding them in command arguments.
    try {
      assertSafePath(className, 'className');
      assertSafePath(resolvedModelName, 'modelName');
      assertSafePath(packagesRoot, 'packagesRoot');
      if (testMethod) assertSafePath(testMethod, 'testMethod');
    } catch (validationErr: any) {
      return {
        content: [{ type: 'text', text: `❌ Invalid parameter: ${validationErr.message}` }],
        isError: true,
      };
    }

    let xmlResultPath: string | undefined;
    if (runnerPath === sysTestRunnerPath) {
      // SysTestRunner.exe (legacy/forward-compat fallback): -name:<className>[::testMethod] -packagePath:<path>
      const testTarget = testMethod ? `${className}::${testMethod}` : className;
      args = [
        `-name:${testTarget}`,
        `-packagePath:${packagesRoot}`,
        `-model:${resolvedModelName}`
      ];
    } else {
      // SysTestConsole.exe: /test:<className>[,<className2>,...] /xml:<outFile>
      // No documented per-method filter flag — testMethod is not applicable here.
      xmlResultPath = path.join(os.tmpdir(), `systest-${className}-${Date.now()}.xml`);
      args = [`/test:${className}`, `/xml:${xmlResultPath}`];
    }

    console.error(`[run_systest_class] Running: "${runnerPath}" ${args.join(' ')}`);

    const { stdout, stderr } = await withOperationLock(
      `systest:${resolvedModelName}:${className}`,
      () => execFileAsync(runnerPath, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300_000, // 5 minutes
        windowsHide: true,
      }),
    );

    let xmlResult = '';
    if (xmlResultPath) {
      try {
        xmlResult = await fs.readFile(xmlResultPath, 'utf8');
      } catch {
        // Best-effort only — SysTestConsole may name/format the result file
        // differently than expected; fall back to stdout/stderr below.
      }
    }

    const output = [stdout, stderr, xmlResult].filter(Boolean).join('\n').trim();
    const hasFailed = /failed|error|exception/i.test(output);
    const passed = /passed|success/i.test(output);

    const status = hasFailed ? '❌ Tests FAILED' : passed ? '✅ Tests passed' : '⚠️ Tests completed (check output)';
    const methodNote = testMethod && runnerPath === sysTestConsolePath
      ? `\n⚠️ testMethod="${testMethod}" was requested but SysTestConsole.exe has no per-method filter — the whole class ran.`
      : '';

    return {
      content: [{
        type: 'text',
        text: `${status}\n\nClass: ${className}` +
          (testMethod && runnerPath === sysTestRunnerPath ? `::${testMethod}` : '') +
          `\nModel: ${resolvedModelName}` +
          methodNote +
          `\n\n${output || '(no output)'}`
      }]
    };
  } catch (error: any) {
    console.error('Error running test:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');

    if (/WaitForDebugger|Cannot read keys when/i.test(output)) {
      return {
        content: [{
          type: 'text',
          text: '❌ SysTestConsole.exe requires an interactive console session.\n\n' +
            'It unconditionally calls a debugger-attach prompt (Console.ReadKey) before running any ' +
            'test, even in local-AOS mode. This fails when invoked from a non-interactive/automation ' +
            'session (no real console available) — confirmed even with a freshly allocated console window. ' +
            'This is a platform limitation of SysTestConsole.exe itself, not a bug in this tool.\n\n' +
            'Workaround: run the test from an interactive RDP/console session on the dev VM, or wire up ' +
            'vstest.console.exe with RunnableDropSysTest.TestAdapter.dll (shipped alongside SysTestConsole.exe), ' +
            'which is the non-interactive path Microsoft documents for CI.\n\n' + output,
        }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: '❌ Tests failed:\n\n' + output }],
      isError: true
    };
  }
};
