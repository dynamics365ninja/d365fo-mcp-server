import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const { accessMock, readdirMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath } = vi.hoisted(() => {
  const accessMock = vi.fn();
  // Bin listing for the versioned SysTestConsole lookup; empty unless a test lists files.
  const readdirMock = vi.fn().mockResolvedValue([]);
  const readFileMock = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  // execFile needs a callback-style API for util.promisify
  const execFileMock: any = vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: '✅ Tests passed', stderr: '' });
  });
  const cfgEnsureLoaded = vi.fn();
  const cfgGetModelName = vi.fn().mockReturnValue('Contoso');
  const cfgGetPackagePath = vi.fn().mockReturnValue('K:\\AOSService\\PackagesLocalDirectory');
  return { accessMock, readdirMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath };
});

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('fs/promises', () => {
  const m = { access: accessMock, readFile: readFileMock, readdir: readdirMock };
  return { ...m, default: m };
});
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: cfgEnsureLoaded,
    getModelName: cfgGetModelName,
    getPackagePath: cfgGetPackagePath,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import path from 'path';
import { sysTestRunnerTool, compareSysTestDataAccess, findSysTestConsole, findSysTestConsoles } from '../../src/tools/sdlc/sysTestRunner';
import { capToolResponse } from '../../src/tools/responseCaps';
import { parseSysTestResult } from '../../src/eval/oracle/systest';

const PKG = 'K:\\AOSService\\PackagesLocalDirectory';
const SYSTEST_CONSOLE = path.join(PKG, 'Bin', 'SysTestConsole.exe');
const SYSTEST_RUNNER = path.join(PKG, 'Bin', 'SysTestRunner.exe');
const SYSTEST_CONSOLE_17 = path.join(PKG, 'Bin', 'SysTestConsole.17.0.exe');

function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    if (paths.some(a => norm(a) === norm(p))) return;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
}

function capturedArgs(callIndex = 0): string[] {
  return execFileMock.mock.calls[callIndex]?.[1] ?? [];
}

describe('run_systest_class — binary resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅ Tests passed', stderr: '' });
    });
  });

  it('prefers SysTestConsole.exe when present', async () => {
    allowPaths([SYSTEST_CONSOLE]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    const [exe] = execFileMock.mock.calls[0];
    expect(exe).toBe(SYSTEST_CONSOLE);
  });

  it('uses /test: and /xml: flags for SysTestConsole.exe', async () => {
    allowPaths([SYSTEST_CONSOLE]);

    await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    const args = capturedArgs(0);
    expect(args).toContain('/test:ContosoMyTest');
    expect(args.some(a => a.startsWith('/xml:'))).toBe(true);
    // SysTestConsole has no -model:/-packagePath: flags (unlike the legacy fallback)
    expect(args.some(a => a.startsWith('-model:'))).toBe(false);
  });

  it('falls back to SysTestRunner.exe when SysTestConsole.exe is absent', async () => {
    allowPaths([SYSTEST_RUNNER]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest', testMethod: 'testFoo' }, {});

    expect(result.isError).toBeFalsy();
    const [exe] = execFileMock.mock.calls[0];
    expect(exe).toBe(SYSTEST_RUNNER);
    const args = capturedArgs(0);
    expect(args).toContain('-name:ContosoMyTest::testFoo');
    expect(args).toContain('-model:Contoso');
  });

  it('runs SysTestConsole.17.0.exe when that is the only SysTestConsole in Bin (#1143)', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe', 'SysTestConsole.17.0.exe.config', 'xppc.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock.mock.calls[0][0]).toBe(SYSTEST_CONSOLE_17);
    expect(capturedArgs(0)).toEqual(expect.arrayContaining(['/test:ContosoMyTest', '/unattended']));
  });

  it('prefers the versioned SysTestConsole over a plain one left by an older platform', async () => {
    // A 7.0.7858 dev VM: SysTestConsole.17.0.exe is 7.0.7858.111, like xppc.exe;
    // SysTestConsole.exe is 7.0.7452.66, from December 2024.
    readdirMock.mockResolvedValue(['SysTestConsole.exe', 'SysTestConsole.exe.config', 'SysTestConsole.17.0.exe', 'SysTestConsole.17.0.exe.config']);
    allowPaths([SYSTEST_CONSOLE, SYSTEST_CONSOLE_17]);

    await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(execFileMock.mock.calls[0][0]).toBe(SYSTEST_CONSOLE_17);
  });

  it('errors when neither binary is found', async () => {
    allowPaths([]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Neither SysTestConsole.exe nor SysTestRunner.exe found');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('errors when model name cannot be determined', async () => {
    cfgGetModelName.mockReturnValue(null);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot determine model name');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('notes that testMethod is ignored when running via SysTestConsole.exe', async () => {
    allowPaths([SYSTEST_CONSOLE]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest', testMethod: 'testFoo' }, {});

    expect(result.content[0].text).toContain('no per-method filter');
  });

  it('names the versioned SysTestConsole in that note', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest', testMethod: 'testFoo' }, {});

    expect(result.content[0].text).toContain('but SysTestConsole.17.0.exe has no per-method filter');
  });
});

