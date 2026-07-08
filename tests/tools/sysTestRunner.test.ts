import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const { accessMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath } = vi.hoisted(() => {
  const accessMock = vi.fn();
  const readFileMock = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  // execFile needs a callback-style API for util.promisify
  const execFileMock: any = vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: '✅ Tests passed', stderr: '' });
  });
  const cfgEnsureLoaded = vi.fn();
  const cfgGetModelName = vi.fn().mockReturnValue('Contoso');
  const cfgGetPackagePath = vi.fn().mockReturnValue('K:\\AOSService\\PackagesLocalDirectory');
  return { accessMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath };
});

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('fs/promises', () => {
  const m = { access: accessMock, readFile: readFileMock };
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
import { sysTestRunnerTool } from '../../src/tools/sysTestRunner';

const PKG = 'K:\\AOSService\\PackagesLocalDirectory';
const SYSTEST_CONSOLE = path.join(PKG, 'Bin', 'SysTestConsole.exe');
const SYSTEST_RUNNER = path.join(PKG, 'Bin', 'SysTestRunner.exe');

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
});

describe('run_systest_class — interactive console blocker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(result.content[0].text).toContain('requires an interactive console session');
    expect(result.content[0].text).toContain('not a bug in this tool');
  });

  it('a plain test failure is NOT misclassified as the interactive-console blocker', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '❌ Tests FAILED\n\nContosoMyTest::testFoo failed: assertion error', stderr: '' });
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Tests FAILED');
    expect(result.content[0].text).not.toContain('interactive console session');
  });
});
