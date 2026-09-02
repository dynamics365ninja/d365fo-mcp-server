import { execFile } from 'child_process';
import { parseSysTestXml } from './sysTestXml.js';
import util from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { getConfigManager } from '../../utils/configManager.js';
import { defaultPackagesRoot } from '../../utils/packagesRoot.js';
import { withOperationLock } from '../../utils/operationLocks.js';
import { wasCreatedThisSession } from '../../workspace/createdArtifactLedger.js';

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

/** The four settings that decide which database SysTestConsole opens. */
const DATA_ACCESS_KEYS = [
  'DataAccess.Database',
  'DataAccess.SqlUser',
  'DataAccess.SqlPwd',
  'DataAccess.DbServer',
] as const;

/** One `<add key="…" value="…"/>` out of a .config document. */
export function readAppSetting(xml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<add\\s+key="${escaped}"\\s+value="([^"]*)"`, 'i').exec(xml)?.[1];
}

export interface DataAccessDrift {
  key: string;
  /** Never the secret itself — a password is described, not quoted. */
  runner: string;
  aos: string;
}

/**
 * Describe a DataAccess value without leaking it. The password is an encrypted
 * blob hundreds of characters long; what a reader needs to know is whether it
 * is the shipped placeholder, and whether the two files carry the same one.
 */
function describeSetting(key: string, value: string | undefined): string {
  if (value === undefined) return 'absent';
  if (!/pwd|password/i.test(key)) return value === '' ? '(empty)' : `\`${value}\``;
  if (value === '$CREDENTIAL_PLACEHOLDER$') return 'the shipped `$CREDENTIAL_PLACEHOLDER$` — never filled in';
  return value === '' ? '(empty)' : `set (${value.length} chars, not shown)`;
}

/**
 * Compare the test runner's connection settings with the AOS's own.
 *
 * Read-only, and it never returns a secret: the password contributes only
 * "placeholder" / "set" / "differs". Returns undefined when either file cannot
 * be read, so the caller falls back to generic advice rather than inventing a
 * diagnosis from a missing file.
 */