describe('run_systest_class — interactive console blocker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('recognizes the WaitForDebugger/Console.ReadKey crash and explains it clearly', async () => {
    const err = Object.assign(new Error('Command failed'), {
      stdout: 'To debug, please attach VS debugger to SysTestConsole.exe now ...\nPress any key to continue..',
      stderr: 'Unhandled Exception: System.InvalidOperationException: Cannot read keys when either ' +
        'application does not have a console or when console input has been redirected from a file.\n' +
        '   at System.Console.ReadKey(Boolean intercept)\n' +
        '   at Microsoft.Dynamics.AX.Framework.SysTest.SysTestConsole.WaitForDebugger()',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    // The message no longer calls the runner interactive-only: /unattended is
    // passed and normally skips this prompt, so it now says what to do if the
    // prompt appears anyway.
    expect(result.content[0].text).toContain('debugger-attach prompt');
    expect(result.content[0].text).toContain('/unattended');
  });

  it('names the versioned SysTestConsole that stopped at the prompt', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(Object.assign(new Error('Command failed'), {
        stdout: '',
        stderr: 'Unhandled Exception: System.InvalidOperationException: Cannot read keys when either ' +
          'application does not have a console or when console input has been redirected from a file.',
      }));
    });

    const text = (await sysTestRunnerTool({ className: 'ContosoMyTest' }, {})).content[0].text;

    expect(text).toContain('SysTestConsole.17.0.exe stopped at its debugger-attach prompt');
  });

  it('a plain test failure is NOT misclassified as the interactive-console blocker', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '❌ Tests FAILED\n\nContosoMyTest::testFoo failed: assertion error', stderr: '' });
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Tests FAILED');
    expect(result.content[0].text).not.toContain('debugger-attach prompt');
  });
});

describe('run_systest_class — the platform binding mismatch that stops a run', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('names the assembly and the config redirect instead of blaming the test', async () => {
    // Real output from this VM: the runner's own config redirects
    // Microsoft.ApplicationInsights to 2.22.0.997 while Bin ships 2.23.0.0, so the
    // telemetry logger throws before any test runs.
    const err = Object.assign(new Error('Command failed'), {
      stdout: 'Executing test(s) ....\n\nSystem.IO.FileLoadException: Could not load file or assembly ' +
        "'Microsoft.ApplicationInsights, Version=2.22.0.997, Culture=neutral, PublicKeyToken=31bf3856ad364e35' " +
        "or one of its dependencies. The located assembly's manifest definition does not match the assembly " +
        'reference. (Exception from HRESULT: 0x80131040)',
      stderr: '',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Microsoft.ApplicationInsights');
    expect(text).toContain('2.22.0.997');
    expect(text).toContain('SysTestConsole.exe.config');
    expect(text).toMatch(/No test ran/i);
    // It must not read as a test failure — nothing was executed.
    expect(text).not.toContain('Tests FAILED');
  });

  it('names the .config of the versioned SysTestConsole that ran', async () => {
    // Only the versioned one: with the plain one beside it, a run that cannot start falls back to it.
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(Object.assign(new Error('Command failed'), {
        stdout: "Could not load file or assembly 'Microsoft.ApplicationInsights, Version=2.22.0.997, " +
          "Culture=neutral, PublicKeyToken=31bf3856ad364e35'. (Exception from HRESULT: 0x80131040)",
        stderr: '',
      }));
    });

    const text = (await sysTestRunnerTool({ className: 'ContosoMyTest' }, {})).content[0].text;

    expect(text).toContain('Bin\\SysTestConsole.17.0.exe.config redirects Microsoft.ApplicationInsights');
  });

  it('passes /unattended so the runner does not stop at the debugger prompt', async () => {
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation((_f: string, a: string[], _o: any, cb: Function) => {
      capturedArgs = a;
      cb(null, { stdout: 'ok', stderr: '' });
    });

    await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(capturedArgs).toContain('/unattended');
  });
});

