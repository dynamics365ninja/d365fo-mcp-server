import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const {
  accessMock, execFileMock,
  cfgEnsureLoaded, cfgGetModelName, cfgGetProjectPath, cfgGetPackagePath,
  cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath, cfgGetActiveXppConfig,
} = vi.hoisted(() => {
  const accessMock = vi.fn();
  // execFile needs a callback-style API for util.promisify
  const execFileMock: any = vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: '✅ no violations', stderr: '' });
  });
  const cfgEnsureLoaded             = vi.fn();
  const cfgGetModelName             = vi.fn().mockReturnValue('MyModel');
  const cfgGetProjectPath           = vi.fn().mockResolvedValue(null);
  const cfgGetPackagePath           = vi.fn().mockReturnValue(null);
  const cfgGetCustomPackagesPath    = vi.fn().mockResolvedValue(null);
  const cfgGetMicrosoftPackagesPath = vi.fn().mockResolvedValue(null);
  const cfgGetActiveXppConfig       = vi.fn().mockResolvedValue(null);
  return {
    accessMock, execFileMock,
    cfgEnsureLoaded, cfgGetModelName, cfgGetProjectPath, cfgGetPackagePath,
    cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath, cfgGetActiveXppConfig,
  };
});

vi.mock('child_process', () => ({ execFile: execFileMock }));
// runBpCheck.ts uses `import fs from 'fs/promises'` (default namespace import).
// Vitest resolves the default import to the `default` property of the mock object.
// Without it `fs` is undefined, all fs.access() calls throw TypeError, which is
// silently swallowed by the CHE probe try/catch, and the path resolution silently
// falls through to the hardcoded K:\AosService default.
vi.mock('fs/promises', () => { const m = { access: accessMock }; return { ...m, default: m }; });
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded:             cfgEnsureLoaded,
    getModelName:             cfgGetModelName,
    getProjectPath:           cfgGetProjectPath,
    getPackagePath:           cfgGetPackagePath,
    getCustomPackagesPath:    cfgGetCustomPackagesPath,
    getMicrosoftPackagesPath: cfgGetMicrosoftPackagesPath,
    getActiveXppConfig:       cfgGetActiveXppConfig,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import path from 'path';
import { runBpCheckTool } from '../../src/tools/runBpCheck';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHE_PKG  = 'C:\\AOSService\\PackagesLocalDirectory';
const UDE_CUSTOM = 'D:\\Metadata\\CustomPackages';
const UDE_MS     = 'D:\\Metadata\\MicrosoftPackages';

const CHE_XPPBP = path.join(CHE_PKG,  'Bin', 'xppbp.exe');
const UDE_XPPBP = path.join(UDE_MS,   'Bin', 'xppbp.exe');

/** Allow fs.access only for the listed paths; all others reject with ENOENT. */
function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    if (paths.some(a => norm(a) === norm(p))) return;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
}