export async function compareSysTestDataAccess(
  packagesRoot: string,
  webConfigPath = path.join(packagesRoot, '..', 'WebRoot', 'web.config'),
): Promise<DataAccessDrift[] | undefined> {
  try {
    const [runnerXml, aosXml] = await Promise.all([
      fs.readFile(path.join(packagesRoot, 'Bin', 'SysTestConsole.exe.config'), 'utf-8'),
      fs.readFile(webConfigPath, 'utf-8'),
    ]);

    const drift: DataAccessDrift[] = [];
    for (const key of DATA_ACCESS_KEYS) {
      const runner = readAppSetting(runnerXml, key);
      const aos = readAppSetting(aosXml, key);
      // A key the AOS does not carry says nothing about the runner's copy.
      if (aos === undefined || runner === aos) continue;
      drift.push({ key, runner: describeSetting(key, runner), aos: describeSetting(key, aos) });
    }
    return drift;
  } catch {
    return undefined;
  }
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

/**
 * The red-first commentary — the half of the TDD loop a result line cannot carry.
 *
 * "2/2 passed" is ordinary news for a test that has existed for weeks and a RED
 * FLAG for one written minutes ago: a test that passes the first time it runs has
 * proven nothing about the assertion inside it. The scaffold emits
 * `this.fail('… is not implemented yet.')` in every method precisely so the first
 * run is red, and the failure mode is a developer who deletes those lines while
 * writing the behaviour and never sees a red phase at all.
 *
 * Both signals are derived, not asked for. The session ledger already knows which
 * objects this process created, and the scaffold's own failure text identifies an
 * unwritten assertion — so there is no `expectRed` parameter to publish, nothing
 * for a strict MCP client to drop, and no ListTools bytes spent (headroom at the
 * time of writing: 49 chars of 45,000).
 */
export function renderRedPhaseNote(
  className: string,
  outcomes: readonly { name: string; passed: boolean; message?: string }[],
): string {
  if (outcomes.length === 0) return '';
  const unwritten = outcomes.filter(o => !o.passed && /not implemented yet/i.test(o.message ?? ''));
  if (unwritten.length > 0) {
    return `\n\n🔴 **Red phase confirmed.** ${unwritten.length} of ${outcomes.length} method(s) still carry the ` +
      'scaffold\'s `this.fail(...)` — replace each one with the assertion the test exists for, then run again.';
  }
  if (outcomes.every(o => o.passed) && wasCreatedThisSession(className)) {
    return `\n\n⚠️ **Every method passed, and \`${className}\` was created in this session.** A test that passes ` +
      'the first time it runs has proven nothing about its assertion. Check that each method actually ' +
      'asserts something, then break the behaviour on purpose once and watch this go red.';
  }
  return '';
}

export const sysTestRunnerTool = async (params: any, _context: any) => {
  const { className, testMethod } = params;
  // Hoisted out of the try: the failure diagnosis in the catch reads the
  // runner's own .config out of this directory, and a diagnosis that cannot
  // find the file falls back to generic advice rather than guessing.
  let packagesRoot = '';
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

    packagesRoot = params.packagePath
      || configManager.getPackagePath()
      || defaultPackagesRoot();

    // SysTestConsole.exe is the binary D365FO ships for running SysTest classes from the CLI
    // (`/test:<class> /xml:<file>`). xppbp.exe is the BP checker and cannot run tests.
    // SysTestRunner.exe is a legacy/forward-compat fallback, not observed on real installs.
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
      //
      // /unattended is what makes this usable from a tool at all. This runner was
      // recorded as blocked ("requires an interactive console session, a platform
      // limitation") and it is not: with /unattended the binary skips the prompt
      // and goes straight to "Executing test(s) ....". Its own /? documents the
      // flag against /devfabric, but it applies here too.
      xmlResultPath = path.join(os.tmpdir(), `systest-${className}-${Date.now()}.xml`);
      args = [`/test:${className}`, `/xml:${xmlResultPath}`, '/unattended'];
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
        // Best-effort — fall back to stdout/stderr below.
      }
    }

    const output = [stdout, stderr, xmlResult].filter(Boolean).join('\n').trim();

    // The XML document the runner writes is authoritative and per METHOD. The
    // regex fallback below reads the combined stdout, where the word "error" in a
    // test name is enough to report a green run as failed.
    const outcomes = parseSysTestXml(xmlResult);
    const failedOutcomes = outcomes.filter(o => !o.passed);
    const hasFailed = outcomes.length > 0
      ? failedOutcomes.length > 0
      : /failed|error|exception/i.test(output);
    const passed = outcomes.length > 0
      ? failedOutcomes.length === 0
      : /passed|success/i.test(output);

    const status = hasFailed ? '❌ Tests FAILED' : passed ? '✅ Tests passed' : '⚠️ Tests completed (check output)';
    const methodNote = testMethod && runnerPath === sysTestConsolePath
      ? `\n⚠️ testMethod="${testMethod}" was requested but SysTestConsole.exe has no per-method filter — the whole class ran.`
      : '';

    // Per-method lines first: which test failed and why is the answer being asked
    // for, and it is otherwise buried in the raw document.
    const perMethod = outcomes.length > 0
      ? '\n\n' + outcomes
        .map(o => `${o.passed ? '✅' : '❌'} ${o.name}${o.message ? ` — ${o.message}` : ''}`)
        .join('\n') +
        `\n\n${outcomes.length - failedOutcomes.length}/${outcomes.length} passed.`
      : '';

    // A test method the caller asked about that never appears in the results is
    // worth saying out loud: a misspelt name otherwise reads as a clean run.
    const focus = testMethod?.trim();
    const focusNote = focus && outcomes.length > 0 && !outcomes.some(o => o.name.toLowerCase().includes(focus.toLowerCase()))
      ? `\n\n⚠️ No test named "${focus}" ran. Check the spelling against the list above.`
      : '';

    const redPhaseNote = renderRedPhaseNote(className, outcomes);

    return {
      content: [{
        type: 'text',
        text: `${status}\n\nClass: ${className}` +
          (testMethod && runnerPath === sysTestRunnerPath ? `::${testMethod}` : '') +
          `\nModel: ${resolvedModelName}` +
          methodNote +
          perMethod +
          focusNote +
          redPhaseNote +
          `\n\n${output || '(no output)'}`
      }]
    };
  } catch (error: any) {
    console.error('Error running test:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');

    // A binding redirect that names a version the install does not have. Seen on
    // 10.0.4x: SysTestConsole.exe.config redirects Microsoft.ApplicationInsights
    // to 2.22.0.997 while Bin ships 2.23.0.0, so the telemetry logger the runner
    // touches on its way into ExecuteTest throws before a single test runs. The
    // message names an assembly and no test, which reads like a broken test model.
    const bindingFailure = /Could not load file or assembly '([^']+?),\s*Version=([\d.]+)/i.exec(output);
    if (bindingFailure) {
      const [, assembly, wanted] = bindingFailure;
      // Two different faults wear the same sentence. A VERSION mismatch means the
      // DLL is there and the redirect points elsewhere; a MISSING file means the
      // redirect is right and the assembly was never copied into Bin. The fixes
      // are not the same, so the message must not average them.
      const versionMismatch = /manifest definition does not match|0x80131040/i.test(output);
      const missingFile = /cannot find the file specified|FileNotFoundException/i.test(output);
      if (versionMismatch || missingFile) {
        const diagnosis = versionMismatch
          ? `PackagesLocalDirectory\\Bin\\SysTestConsole.exe.config redirects ${assembly} to ${wanted}, ` +
            'while the DLL shipped next to it is a different version. Read the version actually ' +
            'present and point the redirect at it:\n' +
            `  [Reflection.AssemblyName]::GetAssemblyName("<PackagesLocalDirectory>\\Bin\\${assembly}.dll").Version\n` +
            '(the ASSEMBLY version, not the file version — they differ)'
          : `${assembly} ${wanted} is not in PackagesLocalDirectory\\Bin at all. The redirect is fine; ` +
            'the file was never copied there. Other copies usually exist in the install:\n' +
            `  Get-ChildItem "<PackagesLocalDirectory>" -Filter ${assembly}.dll -Recurse -Depth 4\n` +
            'Copying the matching version into Bin is what makes the runner start.';
        return {
          content: [{
            type: 'text',
            text:
              `❌ The test runner could not start: ${assembly} ${wanted}.\n\n` +
              'No test ran, and nothing is wrong with the test class — this is an assembly problem in ' +
              `the PLATFORM install, not in the model.\n\n${diagnosis}\n\n` +
              'Either fix touches the platform installation, so make it deliberately and keep a backup. ' +
              'Until then the tests still run from Visual Studio Test Explorer, which does not go ' +
              'through this binary.\n\n' + output,
          }],
          isError: true,
        };
      }
    }

    // The runner got as far as the database and could not log in. Everything about
    // the model, the test and the binary is fine at this point; the fault is in the
    // connection SysTestConsole opened, which no change to the test can fix.
    //
    // Two faults wear this same sentence, and they are not fixed the same way:
    // a credential that genuinely stopped working, and — far more often — a
    // SysTestConsole.exe.config that was never configured for this machine at
    // all. The shipped template carries `$CREDENTIAL_PLACEHOLDER$` for the
    // password and its own guesses for the database, user and server; the AOS
    // web.config beside it holds the real four. On this VM every one of the four
    // differed, and "Login failed for user 'AOSUser'" was read as a rotated
    // password for weeks when nothing had rotated. So compare them and say which.
    const sqlLogin = /Login failed for user '([^']+)'/i.exec(output);
    if (sqlLogin) {
      const drift = packagesRoot ? await compareSysTestDataAccess(packagesRoot) : undefined;
      const diagnosis = drift?.length
        ? 'The runner\'s own configuration does not match this machine\'s AOS. ' +
          `\`Bin\\SysTestConsole.exe.config\` disagrees with \`WebRoot\\web.config\` on ` +
          `${drift.length} of the four DataAccess settings:\n\n` +
          drift.map(d => `  • \`${d.key}\` — runner: ${d.runner}, AOS: ${d.aos}`).join('\n') +
          '\n\nThat is a template that was never filled in for this install, not a credential that ' +
          'stopped working. Copy the four values from web.config into SysTestConsole.exe.config ' +
          '(keep a backup beside it). It touches the PLATFORM install, so make it deliberately — ' +
          'and note that the password there is an encrypted blob: copy it verbatim, do not retype it.'
        : 'SysTestConsole opens the AOS connection itself, using its own configuration in ' +
          '`Bin\\SysTestConsole.exe.config`. Compare its DataAccess.Database / SqlUser / SqlPwd / ' +
          'DbServer against `WebRoot\\web.config`: the shipped template ships a placeholder password ' +
          'and its own guesses for the rest, and a mismatch there reads exactly like a rotated ' +
          'credential. If they already agree, the login itself is the problem — check that SQL Server ' +
          'still has it and that the AOS service account can decrypt the stored password.';

      return {
        content: [{
          type: 'text',
          text:
            `❌ The test runner reached the database and could not log in as '${sqlLogin[1]}'.\n\n` +
            'No test ran, and nothing is wrong with the test class or the model.\n\n' +
            `${diagnosis}\n\n` +
            'Until then the tests still run from Visual Studio Test Explorer, which uses the ' +
            'developer session\'s own connection and does not go through this binary.\n\n' + output,
        }],
        isError: true,
      };
    }

    if (/WaitForDebugger|Cannot read keys when/i.test(output)) {
      return {
        content: [{
          type: 'text',
          text: '❌ SysTestConsole.exe stopped at its debugger-attach prompt (Console.ReadKey).\n\n' +
            'This tool already passes /unattended, which is what normally skips that prompt. If it ' +
            'still appears, run the test from an interactive RDP/console session on the dev VM, or ' +
            'from Visual Studio Test Explorer.\n\n' + output,
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