describe('run_systest_class — a MISSING assembly is not the same fault as a wrong version', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('tells the caller to copy the file, not to edit a redirect', async () => {
    // Second fault seen on this VM once the redirect was fixed: the assembly the
    // (correct) redirect names is simply not in Bin.
    const err = Object.assign(new Error('Command failed'), {
      stdout: 'Executing test(s) ....\n\nSystem.IO.FileNotFoundException: Could not load file or assembly ' +
        "'System.ValueTuple, Version=4.0.3.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51' or one of " +
        'its dependencies. The system cannot find the file specified.',
      stderr: '',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('System.ValueTuple');
    expect(text).toContain('is not in PackagesLocalDirectory\\Bin at all');
    expect(text).toMatch(/Get-ChildItem/);
    // The redirect advice belongs to the other fault and must not appear here.
    expect(text).not.toMatch(/point the redirect at it/);
    expect(text).not.toContain('Tests FAILED');
  });
});

describe('findSysTestConsole', () => {
  const BIN = path.join(PKG, 'Bin');
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    allowPaths([]);
  });

  it('takes the highest version, compared as numbers', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.9.0.exe', 'SysTestConsole.17.10.exe', 'SysTestConsole.17.2.exe']);
    expect(await findSysTestConsole(BIN)).toBe(path.join(BIN, 'SysTestConsole.17.10.exe'));
  });

  it('ignores configs and look-alike names, case aside', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe.config', 'SysTestConsoleX.exe', 'SysTestConsole..exe', 'systestconsole.17.0.EXE']);
    expect(await findSysTestConsole(BIN)).toBe(path.join(BIN, 'systestconsole.17.0.EXE'));
  });

  it('falls back to SysTestConsole.exe, and to null, when no versioned one exists', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.exe']);
    allowPaths([path.join(BIN, 'SysTestConsole.exe')]);
    expect(await findSysTestConsole(BIN)).toBe(path.join(BIN, 'SysTestConsole.exe'));

    allowPaths([]);
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await findSysTestConsole(BIN)).toBeNull();
  });

  it('lists every SysTestConsole, versioned first and the plain one last', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.exe', 'SysTestConsole.17.0.exe']);
    allowPaths([path.join(BIN, 'SysTestConsole.exe')]);
    expect(await findSysTestConsoles(BIN)).toEqual([
      path.join(BIN, 'SysTestConsole.17.0.exe'),
      path.join(BIN, 'SysTestConsole.exe'),
    ]);
  });
});

/**
 * A 7.0.7858 VM where SysTestConsole.17.0.exe cannot start: System.ValueTuple 4.0.3.0 is not in Bin
 * (exit -1, no test run) and its .config is the unconfigured template, while the plain
 * SysTestConsole.exe beside it was configured and runs green. Preferring the versioned binary must
 * not take a working runner away.
 */