/** Returns captured args from execFileMock call N (0-based). */
function capturedArgs(callIndex = 0): string[] {
  return execFileMock.mock.calls[callIndex]?.[1] ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run_bp_check — path resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('MyModel');
    cfgGetProjectPath.mockResolvedValue(null);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    cfgGetActiveXppConfig.mockResolvedValue(null);
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, { stdout: '✅ no violations', stderr: '' });
    });
  });

  // -------------------------------------------------------------------------
  // Environment A — CHE: single PackagesLocalDirectory (Priority 3 probe)
  // -------------------------------------------------------------------------
  describe('Environment A — CHE (single PackagesLocalDirectory)', () => {
    it('resolves xppbp.exe from probed CHE path when no config is present', async () => {
      allowPaths([CHE_PKG, CHE_XPPBP]);

      const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

      expect(result.isError).toBeFalsy();
      expect(execFileMock).toHaveBeenCalled();
      const [exe] = execFileMock.mock.calls[0];
      expect(exe).toBe(CHE_XPPBP);
    });

    it('passes -metadata= and -packagesRoot= pointing to the same CHE root', async () => {
      allowPaths([CHE_PKG, CHE_XPPBP]);

      await runBpCheckTool({ modelName: 'MyModel' }, {});

      // The first successful attempt may be colon or equals style; in either
      // case both metadata and compiler-metadata paths must resolve to CHE_PKG.
      const args = capturedArgs(0);
      const metaArg  = args.find(a => a.includes('metadata'));
      const compArg  = args.find(a => a.includes('packagesRoot') || a.includes('compilerMetadata'));
      expect(metaArg).toContain(CHE_PKG);
      expect(compArg).toContain(CHE_PKG);
    });

    it('probes K:\\AOSService\\PackagesLocalDirectory when C:\\ variant absent', async () => {
      const K_PKG   = 'K:\\AOSService\\PackagesLocalDirectory';
      const K_XPPBP = path.join(K_PKG, 'Bin', 'xppbp.exe');
      allowPaths([K_PKG, K_XPPBP]);

      const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

      expect(result.isError).toBeFalsy();
      const [exe] = execFileMock.mock.calls[0];
      expect(exe).toBe(K_XPPBP);
    });
  });

  // -------------------------------------------------------------------------
  // Environment B — UDE: separate custom and Microsoft/framework paths
  // -------------------------------------------------------------------------
  describe('Environment B — UDE (XPP config with separate paths)', () => {
    beforeEach(() => {
      cfgGetActiveXppConfig.mockResolvedValue({
        configName:           'uat',
        version:              '10.0.39',
        customPackagesPath:   UDE_CUSTOM,
        microsoftPackagesPath: UDE_MS,
        referencePackagesPaths: [],
      });
    });

    it('resolves xppbp.exe from microsoftPackagesPath (framework root)', async () => {
      allowPaths([UDE_CUSTOM, UDE_MS, UDE_XPPBP]);

      const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

      expect(result.isError).toBeFalsy();
      const [exe] = execFileMock.mock.calls[0];
      expect(exe).toBe(UDE_XPPBP);
    });

    it('passes -metadata= pointing to customPackagesPath', async () => {
      allowPaths([UDE_CUSTOM, UDE_MS, UDE_XPPBP]);

      await runBpCheckTool({ modelName: 'MyModel' }, {});

      const args      = capturedArgs(0);
      const metaArg   = args.find(a => /^-metadata[:=]/.test(a));
      expect(metaArg).toContain(UDE_CUSTOM);
    });

    it('passes -compilerMetadata= / -packagesRoot= pointing to microsoftPackagesPath', async () => {
      allowPaths([UDE_CUSTOM, UDE_MS, UDE_XPPBP]);

      await runBpCheckTool({ modelName: 'MyModel' }, {});

      const args    = capturedArgs(0);
      const compArg = args.find(a => a.includes('compilerMetadata') || a.includes('packagesRoot'));
      expect(compArg).toContain(UDE_MS);
      // Must NOT point to the custom metadata dir
      expect(compArg).not.toContain(UDE_CUSTOM);
    });

    it('does NOT consult configManager.getCustomPackagesPath when xppConfig is present', async () => {
      allowPaths([UDE_CUSTOM, UDE_MS, UDE_XPPBP]);

      await runBpCheckTool({ modelName: 'MyModel' }, {});

      // Priority 1 (XPP config) took effect — Priority 2 path must not have been called
      expect(cfgGetCustomPackagesPath).not.toHaveBeenCalled();
      expect(cfgGetMicrosoftPackagesPath).not.toHaveBeenCalled();
    });

    it('falls back to configManager paths when xppConfig returns null', async () => {
      cfgGetActiveXppConfig.mockResolvedValue(null);
      cfgGetCustomPackagesPath.mockResolvedValue(UDE_CUSTOM);
      cfgGetMicrosoftPackagesPath.mockResolvedValue(UDE_MS);
      allowPaths([UDE_CUSTOM, UDE_MS, UDE_XPPBP]);

      const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

      expect(result.isError).toBeFalsy();
      expect(cfgGetCustomPackagesPath).toHaveBeenCalled();
      expect(cfgGetMicrosoftPackagesPath).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // params.packagePath override
  // -------------------------------------------------------------------------
  describe('params.packagePath explicit override', () => {
    it('uses params.packagePath for xppbp.exe resolution regardless of config', async () => {
      const OVERRIDE = 'E:\\CustomBinaries\\PackagesLocalDirectory';
      const OVERRIDE_XPPBP = path.join(OVERRIDE, 'Bin', 'xppbp.exe');
      allowPaths([OVERRIDE, OVERRIDE_XPPBP]);

      const result = await runBpCheckTool({ modelName: 'MyModel', packagePath: OVERRIDE }, {});

      expect(result.isError).toBeFalsy();
      const [exe] = execFileMock.mock.calls[0];
      expect(exe).toBe(OVERRIDE_XPPBP);
    });
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------
  describe('Error paths', () => {
    it('returns error when model name cannot be determined', async () => {
      cfgGetModelName.mockReturnValue(null);

      const result = await runBpCheckTool({}, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot determine model name');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns error when xppbp.exe is not found at resolved path', async () => {
      allowPaths([CHE_PKG]); // directory exists but xppbp.exe does not

      const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('xppbp.exe not found');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns error when no package path can be resolved at all', async () => {
      // fs.access always rejects → no CHE probe candidate found, no xppbp.exe
      accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// CLI flag styles
// ---------------------------------------------------------------------------
describe('run_bp_check — CLI flag style fallback chain', () => {
  const HELP_OUTPUT = 'X++ Best Practice Options:\n  -metadata:<path>\n';

  beforeEach(() => {
    vi.resetAllMocks();
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('MyModel');
    cfgGetProjectPath.mockResolvedValue(null);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    cfgGetActiveXppConfig.mockResolvedValue(null);
    allowPaths([CHE_PKG, CHE_XPPBP]);
  });

  it('succeeds on Attempt 1 and does not try further attempts', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅ no violations', stderr: '' });
    });

    await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to Attempt 2 when Attempt 1 returns help text', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      callCount++;
      if (callCount === 1) cb(null, { stdout: HELP_OUTPUT, stderr: '' });
      else                 cb(null, { stdout: '✅ passed', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('falls through to Attempt 3 when Attempts 1+2 return help text', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      callCount++;
      if (callCount <= 2) cb(null, { stdout: HELP_OUTPUT, stderr: '' });
      else                cb(null, { stdout: '✅ passed', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it('falls through to Attempt 4 when Attempts 1–3 return help text', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      callCount++;
      if (callCount <= 3) cb(null, { stdout: HELP_OUTPUT, stderr: '' });
      else                cb(null, { stdout: '✅ passed', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.isError).toBeFalsy();
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it('returns error message listing all four attempts when all return help text', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: HELP_OUTPUT, stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('four flag-style attempts');
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it('Attempt 1 uses -compilerMetadata: (colon) style', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅', stderr: '' });
    });

    await runBpCheckTool({ modelName: 'MyModel' }, {});

    const args = capturedArgs(0);
    expect(args.some(a => /^-compilerMetadata:/.test(a))).toBe(true);
    expect(args.some(a => /^-metadata:/.test(a))).toBe(true);
  });

  it('Attempt 2 uses -compilerMetadata= (equals) style', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      callCount++;
      if (callCount === 1) cb(null, { stdout: HELP_OUTPUT, stderr: '' });
      else                 cb(null, { stdout: '✅', stderr: '' });
    });

    await runBpCheckTool({ modelName: 'MyModel' }, {});

    const args = capturedArgs(1);
    expect(args.some(a => /^-compilerMetadata=/.test(a))).toBe(true);
    expect(args.some(a => /^-metadata=/.test(a))).toBe(true);
  });

  it('Attempt 3 uses -packagesRoot= (equals) style', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      callCount++;
      if (callCount <= 2) cb(null, { stdout: HELP_OUTPUT, stderr: '' });
      else                cb(null, { stdout: '✅', stderr: '' });
    });

    await runBpCheckTool({ modelName: 'MyModel' }, {});

    const args = capturedArgs(2);
    expect(args.some(a => /^-packagesRoot=/.test(a))).toBe(true);
    expect(args.some(a => /^-metadata=/.test(a))).toBe(true);
  });

  it('Attempt 4 uses -packagesRoot: (colon) style', async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      callCount++;
      if (callCount <= 3) cb(null, { stdout: HELP_OUTPUT, stderr: '' });
      else                cb(null, { stdout: '✅', stderr: '' });
    });

    await runBpCheckTool({ modelName: 'MyModel' }, {});

    const args = capturedArgs(3);
    expect(args.some(a => /^-packagesRoot:/.test(a))).toBe(true);
    expect(args.some(a => /^-metadata:/.test(a))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BP violation detection
// ---------------------------------------------------------------------------
describe('run_bp_check — violation detection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('MyModel');
    cfgGetProjectPath.mockResolvedValue(null);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    cfgGetActiveXppConfig.mockResolvedValue(null);
    allowPaths([CHE_PKG, CHE_XPPBP]);
  });

  it('reports ✅ when output contains no violations', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: 'Errors: 0\nWarnings: 0', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅ BP Check passed');
  });

  it('reports ⚠️ when output contains BPError', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: 'BPError: LocalVariableNotUsed\nErrors: 1', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('⚠️ BP Check completed with issues');
  });

  it('reports ⚠️ when Warnings counter is non-zero', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: 'Warnings: 3', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel' }, {});

    expect(result.content[0].text).toContain('⚠️');
  });

  it('includes filter name in output when targetFilter is supplied', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅', stderr: '' });
    });

    const result = await runBpCheckTool({ modelName: 'MyModel', targetFilter: 'MyClass' }, {});

    expect(result.content[0].text).toContain('Filter: class:MyClass');
    const args = capturedArgs(0);
    expect(args.some(a => a.includes('MyClass'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding #25 (2026-07-21 sweep): run_bp_check(targetFilter=…) does not scope
//
// `targetFilter=ConDemoCompanyReader, targetElementType=class` still processed
// 2 elements and returned only TABLE warnings — attribution had to be done by
// reading rule names. Two causes in the very first attempt, which is the one
// that succeeds on this VM:
//   • it passed `-all` (check the whole model) alongside the filter, and
//   • it expressed the filter as `-filter:<name>`, which this xppbp does not
//     recognise, so the scope was silently dropped — and targetElementType was
//     not carried at all outside the equals style.
// ---------------------------------------------------------------------------
describe('run_bp_check — targetFilter actually scopes (#25)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cfgEnsureLoaded.mockResolvedValue(undefined);
    cfgGetModelName.mockReturnValue('MyModel');
    cfgGetProjectPath.mockResolvedValue(null);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    cfgGetActiveXppConfig.mockResolvedValue(null);
    allowPaths([CHE_PKG, CHE_XPPBP]);
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, { stdout: '✅', stderr: '' });
    });
  });

  it('does NOT pass -all together with a filter (that is what checked the whole model)', async () => {
    await runBpCheckTool(
      { modelName: 'MyModel', targetFilter: 'ConDemoCompanyReader', targetElementType: 'class' },
      {},
    );

    const args = capturedArgs(0);
    expect(args).not.toContain('-all');
    expect(args).toContain('class:ConDemoCompanyReader');
  });

  it('carries targetElementType in the very first attempt, not only in the equals style', async () => {
    await runBpCheckTool(
      { modelName: 'MyModel', targetFilter: 'ConDemoTicket', targetElementType: 'table' },
      {},
    );

    expect(capturedArgs(0)).toContain('table:ConDemoTicket');
    // The unrecognised flag form is gone.
    expect(capturedArgs(0).some(a => a.startsWith('-filter'))).toBe(false);
  });

  it('still passes -all when no filter is requested', async () => {
    await runBpCheckTool({ modelName: 'MyModel' }, {});
    expect(capturedArgs(0)).toContain('-all');
  });

  it('reports honestly when xppbp returned findings for other elements', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, {
        stdout:
          'BPErrorTableMissingFormRef: K:\\Pkg\\Contoso\\Contoso\\AxTable\\ConDemoTicket.xml\n' +
          'BPErrorTableFieldGroupEmpty: K:\\Pkg\\Contoso\\Contoso\\AxTable\\ConDemoLine.xml\n',
        stderr: '',
      });
    });

    const result = await runBpCheckTool(
      { modelName: 'MyModel', targetFilter: 'ConDemoCompanyReader', targetElementType: 'class' },
      {},
    );
    const text = result.content[0].text as string;

    expect(text).toContain('Scope NOT honoured');
    expect(text).toContain('ConDemoTicket');
    expect(text).toContain('ConDemoLine');
  });

  it('confirms the scope when every finding belongs to the filtered element', async () => {
    execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => {
      cb(null, {
        stdout: 'BPErrorXmlDocMissing: K:\\Pkg\\Contoso\\Contoso\\AxClass\\ConDemoCompanyReader.xml\n',
        stderr: '',
      });
    });

    const result = await runBpCheckTool(
      { modelName: 'MyModel', targetFilter: 'ConDemoCompanyReader', targetElementType: 'class' },
      {},
    );

    expect(result.content[0].text as string).toContain('Scope: honoured');
  });
});

describe('extractReportedElements (#25 helper)', () => {
  it('reads element names out of AOT paths and quoted references', async () => {
    const { extractReportedElements } = await import('../../src/tools/runBpCheck');
    expect(extractReportedElements('warn K:\\Pkg\\M\\M\\AxTable\\ConDemoTicket.xml')).toContain('ConDemoTicket');
    expect(extractReportedElements("BPError: table 'ConDemoLine' is bad")).toContain('ConDemoLine');
    expect(extractReportedElements('no elements here')).toEqual([]);
  });
});
