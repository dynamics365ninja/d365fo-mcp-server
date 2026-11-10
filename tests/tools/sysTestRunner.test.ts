import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const {
  accessMock, readdirMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath,
  cfgGetDevEnvironmentType, cfgGetActiveXppConfig, cfgGetAutoDetectedModelName, findClassFileMock,
  dataverseSettingsMock, dataverseTokenMock, findRuntimeAssemblyMock, runInCloudMock, saveTrxMock,
} = vi.hoisted(() => {
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
  // Unset (undefined after vi.resetAllMocks) reads as a classic VM; the UDE block sets it.
  const cfgGetDevEnvironmentType = vi.fn();
  const cfgGetActiveXppConfig = vi.fn();
  const cfgGetAutoDetectedModelName = vi.fn();
  // The UDE path: where the class file is, the Dataverse sign-in and the cloud run.
  const findClassFileMock = vi.fn();
  const dataverseSettingsMock = vi.fn();
  const dataverseTokenMock = vi.fn();
  const findRuntimeAssemblyMock = vi.fn();
  const runInCloudMock = vi.fn();
  const saveTrxMock = vi.fn();
  return {
    accessMock, readdirMock, execFileMock, readFileMock, cfgEnsureLoaded, cfgGetModelName, cfgGetPackagePath,
    cfgGetDevEnvironmentType, cfgGetActiveXppConfig, cfgGetAutoDetectedModelName, findClassFileMock,
    dataverseSettingsMock, dataverseTokenMock, findRuntimeAssemblyMock, runInCloudMock, saveTrxMock,
  };
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
    getDevEnvironmentType: cfgGetDevEnvironmentType,
    getActiveXppConfig: cfgGetActiveXppConfig,
    getAutoDetectedModelName: cfgGetAutoDetectedModelName,
  }),
}));
vi.mock('../../src/utils/objectFileLookup.js', () => ({ findD365FileOnDisk: findClassFileMock }));
vi.mock('../../src/utils/dataverseAuth.js', () => ({
  DEFAULT_DATAVERSE_CLIENT_ID: 'default-client',
  readDataverseSettings: dataverseSettingsMock,
  getDataverseAccessToken: dataverseTokenMock,
}));
vi.mock('../../src/tools/sdlc/udeSysTest.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/tools/sdlc/udeSysTest.js')>()),
  findRuntimeAssembly: findRuntimeAssemblyMock,
  runTestRequestInCloud: runInCloudMock,
  saveTrx: saveTrxMock,
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import path from 'path';
import { sysTestRunnerTool, compareSysTestDataAccess, findSysTestConsole, findSysTestConsoles, _clearRedPhaseMemory } from '../../src/tools/sdlc/sysTestRunner';
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

/**
 * A UDE box has no local AOS, so SysTestConsole cannot run there from any Bin: it dies with
 * "Failed to obtain app setting from for: Common.HostingEnvironment". The tests go to the cloud
 * runtime instead, through the environment's Dataverse, as Visual Studio sends them.
 */