describe('run_systest_class — a SysTestConsole that cannot start hands over to the next', () => {
  const VALUE_TUPLE_MISSING = "System.IO.FileNotFoundException: Could not load file or assembly 'System.ValueTuple, " +
    "Version=4.0.3.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51' or one of its dependencies. The system cannot find the file specified.";

  /** Per binary: an error to fail with, or undefined to pass. */
  function runners(failures: Record<string, { stdout?: string; stderr?: string } | undefined>) {
    execFileMock.mockImplementation((file: string, _a: string[], _o: any, cb: Function) => {
      const failure = failures[path.basename(file)];
      if (failure) cb(Object.assign(new Error('Command failed'), { stdout: '', stderr: '', ...failure }));
      else cb(null, { stdout: 'Rainier Test Suite : 1 Run, 0 Failed', stderr: '' });
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    readdirMock.mockResolvedValue(['SysTestConsole.exe', 'SysTestConsole.exe.config', 'SysTestConsole.17.0.exe', 'SysTestConsole.17.0.exe.config']);
    allowPaths([SYSTEST_CONSOLE, SYSTEST_CONSOLE_17]);
  });

  it('runs the plain SysTestConsole when the versioned one is missing an assembly, and says so', async () => {
    runners({ 'SysTestConsole.17.0.exe': { stdout: VALUE_TUPLE_MISSING } });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});
    const text = result.content[0].text;

    expect(result.isError).toBeFalsy();
    expect(execFileMock.mock.calls.map(c => c[0])).toEqual([SYSTEST_CONSOLE_17, SYSTEST_CONSOLE]);
    expect(text).toContain('SysTestConsole.17.0.exe could not start (System.ValueTuple 4.0.3.0 would not load), so SysTestConsole.exe ran instead.');
    expect(text).not.toContain('could not start: System.ValueTuple');
  });

  it('runs the plain SysTestConsole when the versioned one cannot log in', async () => {
    runners({ 'SysTestConsole.17.0.exe': { stdout: "Login failed for user 'AOSUser'." } });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock.mock.calls.map(c => c[0])).toEqual([SYSTEST_CONSOLE_17, SYSTEST_CONSOLE]);
    expect(result.content[0].text).toContain("its .config could not log in as 'AOSUser'");
  });

  it('diagnoses the last runner when none can start, and still names the one before it', async () => {
    runners({
      'SysTestConsole.17.0.exe': { stdout: VALUE_TUPLE_MISSING },
      'SysTestConsole.exe': { stdout: "Login failed for user 'AOSUser'." },
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(text).toContain("could not log in as 'AOSUser'");
    expect(text).toContain('Bin\\SysTestConsole.exe.config');
    expect(text).toContain('SysTestConsole.17.0.exe could not start (System.ValueTuple 4.0.3.0 would not load)');
  });

  it('does not retry a failure that is not a startup fault', async () => {
    runners({ 'SysTestConsole.17.0.exe': { stdout: 'ContosoMyTest::testFoo failed: assertion error' } });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).not.toContain('ran instead');
  });

  it('keeps the versioned diagnosis when it is the only SysTestConsole', async () => {
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);
    runners({ 'SysTestConsole.17.0.exe': { stdout: VALUE_TUPLE_MISSING } });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('❌ The test runner could not start: System.ValueTuple 4.0.3.0.');
  });
});

/**
 * A class with failing tests. SysTestConsole exits non-zero when a test fails,
 * so execFile rejects; the run is still complete and its XML result written.
 * The failures and counts must come from that XML, ahead of a raw log long
 * enough to be cut by the response cap.
 */
describe('run_systest_class — a run whose tests fail', () => {
  const CLASS = 'MTF_EInvoiceSendToGatewayServiceTests';
  const names = Array.from({ length: 43 }, (_, i) => `test_case${String(i + 1).padStart(2, '0')}`);
  const FAILING: Record<string, string> = {
    test_case07: 'Assert.areEqual failed: expected Sent, actual Pending',
    test_case39: 'Assert.isTrue failed: gateway status was not updated',
  };
  const XML = '<?xml version="1.0"?><test-results><results>' +
    names.map(n => FAILING[n]
      ? `<test-case name="${CLASS}.${n}" success="false"><failure><message>${FAILING[n]}</message></failure></test-case>`
      : `<test-case name="${CLASS}.${n}" success="true" />`).join('') +
    '</results></test-results>';
  // ~39 KB of console log, its stack traces long enough to bury everything after them.
  const STACK = Array.from({ length: 150 }, (_, i) =>
    `   at Dynamics.AX.Application.MTF_EInvoiceSendToGatewayService.frame${i}() in xppSource://Source/Mountfield\\AxClass_MTF_EInvoiceSendToGatewayService.xpp:line ${i}`).join('\n');
  const LOG = `Executing test(s) ....\n${names.map(n => FAILING[n] ? `${n} failed: ${FAILING[n]}\n${STACK}` : `${n} passed`).join('\n')}\n` +
    'Rainier Test Suite : 43 Run, 2 Failed';

  const capped = (result: any) => capToolResponse('run_systest_class', result).content[0].text as string;

  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('MountfieldTests');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE_17]);
    readFileMock.mockImplementation(async (p: string) => {
      if (/systest-.*\.xml$/.test(p)) return XML;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // What execFile hands back for a process that exited 1.
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(Object.assign(new Error(`Command failed: ${SYSTEST_CONSOLE_17} /test:${CLASS}`), { code: 1, stdout: LOG, stderr: '' }));
    });
  });

  it('reports the failing tests from the XML, not as a runner error', async () => {
    const result = await sysTestRunnerTool({ className: CLASS }, {});
    const text = result.content[0].text;

    expect(result.isError).toBeFalsy();
    expect(text.startsWith('❌ Tests FAILED')).toBe(true);
    expect(text).not.toContain('❌ Tests failed:');
    expect(text).toContain('41/43 passed, 2 failed.');
  });

  it('keeps the counts and every failure inside the response cap', async () => {
    const text = capped(await sysTestRunnerTool({ className: CLASS }, {}));

    expect(text).toContain('41/43 passed, 2 failed.');
    for (const [name, message] of Object.entries(FAILING)) {
      expect(text).toContain(`❌ ${CLASS}.${name} — ${message}`);
    }
  });

  it('lists the failures before the passing tests and the raw log', async () => {
    const text = (await sysTestRunnerTool({ className: CLASS }, {})).content[0].text;

    const lastFailure = text.indexOf(`❌ ${CLASS}.test_case39`);
    expect(lastFailure).toBeGreaterThan(-1);
    expect(lastFailure).toBeLessThan(text.indexOf(`✅ ${CLASS}.test_case01`));
    expect(lastFailure).toBeLessThan(text.indexOf('Executing test(s)'));
  });

  it('names the XML result file and does not repeat the document itself', async () => {
    const result = await sysTestRunnerTool({ className: CLASS }, {});
    const text = result.content[0].text;
    const xmlArg = capturedArgs(0).find(a => a.startsWith('/xml:'))!.slice('/xml:'.length);

    expect(text).toContain(xmlArg);
    expect(text).not.toContain('<test-case');
  });

  it('is scored by the eval oracle as a run that failed, not one that never ran', async () => {
    const parsed = parseSysTestResult(capped(await sysTestRunnerTool({ className: CLASS }, {})));

    expect(parsed.ran).toBe(true);
    expect(parsed.passed).toBe(false);
  });

  it('still reports a runner error when a non-zero exit left no results', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await sysTestRunnerTool({ className: CLASS }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('❌ Tests failed:');
  });

  it('advises nothing the tool does not accept when the raw log is cut', async () => {
    const text = capped(await sysTestRunnerTool({ className: CLASS }, {}));

    expect(text).toContain('Response truncated');
    expect(text).not.toMatch(/methodOffset|fieldsOffset|fieldFilter|compact=/);
  });
});

describe('run_systest_class — reaching the database and failing to log in', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('Contoso');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
  });

  it('blames neither the test nor the model, and points at the runner\'s own config', async () => {
    // Third fault on this VM, once both assembly problems were fixed by config.
    // It used to be reported as a "deployment credential", which sent the reader
    // hunting a rotated password. Nothing had rotated: SysTestConsole.exe.config
    // was the shipped template, naming a different database and a different user
    // with a placeholder password.
    const err = Object.assign(new Error('Command failed'), {
      stdout: "Executing test(s) ....\n\nSystem.Data.SqlClient.SqlException (0x80131904): Login failed for user 'AOSUser'.",
      stderr: '',
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(err);
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("could not log in as 'AOSUser'");
    expect(text).toMatch(/No test ran/);
    expect(text).toContain('SysTestConsole.exe.config');
    expect(text).toContain('web.config');
    expect(text).not.toContain('Tests FAILED');
  });

  it('compares and names the .config of the versioned SysTestConsole that ran', async () => {
    // Only the versioned one: with the plain one beside it, a run that cannot start falls back to it.
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    allowPaths([SYSTEST_CONSOLE_17]);
    readFileMock.mockImplementation(async (file: string) => {
      const f = String(file).replace(/\\/g, '/').toLowerCase();
      if (f.endsWith('/bin/systestconsole.17.0.exe.config')) return '<configuration><appSettings><add key="DataAccess.Database" value="AxDbRain" /></appSettings></configuration>';
      if (f.endsWith('web.config')) return '<configuration><appSettings><add key="DataAccess.Database" value="AxDB" /></appSettings></configuration>';
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    });
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(Object.assign(new Error('Command failed'), { stdout: "Login failed for user 'AOSUser'.", stderr: '' }));
    });

    const text = (await sysTestRunnerTool({ className: 'ContosoMyTest' }, {})).content[0].text;

    expect(text).toContain('SysTestConsole.17.0.exe.config` disagrees');
    expect(text).toContain('DataAccess.Database');
  });
});