describe('run_systest_class — on a UDE environment', () => {
  const UDE_CUSTOM = 'C:\\Contoso\\Metadata';
  const RUNTIME = 'C:\\Users\\Contoso\\AppData\\Local\\Microsoft\\Dynamics365\\RuntimeSymLinks\\CONTOSODEV';
  const CLASS_FILE = path.join(UDE_CUSTOM, 'ContosoExtTests', 'ContosoExtTests', 'AxClass', 'ContosoInvoiceTest.xml');
  const ASSEMBLY = path.join(RUNTIME, 'ZZZZ__Metadata', 'ContosoExtTests', 'bin', 'Dynamics.AX.ContosoExtTests.dll');
  const DATAVERSE = { url: 'https://contoso-dev.crm.dynamics.com', clientId: 'client', tenant: 'organizations' };

  const method = (name: string, attrs = '') =>
    `\t\t\t<Method>\n\t\t\t\t<Name>${name}</Name>\n\t\t\t\t<Source><![CDATA[\n${attrs}    public void ${name}()\n    {\n    }\n]]></Source>\n\t\t\t</Method>`;
  const CLASS_XML = [
    '<AxClass>',
    '\t<SourceCode>',
    '\t\t<Declaration><![CDATA[\npublic class ContosoInvoiceTest extends SysTestCase\n{\n}\n]]></Declaration>',
    '\t\t<Methods>',
    method('testPosting'),
    method('testTotals'),
    method('testRetired', '    [SysTestMethod, SysTestInactiveTest]\n'),
    method('setUp'),
    '\t\t</Methods>',
    '\t</SourceCode>',
    '</AxClass>',
  ].join('\n');
  const trx = (results: { name: string; outcome: string; message?: string }[]) =>
    '<TestRun><Results>' + results.map(r =>
      `<UnitTestResult testName="${r.name}" outcome="${r.outcome}">` +
      (r.message ? `<Output><ErrorInfo><Message>${r.message}</Message></ErrorInfo></Output>` : '') +
      '</UnitTestResult>').join('') + '</Results></TestRun>';

  beforeEach(() => {
    vi.resetAllMocks();
    _clearRedPhaseMemory();
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('ContosoExtTests');
    cfgGetPackagePath.mockReturnValue(UDE_CUSTOM);
    cfgGetDevEnvironmentType.mockResolvedValue('ude');
    cfgGetActiveXppConfig.mockResolvedValue({ runtimePackagesDirectory: RUNTIME });
    // A SysTestConsole that WOULD be found: UDE must never start it.
    allowPaths([path.join(UDE_CUSTOM, 'Bin', 'SysTestConsole.17.0.exe')]);
    findClassFileMock.mockImplementation(async (_type: string, name: string) => name === 'ContosoInvoiceTest' ? CLASS_FILE : null);
    readFileMock.mockImplementation(async (file: string) => {
      if (file === CLASS_FILE) return CLASS_XML;
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    });
    findRuntimeAssemblyMock.mockResolvedValue(ASSEMBLY);
    dataverseSettingsMock.mockReturnValue(DATAVERSE);
    saveTrxMock.mockResolvedValue('C:\\Temp\\systest-ContosoInvoiceTest.trx');
    runInCloudMock.mockResolvedValue({
      suiteId: 's',
      trx: trx([
        { name: 'ContosoInvoiceTest.testPosting', outcome: 'Passed' },
        { name: 'ContosoInvoiceTest.testTotals', outcome: 'Failed', message: 'Assertion failed! (Expected: 10; Actual: 12)' },
      ]),
    });
  });

  /** The request document the tool sent. */
  const sentRequest = () => runInCloudMock.mock.calls[0][2] as string;

  it('runs the test methods in the cloud runtime and reports each of them', async () => {
    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});
    const text = result.content[0].text;

    expect(result.isError).toBeFalsy();
    expect(text.startsWith('❌ Tests FAILED')).toBe(true);
    expect(text).toContain('1/2 passed, 1 failed.');
    expect(text).toContain('❌ ContosoInvoiceTest.testTotals — Assertion failed! (Expected: 10; Actual: 12)');
    expect(text).toContain('✅ ContosoInvoiceTest.testPosting');
    expect(text).toContain('Ran in the cloud runtime of https://contoso-dev.crm.dynamics.com');
    expect(text).toContain('Result file: C:\\Temp\\systest-ContosoInvoiceTest.trx');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('sends the module assembly from the runtime folder and only the methods SysTest runs', async () => {
    await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});

    expect(findRuntimeAssemblyMock).toHaveBeenCalledWith(RUNTIME, 'ContosoExtTests');
    const request = sentRequest();
    expect(request).toContain(`<AssemblyPath>${ASSEMBLY}</AssemblyPath>`);
    expect(request).toContain('<TestCaseName>ContosoInvoiceTest.testPosting</TestCaseName>');
    expect(request).toContain('<TestCaseName>ContosoInvoiceTest.testTotals</TestCaseName>');
    expect(request).not.toContain('setUp');
    expect(request).not.toContain('testRetired');
  });

  it('says which inactive tests were skipped', async () => {
    const text = (await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {})).content[0].text;

    expect(text).toContain('Skipped, marked [SysTestInactiveTest]: testRetired.');
  });

  it('runs only testMethod when one is given', async () => {
    runInCloudMock.mockResolvedValue({ suiteId: 's', trx: trx([{ name: 'ContosoInvoiceTest.testPosting', outcome: 'Passed' }]) });

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest', testMethod: 'TESTPOSTING' }, {});
    const text = result.content[0].text;

    expect(text.startsWith('✅ Tests passed')).toBe(true);
    expect(text).toContain('Class: ContosoInvoiceTest::testPosting');
    expect(sentRequest()).not.toContain('testTotals');
    expect(text).not.toContain('no per-method filter');
  });

  it('lists the test methods when testMethod names none of them, without running anything', async () => {
    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest', testMethod: 'testPostng' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('has no test method named "testPostng"');
    expect(result.content[0].text).toContain('testPosting, testTotals, testRetired');
    expect(runInCloudMock).not.toHaveBeenCalled();
  });

  it('adds the test methods of a base class in the same model', async () => {
    const BASE_FILE = CLASS_FILE.replace('ContosoInvoiceTest', 'ContosoTestBase');
    findClassFileMock.mockImplementation(async (_t: string, name: string) =>
      name === 'ContosoInvoiceTest' ? CLASS_FILE : name === 'ContosoTestBase' ? BASE_FILE : null);
    readFileMock.mockImplementation(async (file: string) => {
      if (file === CLASS_FILE) return CLASS_XML.replace('extends SysTestCase', 'extends ContosoTestBase');
      if (file === BASE_FILE) {
        return CLASS_XML.replace('class ContosoInvoiceTest extends SysTestCase', 'abstract class ContosoTestBase extends SysTestCase')
          .replace(/testPosting|testTotals|testRetired/g, n => `${n}Base`).replace('testPostingBase', 'testPosting');
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});

    const request = sentRequest();
    expect(request).toContain('ContosoInvoiceTest.testTotalsBase');
    // Overridden in the class: listed once.
    expect(request.match(/<TestCaseName>ContosoInvoiceTest\.testPosting</g)).toHaveLength(1);
  });

  it('says when a base class outside the model was not searched', async () => {
    readFileMock.mockImplementation(async (file: string) => {
      if (file === CLASS_FILE) return CLASS_XML.replace('extends SysTestCase', 'extends ContosoSharedTestBase');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const text = (await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {})).content[0].text;

    expect(text).toContain('inherited from `ContosoSharedTestBase` were not looked for');
  });

  it('asks for the Dataverse URL when none is configured, before signing in', async () => {
    dataverseSettingsMock.mockReturnValue(undefined);

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain('`environment.dataverseUrl` (D365FO_DATAVERSE_URL)');
    expect(text).toContain('not the Finance and Operations URL');
    expect(text).toContain('Visual Studio Test Explorer');
    expect(runInCloudMock).not.toHaveBeenCalled();
    expect(dataverseTokenMock).not.toHaveBeenCalled();
  });

  it('asks for a build when the module assembly is not in the runtime folder', async () => {
    findRuntimeAssemblyMock.mockResolvedValue(null);

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Dynamics.AX.ContosoExtTests.dll was not found');
    expect(result.content[0].text).toContain('build_d365fo_project');
    expect(runInCloudMock).not.toHaveBeenCalled();
  });

  it('reports a class that is not in the model', async () => {
    const result = await sysTestRunnerTool({ className: 'ContosoMissingTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('`ContosoMissingTest` was not found in model `ContosoExtTests`');
  });

  it('reports a cloud run that failed as no result, not as failing tests', async () => {
    runInCloudMock.mockRejectedValue(new Error('The cloud runtime could not run the tests (Failed): statusCode = FailedDependency'));

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain('FailedDependency');
    expect(text).toContain('not deployed');
    expect(text).not.toContain('Tests FAILED');
    expect(parseSysTestResult(text).ran).toBe(false);
  });

  it('counts a requested method with no result as failed, so a run cut short is never green', async () => {
    runInCloudMock.mockResolvedValue({ suiteId: 's', trx: trx([{ name: 'ContosoInvoiceTest.testPosting', outcome: 'Passed' }]) });

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});
    const text = result.content[0].text;

    expect(text.startsWith('❌ Tests FAILED')).toBe(true);
    expect(text).toContain('1/2 passed, 1 failed.');
    expect(text).toContain('❌ ContosoInvoiceTest.testTotals — No result came back for this test.');
    expect(parseSysTestResult(text).passed).toBe(false);
  });

  it('reports results that name no test as no result at all', async () => {
    runInCloudMock.mockResolvedValue({ suiteId: 's', trx: '<TestRun><Results/></TestRun>' });

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No test result came back for 2 requested method(s).');
    expect(result.content[0].text).toContain('Result file: C:\\Temp\\systest-ContosoInvoiceTest.trx');
    expect(parseSysTestResult(result.content[0].text).ran).toBe(false);
  });

  it('accepts testMethod written as Class::method or Class.method', async () => {
    for (const testMethod of ['ContosoInvoiceTest::testPosting', 'ContosoInvoiceTest.testPosting']) {
      runInCloudMock.mockClear();
      const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest', testMethod }, {});

      expect(result.isError).toBeFalsy();
      expect(sentRequest()).toContain('<TestCaseName>ContosoInvoiceTest.testPosting</TestCaseName>');
      expect(sentRequest()).not.toContain('testTotals');
    }
  });

  it('refuses a class or method name that is not an X++ identifier, before touching any file', async () => {
    for (const params of [{ className: '..\\..\\ContosoInvoiceTest' }, { className: 'ContosoInvoiceTest', testMethod: 'test/../x' }]) {
      const result = await sysTestRunnerTool(params, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid parameter');
    }
    expect(findClassFileMock).not.toHaveBeenCalled();
  });

  it('tells a classic VM detected as UDE how to say so, where the reply asks for UDE settings', async () => {
    dataverseSettingsMock.mockReturnValue(undefined);

    const text = (await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {})).content[0].text;

    expect(text).toContain('`environment.type` (D365FO_DEV_ENVIRONMENT_TYPE)');
    expect(text).toContain('"traditional"');
  });

  it('signs in before taking the run lock, and reports a failed sign-in as no test run', async () => {
    dataverseTokenMock.mockRejectedValue(new Error('AADSTS65001: consent required'));

    const result = await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {});
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain('Signing in to https://contoso-dev.crm.dynamics.com failed: AADSTS65001');
    expect(text).toMatch(/No test ran/);
    expect(runInCloudMock).not.toHaveBeenCalled();
  });

  it('says another run held the lock rather than blaming the deployment', async () => {
    runInCloudMock.mockRejectedValue(new Error('Timeout waiting for filesystem lock: systest:ContosoExtTests:ContosoInvoiceTest'));

    const text = (await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {})).content[0].text;

    expect(text).toContain('Another run of `ContosoInvoiceTest` was still in progress');
    expect(text).not.toContain('not deployed');
  });

  it('is scored by the eval oracle as a run whose tests failed', async () => {
    const parsed = parseSysTestResult((await sysTestRunnerTool({ className: 'ContosoInvoiceTest' }, {})).content[0].text);

    expect(parsed.ran).toBe(true);
    expect(parsed.passed).toBe(false);
  });

  it('still runs SysTestConsole when the environment is traditional', async () => {
    cfgGetDevEnvironmentType.mockResolvedValue('traditional');
    cfgGetPackagePath.mockReturnValue(PKG);
    allowPaths([SYSTEST_CONSOLE]);
    readdirMock.mockResolvedValue([]);
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅ Tests passed', stderr: '' });
    });

    const result = await sysTestRunnerTool({ className: 'ContosoMyTest' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock.mock.calls[0][0]).toBe(SYSTEST_CONSOLE);
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
  const CLASS = 'ContosoInvoiceSenderTests';
  const names = Array.from({ length: 43 }, (_, i) => `test_case${String(i + 1).padStart(2, '0')}`);
  const FAILING: Record<string, string> = {
    test_case07: 'Assert.areEqual failed: expected Sent, actual Pending',
    test_case39: 'Assert.isTrue failed: invoice status was not updated',
  };
  const XML = '<?xml version="1.0"?><test-results><results>' +
    names.map(n => FAILING[n]
      ? `<test-case name="${CLASS}.${n}" success="false"><failure><message>${FAILING[n]}</message></failure></test-case>`
      : `<test-case name="${CLASS}.${n}" success="true" />`).join('') +
    '</results></test-results>';
  // ~39 KB of console log, its stack traces long enough to bury everything after them.
  const STACK = Array.from({ length: 150 }, (_, i) =>
    `   at Dynamics.AX.Application.ContosoInvoiceSender.frame${i}() in xppSource://Source/ContosoExt\\AxClass_ContosoInvoiceSender.xpp:line ${i}`).join('\n');
  const LOG = `Executing test(s) ....\n${names.map(n => FAILING[n] ? `${n} failed: ${FAILING[n]}\n${STACK}` : `${n} passed`).join('\n')}\n` +
    'Rainier Test Suite : 43 Run, 2 Failed';

  const capped = (result: any) => capToolResponse('run_systest_class', result).content[0].text as string;

  beforeEach(() => {
    vi.resetAllMocks();
    readdirMock.mockResolvedValue(['SysTestConsole.17.0.exe']);
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('ContosoExtTests');
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