/**
 * The comparison behind that diagnosis. It reads two platform config files and
 * must never put the password in its answer — the value there is an encrypted
 * blob, and a diagnostic that quotes it would copy a secret into a transcript.
 */
describe('compareSysTestDataAccess', () => {
  const setting = (k: string, v: string) => `  <add key="${k}" value="${v}" />`;
  const doc = (rows: string[]) => [
    '<?xml version="1.0"?>',
    '<configuration>',
    '<appSettings>',
    ...rows,
    '</appSettings>',
    '</configuration>',
    '',
  ].join('\n');

  const RUNNER = doc([
    setting('DataAccess.Database', 'AxDbRain'),
    setting('DataAccess.SqlUser', 'AOSUser'),
    setting('DataAccess.SqlPwd', '$CREDENTIAL_PLACEHOLDER$'),
    setting('DataAccess.DbServer', '.'),
  ]);
  const AOS = doc([
    setting('DataAccess.Database', 'AxDB'),
    setting('DataAccess.SqlUser', 'axdbadmin'),
    setting('DataAccess.SqlPwd', 'x'.repeat(828)),
    setting('DataAccess.DbServer', 'D365DEVBOX-1'),
  ]);

  /** Serve the runner config, the AOS config, or ENOENT for anything else. */
  const serve = (runner?: string, aos?: string) => {
    readFileMock.mockImplementation(async (file: string) => {
      const f = String(file).replace(/\\/g, '/').toLowerCase();
      if (f.endsWith('systestconsole.exe.config') && runner !== undefined) return runner;
      if (f.endsWith('web.config') && aos !== undefined) return aos;
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    });
  };

  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue([]);
  });

  it('reports every setting the runner disagrees with the AOS about', async () => {
    serve(RUNNER, AOS);
    const drift = await compareSysTestDataAccess(PKG);
    expect(drift?.map(d => d.key)).toEqual([
      'DataAccess.Database', 'DataAccess.SqlUser', 'DataAccess.SqlPwd', 'DataAccess.DbServer',
    ]);
    expect(drift?.[0]).toMatchObject({ runner: '`AxDbRain`', aos: '`AxDB`' });
  });

  it('never puts the password in its answer', async () => {
    serve(RUNNER, AOS);
    const rendered = JSON.stringify(await compareSysTestDataAccess(PKG));
    expect(rendered).not.toContain('x'.repeat(828));
    // What a reader actually needs: that the runner's is the shipped placeholder,
    // and that the AOS has a real one — its length, not its bytes.
    expect(rendered).toContain('$CREDENTIAL_PLACEHOLDER$');
    expect(rendered).toContain('828 chars, not shown');
  });

  it('says nothing when the two agree', async () => {
    serve(AOS, AOS);
    expect(await compareSysTestDataAccess(PKG)).toEqual([]);
  });

  it('returns undefined — not an empty drift — when a file is missing', async () => {
    // An unreadable file is not evidence that the settings match; the caller
    // must fall back to generic advice instead of claiming they agree.
    serve(RUNNER, undefined);
    expect(await compareSysTestDataAccess(PKG)).toBeUndefined();
  });

  it('compares the live settings, not commented-out or reordered copies', async () => {
    // The runner config keeps the old database in a comment and writes the live
    // entry value-first: the regex reader saw only the comment, and so reported
    // a drift (AxDbRain vs AxDB) that the files do not have.
    serve(doc([
      '  <!-- <add key="DataAccess.Database" value="AxDbRain" /> -->',
      '  <add value="AxDB" key="DataAccess.Database" />',
      setting('DataAccess.SqlUser', 'axdbadmin'),
      setting('DataAccess.SqlPwd', 'x'.repeat(828)),
      setting('DataAccess.DbServer', 'D365DEVBOX-1'),
    ]), AOS);
    expect(await compareSysTestDataAccess(PKG)).toEqual([]);
  });

  it('ignores a key the AOS config does not carry', async () => {
    serve(RUNNER, doc([
      setting('DataAccess.Database', 'AxDbRain'),
      setting('DataAccess.SqlUser', 'AOSUser'),
      setting('DataAccess.SqlPwd', '$CREDENTIAL_PLACEHOLDER$'),
    ]));
    expect(await compareSysTestDataAccess(PKG)).toEqual([]);
  });
});
