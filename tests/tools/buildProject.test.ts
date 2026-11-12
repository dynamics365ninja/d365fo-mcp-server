import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const {
  accessMock, writeFileMock, appendFileMock, unlinkMock, readFileMock, readdirMock, rmMock, statMock, spawnMock, execFileMock,
  cfgEnsureLoaded, cfgGetProjectPath, cfgGetPackagePath, cfgGetContext,
  cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath,
  cfgGetActiveXppConfig, cfgGetModelName, detectedRoots,
} = vi.hoisted(() => {
  // Mutable stand-in for the AosService drive scan (src/utils/packagesRoot).
  const detectedRoots: string[] = [];
  const accessMock = vi.fn();
  const writeFileMock = vi.fn().mockResolvedValue(undefined);
  const appendFileMock = vi.fn().mockResolvedValue(undefined);
  const unlinkMock = vi.fn().mockResolvedValue(undefined);
  const readFileMock = vi.fn();
  const readdirMock = vi.fn().mockRejectedValue(new Error('not found'));
  const rmMock = vi.fn().mockResolvedValue(undefined);
  // Source-staleness scan (hasSourceChangesSince). mtimeMs 0 = "older than any
  // build", so a mocked tree never looks modified unless a test says so.
  const statMock = vi.fn().mockResolvedValue({ mtimeMs: 0 });
  const spawnMock = vi.fn();
  // execFile needs to call its callback for util.promisify to work
  const execFileMock: any = vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  });
  const cfgEnsureLoaded = vi.fn();
  const cfgGetProjectPath = vi.fn().mockResolvedValue('C:\\MyProject\\MyProject.rnrproj');
  const cfgGetPackagePath = vi.fn().mockReturnValue(null);
  const cfgGetContext = vi.fn().mockReturnValue({});
  const cfgGetCustomPackagesPath = vi.fn().mockResolvedValue(null);
  const cfgGetMicrosoftPackagesPath = vi.fn().mockResolvedValue(null);
  const cfgGetActiveXppConfig = vi.fn().mockResolvedValue(null);
  const cfgGetModelName = vi.fn().mockReturnValue(null);
  return {
    accessMock, writeFileMock, appendFileMock, unlinkMock, readFileMock, readdirMock, rmMock, statMock, spawnMock, execFileMock,
    cfgEnsureLoaded, cfgGetProjectPath, cfgGetPackagePath, cfgGetContext,
    cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath,
    cfgGetActiveXppConfig, cfgGetModelName, detectedRoots,
  };
});

vi.mock('child_process', () => ({ spawn: spawnMock, execFile: execFileMock }));
vi.mock('fs', () => ({
  openSync: vi.fn().mockReturnValue(3),
  closeSync: vi.fn(),
}));
vi.mock('fs/promises', () => ({
  access: accessMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
  readFile: readFileMock,
  appendFile: appendFileMock,
  readdir: readdirMock,
  rm: rmMock,
  stat: statMock,
}));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: cfgEnsureLoaded,
    getProjectPath: cfgGetProjectPath,
    getPackagePath: cfgGetPackagePath,
    getContext: cfgGetContext,
    getCustomPackagesPath: cfgGetCustomPackagesPath,
    getMicrosoftPackagesPath: cfgGetMicrosoftPackagesPath,
    getActiveXppConfig: cfgGetActiveXppConfig,
    getModelName: cfgGetModelName,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
  isOperationLockHeld: vi.fn().mockResolvedValue(false),
  forceReleaseLock: vi.fn().mockResolvedValue(undefined),
}));
// The drive scan reads the real filesystem, which the fs mocks above do not
// serve — feed it the roots each test wants found instead.
vi.mock('../../src/utils/packagesRoot.js', async () => {
  const nodePath = await import('path');
  return {
    packagesRoots: () => [...detectedRoots],
    findPackagesRoot: () => detectedRoots[0] ?? null,
    packagesRootCandidates: (...rel: string[]) => detectedRoots.map(r => nodePath.join(r, ...rel)),
    defaultPackagesRoot: () => detectedRoots[0] ?? 'C:\\AosService\\PackagesLocalDirectory',
    describePackagesRootScan: () => `Detected packages roots: ${detectedRoots.join(', ')}`,
  };
});

const { pruneMock } = vi.hoisted(() => ({ pruneMock: vi.fn() }));
vi.mock('../../src/tools/sdlc/compilerMetadataPrune.js', () => ({ pruneStaleCompilerMetadata: pruneMock }));
const { scanMock } = vi.hoisted(() => ({ scanMock: vi.fn() }));
vi.mock('../../src/tools/sdlc/odataActionGuard.js', async () => ({
  ...(await vi.importActual<any>('../../src/tools/sdlc/odataActionGuard.js')),
  scanODataActions: scanMock,
}));
const { schemaScanMock } = vi.hoisted(() => ({ schemaScanMock: vi.fn() }));
vi.mock('../../src/tools/sdlc/schemaChangeGuard.js', async () => ({
  ...(await vi.importActual<any>('../../src/tools/sdlc/schemaChangeGuard.js')),
  scanSchemaChanges: schemaScanMock,
}));
const { patternScanMock } = vi.hoisted(() => ({ patternScanMock: vi.fn() }));
vi.mock('../../src/tools/sdlc/formPatternGuard.js', async () => ({
  ...(await vi.importActual<any>('../../src/tools/sdlc/formPatternGuard.js')),
  scanFormPatternErrors: patternScanMock,
}));

import path from 'path';
import { buildProjectTool, readFullLog, renderFailureLog, trimSucceededLog } from '../../src/tools/sdlc/buildProject';

describe('trimSucceededLog', () => {
  const SUMMARY = ['Compilation completed', 'Errors: 0', 'Warnings: 2'];
  const timing = (n: number) =>
    Array.from({ length: n }, (_, i) => 'Phase timing row ' + i);

  it('drops the phase-timing table a green build has no use for', () => {
    const out = trimSucceededLog([...timing(45), ...SUMMARY].join('\n'));

    expect(out).toContain('phase-timing line(s) omitted');
    expect(out).not.toContain('Phase timing row 0');
    // The trailing summary is the part a green build is actually read for.
    expect(out).toContain('Errors: 0');
    expect(out).toContain('Warnings: 2');
  });

  it('keeps every warning, wherever it sits in the tail', () => {
    const warning = 'Metadata Warning: dynamics://MyModel/MyTable: [(1,1)]: label is missing.';
    const out = trimSucceededLog([...timing(20), warning, ...timing(20), ...SUMMARY].join('\n'));

    expect(out).toContain(warning);
    expect(out).not.toContain('Phase timing row 3');
  });

  it('is a no-op on a log with nothing to strip', () => {
    const short = ['Compilation completed', 'Errors: 0'].join('\n');
    expect(trimSucceededLog(short)).toBe(short);

    // Long, but every line is a diagnostic — none of it is timing noise.
    const allDiags = Array.from({ length: 40 },
      (_, i) => 'Metadata Warning: dynamics://M/T' + i + ': [(1,1)]: x.').join('\n');
    expect(trimSucceededLog(allDiags)).toBe(allDiags);
  });

  it('shrinks a real-shaped tail by roughly the phase table', () => {
    const raw = [...timing(57), ...SUMMARY].join('\n');
    expect(trimSucceededLog(raw).length).toBeLessThan(raw.length / 2);
  });

  it('keeps a warning whatever shape it arrives in', () => {
    // DIAG_LINE_TEST is anchored and case-sensitive — it wants xppc's exact shape
    // and nothing else. On the FAILURE path a non-matching line still arrives via
    // the head/tail fallback; here it would be dropped outright, and hasWarnings
    // uses the same test, so such a warning would not even set the ⚠️ icon.
    // Verified dropped before this widening: the lowercase and MSBuild shapes.
    const shapes = [
      'Metadata Warning: dynamics://M/T: [(1,1)]: label missing.',
      'warning: lowercase generic',
      'MyTable.xpp(12,3): warning CS1234: unused variable',
    ];
    const out = trimSucceededLog([...timing(20), ...shapes, ...timing(20), ...SUMMARY].join('\n'));

    for (const line of shapes) expect(out, line).toContain(line);
    // Still a trim, not a passthrough.
    expect(out).toContain('phase-timing line(s) omitted');
    expect(out).not.toContain('Phase timing row 3');
  });
});

const PROJECT_PATH = 'C:\\MyProject\\MyProject.rnrproj';
const MODEL_NAME = 'MyModel';
const RNRPROJ_XML = `<Project><Model>${MODEL_NAME}</Model></Project>`;
const PKG = 'C:\\AOSService\\PackagesLocalDirectory';
const XPPC = path.join(PKG, 'bin', 'xppc.exe');

const NO_ODATA_FINDINGS = { recompiled: [], missing: [], runtimeFile: null, errors: [] };

function makeFakeChild(pid = 12345) {
  const child: any = {
    pid,
    unref: vi.fn(),
    on: vi.fn(),
  };
  return child;
}

/** accessMock passes only listed paths */
function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    if (paths.some(allowed => p === allowed || p.replace(/\\/g, '/') === allowed.replace(/\\/g, '/'))) return;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
}

describe('build_d365fo_project', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    detectedRoots.splice(0, detectedRoots.length, PKG);
    writeFileMock.mockResolvedValue(undefined);
    appendFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(new Error('not found'));
    rmMock.mockResolvedValue(undefined);
    // resetAllMocks() above wipes the hoisted implementation, and an unarmed
    // stat resolves undefined — which the staleness scan reads as "unreadable,
    // assume changed", so every finished result would be refused and rebuilt.
    statMock.mockResolvedValue({ mtimeMs: 0 });
    pruneMock.mockResolvedValue({ stale: [], phantoms: [], skippedModels: [], errors: [], scanned: 0 });
    scanMock.mockResolvedValue(NO_ODATA_FINDINGS);
    schemaScanMock.mockResolvedValue({ changed: [], errors: [] });
    patternScanMock.mockResolvedValue({ errors: [], formsChecked: 0, unreadable: [] });
    cfgGetProjectPath.mockResolvedValue(PROJECT_PATH);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetContext.mockReturnValue({});
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    cfgGetActiveXppConfig.mockResolvedValue(null);
    cfgGetModelName.mockReturnValue(null);
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, { stdout: '', stderr: '' });
    });
    // By default no state file exists
    readFileMock.mockImplementation(async (p: string) => {
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('starts a background xppc.exe build and returns started message', async () => {
    const child = makeFakeChild(42);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [exe, args] = spawnMock.mock.calls[0];
    expect(exe).toBe(XPPC);
    expect(args).toContain(`-metadata=${PKG}`);
    expect(args).toContain(`-modelmodule=${MODEL_NAME}`);
    expect(result.content[0].text).toContain('build started');
    expect(result.isError).toBeFalsy();
  });

  it('writes a build state file when launching xppc.exe', async () => {
    const child = makeFakeChild(99);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    // writeFile is called to persist build state JSON (last write has the real PID)
    const stateCall = writeFileMock.mock.calls.filter((c: any[]) => c[0].includes('d365build_state')).at(-1);
    expect(stateCall).toBeDefined();
    const state = JSON.parse(stateCall![1]);
    expect(state.pid).toBe(99);
    expect(state.status).toBe('running');
    expect(state.tool).toBe('xppc.exe');
  });

  it('calls child.unref() to prevent blocking server shutdown', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('returns error when packages path cannot be resolved', async () => {
    // No AosService on any drive, no configManager paths
    detectedRoots.length = 0;
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot resolve D365FO package paths');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // #769: the CHE fallback used to be a hardcoded C:/K:/J:/I: list, so a VM
  // image that put AosService on another volume found neither the packages
  // root nor xppc.exe.
  it('builds from whatever drive the scan found AosService on', async () => {
    const J_PKG  = 'J:\\AosService\\PackagesLocalDirectory';
    const J_XPPC = path.join(J_PKG, 'bin', 'xppc.exe');
    detectedRoots.splice(0, detectedRoots.length, J_PKG);
    const child = makeFakeChild(43);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, J_XPPC, J_PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    expect(result.isError).toBeFalsy();
    const [exe, args] = spawnMock.mock.calls[0];
    expect(exe).toBe(J_XPPC);
    expect(args).toContain(`-metadata=${J_PKG}`);
  });

  it('returns error when xppc.exe is not found', async () => {
    // PKG dir exists but xppc.exe does not
    allowPaths([PROJECT_PATH, PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('xppc.exe');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns error when model name cannot be determined', async () => {
    allowPaths([PKG, XPPC]);

    const result = await buildProjectTool({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot determine model name');
  });

  it('returns in-progress status when build is already running', async () => {
    const stateJson = JSON.stringify({
      pid: 777,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_abc.log',
      status: 'running',
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'Compiling...';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Simulate PID 777 being alive via process.kill mock
    const origKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: any, sig: any) => {
      if (pid === 777 && sig === 0) return true as any;
      return origKill(pid, sig);
    });

    const result = await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    expect(result.content[0].text).toContain('Call again to refresh');
    expect(spawnMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('returns succeeded result when previous build finished successfully', async () => {
    const stateJson = JSON.stringify({
      pid: 888,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 30_000).toISOString(),
      endTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_xyz.log',
      status: 'succeeded',
      exitCode: 0,
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'Build complete.';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Model tree readable and unchanged since the build — otherwise the result
    // is (correctly) refused as stale and a fresh build starts.
    readdirMock.mockResolvedValue([]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.content[0].text).toContain('succeeded');
    // #829 explicitly praises this wording — a collected result must keep
    // saying, in plain words, that this call compiled nothing.
    expect(result.content[0].text).toContain('Collected the result of the build that ended');
    expect(result.content[0].text).toContain('nothing was recompiled by this call');
    expect(result.isError).toBeFalsy();
    expect(spawnMock).not.toHaveBeenCalled();
    // State file should be cleared
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('returns error result when previous build failed', async () => {
    const stateJson = JSON.stringify({
      pid: 999,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 60_000).toISOString(),
      endTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_fail.log',
      status: 'failed',
      exitCode: 1,
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'error AX0001: Something broke';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    readdirMock.mockResolvedValue([]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FAILED');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('passes -metadata and -compilermetadata args to xppc.exe', async () => {
    const CUSTOM = 'C:\\Repos\\MyCode\\Metadata';
    const MSFT = 'C:\\AOSService\\PackagesLocalDirectory';
    const xppc = path.join(MSFT, 'bin', 'xppc.exe');

    cfgGetCustomPackagesPath.mockResolvedValue(CUSTOM);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(MSFT);

    const child = makeFakeChild(55);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, xppc]);

    await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain(`-metadata=${CUSTOM}`);
    expect(args).toContain(`-modelmodule=${MODEL_NAME}`);
    // The framework directory stays reachable as a reference folder, so Microsoft's
    // compiler metadata still resolves.
    expect(args).toContain(`-referenceFolder=${MSFT}`);
  });

  it('points -compilermetadata at the model store, never the framework directory', async () => {
    // xppc writes its compiler metadata BACK to the -compilermetadata root. Aimed at
    // the framework directory it deposits <FrameworkDirectory>\<CustomModel>\XppMetadata,
    // putting customer model names in a directory shared by every environment on the box
    // and splitting the -incremental baseline from the one VS maintains.
    const CUSTOM = 'C:\\Repos\\MyCode\\Metadata';
    const MSFT = 'C:\\AOSService\\PackagesLocalDirectory';
    const xppc = path.join(MSFT, 'bin', 'xppc.exe');

    cfgGetCustomPackagesPath.mockResolvedValue(CUSTOM);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(MSFT);

    const child = makeFakeChild(56);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, xppc]);

    await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain(`-compilermetadata=${CUSTOM}`);
    expect(args).not.toContain(`-compilermetadata=${MSFT}`);
  });

  it('records the xppc invocation in the build log', async () => {
    // Validating this patch on a real instance could only confirm it by its
    // effects, because the build log recorded no command line — buildLog() sends
    // that to stderr and to bridgeLogFile, and bridgeLogFile is optional. The
    // arguments belong in the log that is actually read after the fact.
    const CUSTOM = 'C:\\Repos\\MyCode\\Metadata';
    const MSFT = 'C:\\AOSService\\PackagesLocalDirectory';
    const xppc = path.join(MSFT, 'bin', 'xppc.exe');

    cfgGetCustomPackagesPath.mockResolvedValue(CUSTOM);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(MSFT);

    const child = makeFakeChild(57);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, xppc]);

    await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

    const logWrite = writeFileMock.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('d365build_log'),
    );
    expect(logWrite).toBeDefined();
    const written = String(logWrite![1]);
    expect(written).toContain('=== xppc invocation ===');
    expect(written).toContain(`-compilermetadata=${CUSTOM}`);
    expect(written).toContain(`-metadata=${CUSTOM}`);
  });

  // ---------------------------------------------------------------------------
  // Stale compiler-metadata stubs in the framework directory
  // ---------------------------------------------------------------------------
  describe('stale framework compiler-metadata stubs', () => {
    const CUSTOM = 'C:\\Repos\\MyCode\\Metadata';
    const MSFT   = 'C:\\AOSService\\PackagesLocalDirectory';
    const XPPC_UDE = path.join(MSFT, 'bin', 'xppc.exe');
    const STUB   = path.join(MSFT, MODEL_NAME);

    /** readdir answers for the stub folder only; every other path stays "not found". */
    function stubContains(entries: string[]) {
      readdirMock.mockImplementation(async (p: string) => {
        if (p === STUB) return entries;
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      });
    }

    beforeEach(() => {
      cfgGetCustomPackagesPath.mockResolvedValue(CUSTOM);
      cfgGetMicrosoftPackagesPath.mockResolvedValue(MSFT);
      spawnMock.mockReturnValue(makeFakeChild(58));
    });

    // Every build made before -compilermetadata moved deposited one of these. Nothing
    // refreshes them now, yet the framework directory is still a -referenceFolder, so
    // xppc keeps reading metadata frozen at the last pre-move build.
    it('deletes a write-back stub left in the framework directory', async () => {
      allowPaths([PROJECT_PATH, XPPC_UDE, path.join(CUSTOM, MODEL_NAME)]);
      stubContains(['XppMetadata']);

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

      expect(rmMock).toHaveBeenCalledWith(STUB, { recursive: true, force: true });
    });

    it('leaves a package genuinely installed in the framework directory alone', async () => {
      allowPaths([PROJECT_PATH, XPPC_UDE, path.join(CUSTOM, MODEL_NAME)]);
      stubContains(['bin', 'Descriptor', 'XppMetadata']);

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

      expect(rmMock).not.toHaveBeenCalled();
    });

    it('leaves it alone when the model is not in the model store', async () => {
      // No <modelStore>\<Model> — nothing establishes that the framework copy is the stale one.
      allowPaths([PROJECT_PATH, XPPC_UDE]);
      stubContains(['XppMetadata']);

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

      expect(rmMock).not.toHaveBeenCalled();
    });

    it('never touches the framework directory on CHE, where it holds the live metadata', async () => {
      cfgGetCustomPackagesPath.mockResolvedValue(PKG);
      cfgGetMicrosoftPackagesPath.mockResolvedValue(PKG);
      allowPaths([PROJECT_PATH, XPPC, path.join(PKG, MODEL_NAME)]);
      readdirMock.mockImplementation(async (p: string) => {
        if (p === path.join(PKG, MODEL_NAME)) return ['XppMetadata'];
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      });

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

      expect(rmMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // The model's own compiler metadata (xppc's write-back leaves removals stale)
  // ---------------------------------------------------------------------------
  describe('stale compiler metadata of the model being built', () => {
    const CUSTOM = 'C:\\Repos\\MyCode\\Metadata';
    const MSFT   = 'C:\\AOSService\\PackagesLocalDirectory';
    const XPPC_UDE = path.join(MSFT, 'bin', 'xppc.exe');
    const TREE   = path.join(CUSTOM, MODEL_NAME, 'XppMetadata');

    beforeEach(() => {
      cfgGetCustomPackagesPath.mockResolvedValue(CUSTOM);
      cfgGetMicrosoftPackagesPath.mockResolvedValue(MSFT);
      spawnMock.mockReturnValue(makeFakeChild(59));
    });

    it('clears the whole tree before a full build, and does not prune', async () => {
      allowPaths([PROJECT_PATH, XPPC_UDE, TREE]);

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false, fullBuild: true }, {});

      expect(rmMock).toHaveBeenCalledWith(TREE, { recursive: true, force: true });
      expect(pruneMock).not.toHaveBeenCalled();
      const [, args] = spawnMock.mock.calls[0];
      expect(args).not.toContain('-incremental');
    });

    it('builds anyway when the tree cannot be cleared', async () => {
      allowPaths([PROJECT_PATH, XPPC_UDE, TREE]);
      rmMock.mockRejectedValue(Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' }));

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false, fullBuild: true }, {});

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('prunes file by file — never clears the tree — before an incremental build', async () => {
      // An incremental build writes back only what it recompiles: a cleared tree would
      // lose every unchanged element.
      allowPaths([PROJECT_PATH, XPPC_UDE, TREE]);

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

      expect(pruneMock).toHaveBeenCalledWith(CUSTOM, CUSTOM, MODEL_NAME);
      expect(rmMock).not.toHaveBeenCalledWith(TREE, expect.anything());
      const [, args] = spawnMock.mock.calls[0];
      expect(args).toContain('-incremental');
      expect(pruneMock.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0]);
    });

    it('builds anyway when the prune throws', async () => {
      allowPaths([PROJECT_PATH, XPPC_UDE]);
      pruneMock.mockRejectedValue(new Error('boom'));

      await buildProjectTool({ projectPath: PROJECT_PATH, wait: false }, {});

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it('force=true kills orphaned build and restarts', async () => {
    const stateJson = JSON.stringify({
      pid: 1234,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_old.log',
      status: 'running',
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const child = makeFakeChild(5678);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH, force: true, wait: false }, {});

    // A new build was started
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('build started');
  });

  it('marks build as failed when xppc exits 0 but log contains Compile Error', async () => {
    let closeCallback: ((code: number | null) => void) | undefined;
    const child = {
      pid: 42,
      unref: vi.fn(),
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'close') closeCallback = cb;
      }),
    };
    spawnMock.mockReturnValue(child);
    allowPaths([XPPC, PKG]);
    cfgGetModelName.mockReturnValue(MODEL_NAME);

    await buildProjectTool({ modelName: MODEL_NAME, wait: false }, {});
    expect(closeCallback).toBeDefined();

    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return writeFileMock.mock.calls.filter((c: any[]) => c[0].includes('d365build_state')).at(-1)?.[1];
      if (p.endsWith('.xppc.err')) return "Compile Error: Class Method dynamics://MyModel/MyClass/myMethod: [(28,27),(28,28)]: ';' expected.";
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await closeCallback!(0);

    const lastStateWrite = writeFileMock.mock.calls
      .filter((c: any[]) => c[0].includes('d365build_state'))
      .at(-1);
    expect(lastStateWrite).toBeDefined();
    const state = JSON.parse(lastStateWrite![1]);
    expect(state.status).toBe('failed');
    expect(state.exitCode).toBe(0);
  });

  it('marks build as succeeded when xppc exits 0 and log has no Compile Error', async () => {
    let closeCallback: ((code: number | null) => void) | undefined;
    const child = {
      pid: 42,
      unref: vi.fn(),
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'close') closeCallback = cb;
      }),
    };
    spawnMock.mockReturnValue(child);
    allowPaths([XPPC, PKG]);
    cfgGetModelName.mockReturnValue(MODEL_NAME);

    await buildProjectTool({ modelName: MODEL_NAME, wait: false }, {});
    expect(closeCallback).toBeDefined();

    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return writeFileMock.mock.calls.filter((c: any[]) => c[0].includes('d365build_state')).at(-1)?.[1];
      if (p.endsWith('.xppc.err')) return 'Compile Warning: MyClass: potential issue.';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await closeCallback!(0);

    const lastStateWrite = writeFileMock.mock.calls
      .filter((c: any[]) => c[0].includes('d365build_state'))
      .at(-1);
    expect(lastStateWrite).toBeDefined();
    const state = JSON.parse(lastStateWrite![1]);
    expect(state.status).toBe('succeeded');
    expect(state.exitCode).toBe(0);
  });

  describe('OData actions, which -incremental drops from ODataExtends.runtime', () => {
    const lastState = () => writeFileMock.mock.calls.filter((c: any[]) => c[0].includes('d365build_state')).at(-1)![1];
    const build = async (params: Record<string, unknown> = {}) => {
      let closeCallback: ((code: number | null) => Promise<void>) | undefined;
      spawnMock.mockReturnValue({
        pid: 42,
        unref: vi.fn(),
        on: vi.fn().mockImplementation((event: string, cb: any) => { if (event === 'close') closeCallback = cb; }),
      });
      allowPaths([XPPC, PKG]);
      const started = await buildProjectTool({ modelName: MODEL_NAME, wait: false, ...params }, {});
      readFileMock.mockImplementation(async (p: string) => {
        if (p.includes('d365build_state')) return lastState();
        if (p.includes('d365build_log')) return 'Build complete.';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      await closeCallback!(0);
      const state = JSON.parse(lastState());
      readdirMock.mockResolvedValue([]);
      const collected = await buildProjectTool({ modelName: MODEL_NAME }, {});
      return { started, state, args: spawnMock.mock.calls[0][1] as string[], text: collected.content[0].text };
    };

    it('runs a full build, as Visual Studio does, when a changed entity declares actions', async () => {
      scanMock.mockResolvedValueOnce({ ...NO_ODATA_FINDINGS, recompiled: ['AxDataEntityView/ProbeEntity'] });
      const { started, state, args, text } = await build();
      expect(args).not.toContain('-incremental');
      expect(pruneMock).not.toHaveBeenCalled();
      expect(started.content[0].text).toContain('Full build started');
      expect(state).toMatchObject({ fullBuild: true, autoFullBuild: { recompiled: ['AxDataEntityView/ProbeEntity'] } });
      expect(text).toContain('✅ Build succeeded (xppc.exe, full build, switched from incremental');
      expect(text).toContain('AxDataEntityView/ProbeEntity');
      expect(text).not.toContain('Incremental: only CHANGED elements');
    });

    it('runs a full build when actions are already missing from the deployed file', async () => {
      scanMock.mockResolvedValueOnce({ ...NO_ODATA_FINDINGS, missing: [{ entity: 'ProbeEntity', actions: ['ExistingAction'] }] });
      const { args, text } = await build();
      expect(args).not.toContain('-incremental');
      expect(text).toContain('ProbeEntity (ExistingAction)');
    });

    it('stays incremental when no entity with actions is affected', async () => {
      const { args, text } = await build();
      expect(args).toContain('-incremental');
      // Once before xppc (recompile + deployed file), once after it (deployed file only).
      expect(scanMock.mock.calls.map(c => c[3])).toEqual([undefined, { checkRecompile: false }]);
      expect(schemaScanMock).toHaveBeenCalledTimes(1);
      expect(text).toContain('✅ Build succeeded (xppc.exe, incremental');
    });

    it('runs a full build when a table or an EDT changed since the last build', async () => {
      const changed = ['AxTable/ContosoRentEquipmentTable', 'AxTable/ContosoRentOrderTable', 'AxEdt/ContosoRentEquipmentId'];
      schemaScanMock.mockResolvedValueOnce({ changed, errors: [] });
      const { started, state, args, text } = await build();
      expect(args).not.toContain('-incremental');
      expect(pruneMock).not.toHaveBeenCalled();
      expect(schemaScanMock).toHaveBeenCalledTimes(1);
      expect(schemaScanMock.mock.calls[0][2]).toBe(MODEL_NAME);
      expect(started.content[0].text).toContain('Full build started');
      expect(state).toMatchObject({ fullBuild: true, autoFullBuild: { recompiled: [], missing: [], schemaChanged: changed } });
      expect(text).toContain('✅ Build succeeded (xppc.exe, full build, switched from incremental');
      expect(text).toContain(
        '2 tables, 1 EDT changed since the last build: ContosoRentEquipmentTable, ContosoRentOrderTable, ContosoRentEquipmentId.',
      );
      expect(text).toContain('can report 0 errors where a full build fails');
      // The OData explanation belongs to the OData reason only.
      expect(text).not.toContain('ODataExtends.runtime');
    });

    it('gives both reasons when an entity with actions and an enum changed', async () => {
      scanMock.mockResolvedValueOnce({ ...NO_ODATA_FINDINGS, recompiled: ['AxDataEntityView/ProbeEntity'] });
      schemaScanMock.mockResolvedValueOnce({ changed: ['AxEnum/ContosoRentStatus'], errors: [] });
      const { args, text } = await build();
      expect(args).not.toContain('-incremental');
      expect(text).toContain(
        'changed elements with OData actions: AxDataEntityView/ProbeEntity; 1 enum changed since the last build: ContosoRentStatus.',
      );
      expect(text).toContain('ODataExtends.runtime');
    });

    it('does not treat fullBuild: false as an opt-out, like the OData switch', async () => {
      schemaScanMock.mockResolvedValueOnce({ changed: ['AxTable/ContosoRentEquipmentTable'], errors: [] });
      const { args, state } = await build({ fullBuild: false });
      expect(args).not.toContain('-incremental');
      expect(state.autoFullBuild.schemaChanged).toEqual(['AxTable/ContosoRentEquipmentTable']);
    });

    it('stays incremental when the table, EDT and enum scan fails', async () => {
      schemaScanMock.mockRejectedValueOnce(new Error('boom'));
      const { args, state } = await build();
      expect(args).toContain('-incremental');
      expect(state.autoFullBuild).toBeUndefined();
    });

    it('does not run the pre-build scan for a requested full build', async () => {
      const { args, state } = await build({ fullBuild: true });
      expect(args).not.toContain('-incremental');
      expect(scanMock.mock.calls.map(c => c[3])).toEqual([{ checkRecompile: false }]);
      expect(schemaScanMock).not.toHaveBeenCalled();
      expect(state.autoFullBuild).toBeUndefined();
    });

    it('warns instead of a green result when actions are still missing after the build', async () => {
      scanMock
        .mockResolvedValueOnce(NO_ODATA_FINDINGS)
        .mockResolvedValueOnce({ ...NO_ODATA_FINDINGS, missing: [{ entity: 'ProbeEntity', actions: ['NewAction'] }] });
      const { text } = await build();
      expect(text).toContain('⚠️ Build succeeded; OData actions missing');
      expect(text).not.toContain('✅ Build succeeded');
      expect(text).toContain('ProbeEntity (NewAction)');
      expect(text).toContain('fullBuild: true');
    });
  });

  describe('form patterns, which a pipeline build checks on every form of the package', () => {
    const lastState = () => writeFileMock.mock.calls.filter((c: any[]) => c[0].includes('d365build_state')).at(-1)![1];
    const build = async (params: Record<string, unknown> = {}) => {
      let closeCallback: ((code: number | null) => Promise<void>) | undefined;
      spawnMock.mockReturnValue({
        pid: 42,
        unref: vi.fn(),
        on: vi.fn().mockImplementation((event: string, cb: any) => { if (event === 'close') closeCallback = cb; }),
      });
      allowPaths([XPPC, PKG]);
      await buildProjectTool({ modelName: MODEL_NAME, wait: false, ...params }, {});
      readFileMock.mockImplementation(async (p: string) => {
        if (p.includes('d365build_state')) return lastState();
        if (p.includes('d365build_log')) return 'Build complete.';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      await closeCallback!(0);
      const state = JSON.parse(lastState());
      readdirMock.mockResolvedValue([]);
      const collected = await buildProjectTool({ modelName: MODEL_NAME }, {});
      return { state, collected, text: collected.content[0].text };
    };
    const COLUMNS_MODE = {
      form: 'ContosoRentEquipment', rule: 'FP011', path: 'Design/Group[HeaderGroup]',
      excerpt: 'sub-pattern FieldsFieldGroups 1.1: ColumnsMode must be "Fill", is "Fixed" (default)',
    };

    it('fails a compiled build whose forms break their pattern, naming form, control and property', async () => {
      patternScanMock.mockResolvedValue({ errors: [COLUMNS_MODE], formsChecked: 3, unreadable: [] });
      const { state, collected, text } = await build();
      expect(patternScanMock).toHaveBeenCalledWith(PKG, MODEL_NAME);
      expect(state.formPatternErrors).toEqual([COLUMNS_MODE]);
      expect(collected.isError).toBe(true);
      expect(text).toContain('❌ Compiled; form pattern errors a pipeline build rejects');
      expect(text).not.toContain('✅ Build succeeded');
      expect(text).toContain('AxForm/ContosoRentEquipment: Design/Group[HeaderGroup]: sub-pattern FieldsFieldGroups 1.1: ColumnsMode must be "Fill"');
    });

    it('stays green when every form follows its pattern', async () => {
      const { state, collected, text } = await build();
      expect(patternScanMock).toHaveBeenCalledTimes(1);
      expect(state.formPatternErrors).toBeUndefined();
      expect(collected.isError).toBeFalsy();
      expect(text).toContain('✅ Build succeeded');
    });

    it('reports without failing the build when FORM_PATTERN_ENFORCE is off', async () => {
      vi.stubEnv('FORM_PATTERN_ENFORCE', 'false');
      try {
        patternScanMock.mockResolvedValue({ errors: [COLUMNS_MODE], formsChecked: 1, unreadable: [] });
        const { collected, text } = await build();
        expect(collected.isError).toBeFalsy();
        expect(text).toContain('⚠️ Build succeeded; form pattern errors');
        expect(text).toContain('FORM_PATTERN_ENFORCE is off');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('keeps the build green when the check itself fails', async () => {
      patternScanMock.mockRejectedValue(new Error('disk gone'));
      const { collected, text } = await build();
      expect(collected.isError).toBeFalsy();
      expect(text).toContain('✅ Build succeeded');
    });
  });

  // Issue #1048 asked whether a build could pass while its log reports errors
  // other than "Compile Error:" — the verdict regex knows only that prefix.
  // Probed on the VM (2026-09-29, fm-mcp sandbox): every other error kind came
  // with a NON-ZERO exit code, so the exit code fails the build and the regex
  // gap never decides. The rows below are the real log lines and exit codes.
  // (Incremental builds reported neither the pattern nor the relation error at
  // all — exit 0, empty log — which is what incrementalScopeCaveat warns about.)
  it.each([
    [1, "Compile Fatal Error: Class dynamics://Class/Probe1048ClassB: The element must be named 'Probe1048ClassA' instead of 'Probe1048ClassB' to be consistent with its file name.\nErrors: 1"],
    [1, "Metadata Error: AxTable/Probe1048RelTable/Relations/NoSuchTable/RelatedTable: Table 'NoSuchTableProbe1048' does not exist.\nErrors: 1"],
    [2, "FormPatternValidation Error: AxForm/Probe1048Form/Design: Control 'AxForm/Probe1048Form/Design' is missing child 'Dialog Content Group' required by pattern 'Drop Dialog'.\nErrors: 2"],
  ])('fails a build whose xppc exits %i with a non-"Compile Error:" error line, as xppc really does', async (exitCode, log) => {
    let closeCallback: ((code: number | null) => void) | undefined;
    const child = {
      pid: 42,
      unref: vi.fn(),
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'close') closeCallback = cb;
      }),
    };
    spawnMock.mockReturnValue(child);
    allowPaths([XPPC, PKG]);
    cfgGetModelName.mockReturnValue(MODEL_NAME);

    await buildProjectTool({ modelName: MODEL_NAME, wait: false }, {});
    readFileMock.mockImplementation(async (p: string) => {
      // The close handler finishes only a build it still owns: serve the state it wrote.
      if (p.includes('d365build_state')) return writeFileMock.mock.calls.filter((c: any[]) => c[0].includes('d365build_state')).at(-1)?.[1];
      if (p.endsWith('.xppc.err')) return log;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await closeCallback!(exitCode);

    const state = JSON.parse(writeFileMock.mock.calls
      .filter((c: any[]) => c[0].includes('d365build_state'))
      .at(-1)![1]);
    expect(state.status).toBe('failed');
    expect(state.exitCode).toBe(exitCode);
  });

  it('buildJobKey is case-insensitive: MYMODEL and mymodel resolve same state file path', async () => {
    const readPaths: string[] = [];

    // First call: no state, spawns build — record which state path was attempted
    const child = makeFakeChild(42);
    spawnMock.mockReturnValue(child);
    allowPaths([XPPC, PKG]);
    cfgGetModelName.mockReturnValue(null);

    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) { readPaths.push(p); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await buildProjectTool({ modelName: 'mymodel', wait: false }, {});
    const firstPath = readPaths[0];
    expect(firstPath).toBeDefined();

    // Second call: uppercase model — should hit the same state file path
    vi.resetAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(new Error('not found'));
    rmMock.mockResolvedValue(undefined);
    cfgGetActiveXppConfig.mockResolvedValue(null);
    cfgGetModelName.mockReturnValue(null);
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetContext.mockReturnValue({});
    allowPaths([XPPC, PKG]);

    const runningState = JSON.stringify({
      pid: 42, modelName: 'mymodel', tool: 'xppc.exe',
      startTime: new Date().toISOString(), logFile: 'C:\\Temp\\log.log', status: 'running',
    });
    const readPaths2: string[] = [];
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) { readPaths2.push(p); return runningState; }
      if (p.includes('d365build_log')) return 'Compiling...';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.spyOn(process, 'kill').mockReturnValue(true as any);

    const result = await buildProjectTool({ modelName: 'MYMODEL', wait: false }, {});
    const secondPath = readPaths2[0];
    expect(secondPath).toBeDefined();
    expect(result.content[0].text).toContain('Call again to refresh');
    expect(firstPath).toBe(secondPath);

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // #829 — an explicit fullBuild:true is a request to RECOMPILE, not a request
  // for the newest available result, and a build that outlives the wait window
  // must not turn into a second "call me again to collect" round trip.
  // -------------------------------------------------------------------------

  /** State-file JSON for a build that has already finished. */
  function finishedState(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      pid: 888,
      modelName: MODEL_NAME,
      targetModel: MODEL_NAME,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 49_000).toISOString(),
      endTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_prev.log',
      status: 'succeeded',
      exitCode: 0,
      ...extra,
    });
  }

  function serveState(stateJson: string) {
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'Build complete.';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  }

  it('fullBuild:true recompiles instead of replaying a finished FULL build', async () => {
    serveState(finishedState({ fullBuild: true }));
    // Sources unchanged since the build ended — the cached result would
    // otherwise be considered perfectly reusable.
    readdirMock.mockResolvedValue([]);
    spawnMock.mockReturnValue(makeFakeChild(4242));
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    const result = await buildProjectTool(
      { projectPath: PROJECT_PATH, fullBuild: true, wait: false }, {},
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).not.toContain('-incremental');
    expect(result.content[0].text).not.toContain('Collected the result');
    expect(result.content[0].text).toContain('Full build started');
  });

  it('fullBuild:true recompiles instead of replaying a finished INCREMENTAL build', async () => {
    serveState(finishedState());
    readdirMock.mockResolvedValue([]);
    spawnMock.mockReturnValue(makeFakeChild(4243));
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    const result = await buildProjectTool(
      { projectPath: PROJECT_PATH, fullBuild: true, wait: false }, {},
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).not.toContain('Collected the result');
  });

  it('declines fullBuild:true while an INCREMENTAL build is running, and says why', async () => {
    serveState(JSON.stringify({
      pid: 777,
      modelName: MODEL_NAME,
      targetModel: MODEL_NAME,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 20_000).toISOString(),
      logFile: 'C:\\Temp\\d365build_log_run.log',
      status: 'running',
    }));
    allowPaths([PROJECT_PATH, XPPC, PKG]);
    const origKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: any, sig: any) => {
      if (pid === 777 && sig === 0) return true as any;
      return origKill(pid, sig);
    });

    const result = await buildProjectTool({ projectPath: PROJECT_PATH, fullBuild: true }, {});

    expect(result.content[0].text).toContain('DECLINED');
    expect(result.content[0].text).toContain('nothing was recompiled by this call');
    expect(result.content[0].text).toContain('force: true');
    expect(spawnMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('waits through the post-build finalizing phase instead of handing back a "still running" stub', async () => {
    // The 185 s double-call of #829: xppc exits, the close handler is still
    // regenerating runtime metadata, and the waiter used to read the dead PID
    // as "orphaned/timed out" for a build that had in fact just succeeded.
    const base = {
      pid: 4242,
      modelName: MODEL_NAME,
      targetModel: MODEL_NAME,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 185_000).toISOString(),
      logFile: 'C:\\Temp\\d365build_log_fin.log',
    };
    let stateReads = 0;
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) {
        stateReads++;
        return stateReads <= 2
          ? JSON.stringify({ ...base, status: 'running', phase: 'finalizing' })
          : JSON.stringify({ ...base, status: 'succeeded', exitCode: 0, endTime: new Date().toISOString() });
      }
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'Build complete.';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    allowPaths([PROJECT_PATH, XPPC, PKG]);
    // An unchanged, readable model tree: an unreadable one cannot be proven unchanged, and the
    // call would then compile again rather than attach (buildAgainAfterRunningBuild).
    readdirMock.mockResolvedValue([]);
    // PID 4242 is gone — only the 'finalizing' phase says the build is alive.
    const origKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: any, sig: any) => {
      if (pid === 4242 && sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return origKill(pid, sig);
    });
    const onProgress = vi.fn().mockResolvedValue(undefined);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {}, onProgress);

    expect(result.content[0].text).toContain('Build succeeded');
    expect(result.content[0].text).not.toContain('timeout');
    expect(spawnMock).not.toHaveBeenCalled();
    // Progress streamed while blocking, naming the phase the caller cannot see.
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls[0][0]).toContain('finalizing');
    expect(typeof onProgress.mock.calls[0][1]).toBe('number');

    vi.restoreAllMocks();
  });

  it('timeout message carries the elapsed/window state and a concrete waitTimeoutMs to retry with', async () => {
    spawnMock.mockReturnValue(makeFakeChild(51));
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    // 1 ms window — the wait expires before the build can possibly finish.
    const result = await buildProjectTool(
      { projectPath: PROJECT_PATH, waitTimeoutMs: 1 }, {},
    );

    const text = result.content[0].text;
    expect(text).toContain('still running after');
    expect(text).toContain('The build is NOT finished');
    expect(text).toContain('does not start a second one');
    const suggested = text.match(/waitTimeoutMs: (\d+)/);
    expect(suggested).toBeTruthy();
    expect(Number(suggested![1])).toBeGreaterThanOrEqual(600_000);
    expect(result.isError).toBeFalsy();
  });

  it('uses explicit modelName param without requiring projectPath or rnrproj', async () => {
    const child = makeFakeChild(77);
    spawnMock.mockReturnValue(child);
    allowPaths([XPPC, PKG]);
    cfgGetModelName.mockReturnValue(null);

    const result = await buildProjectTool({ modelName: 'ExplicitModel', wait: false }, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-modelmodule=ExplicitModel');
    expect(result.content[0].text).toContain('build started');
    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// readFullLog — the excerpt returned for a FAILED build
// ---------------------------------------------------------------------------
describe('readFullLog', () => {
  const HEADER = [
    '=== xppc invocation ===',
    'C:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    '  -metadata=C:\\Repos\\MyCode\\Metadata',
    '  -compilermetadata=C:\\Repos\\MyCode\\Metadata',
    '  -modelmodule=MyModel',
    '=======================',
    '',
  ];

  /** A log too long to be returned whole, with one diagnostic buried in the middle. */
  function longLog(header: string[] = HEADER) {
    return [
      ...header,
      ...Array.from({ length: 400 }, (_, i) => `Phase timing row ${i}`),
      "Compile Error: Class dynamics://MyModel/MyClass: [(1,1),(1,2)]: ';' expected.",
      ...Array.from({ length: 400 }, (_, i) => `More phase timing ${i}`),
      'Errors: 1',
    ].join('\n');
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  // The header is written so that a failed build can be traced back to its arguments —
  // and a failed build is precisely when this excerpt path runs. It used to return only
  // diagnostic windows plus a tail, so the header never reached the response.
  it('keeps the invocation header when the log is trimmed to diagnostic windows', async () => {
    readFileMock.mockResolvedValue(longLog());

    const out = await readFullLog('C:\\Temp\\d365build_log.log');

    // The diagnostic-window path, not the head+tail fallback — which would include the
    // top of the log anyway and make this assertion vacuous.
    expect(out).toContain('Phase table omitted');
    expect(out).toContain('=== xppc invocation ===');
    expect(out).toContain('-compilermetadata=C:\\Repos\\MyCode\\Metadata');
    expect(out).toContain('Compile Error:');
  });

  it('is unaffected by a log that has no invocation header', async () => {
    readFileMock.mockResolvedValue(longLog([]));

    const out = await readFullLog('C:\\Temp\\d365build_log.log');

    expect(out).not.toContain('=== xppc invocation ===');
    expect(out).toContain('Compile Error:');
  });

  it('returns a short log whole', async () => {
    readFileMock.mockResolvedValue([...HEADER, 'Errors: 0'].join('\n'));

    const out = await readFullLog('C:\\Temp\\d365build_log.log');

    expect(out).toContain('=== xppc invocation ===');
    expect(out).toContain('Errors: 0');
  });
});

// ---------------------------------------------------------------------------
// renderFailureLog — how much raw log a FAILED build is worth carrying
// ---------------------------------------------------------------------------
//
// build_d365fo_project is deliberately 'uncapped' in the response capper, and a
// failure used to return the structured diagnostics AND up to 300 raw log lines.
// Measured over 1,400 real MCP calls, all 43 build results sat at the host's
// logging cap, and every byte of that is re-billed on every later request in the
// session. The raw log is evidence only when the parser produced nothing — that
// is the case renderUnexplainedFailure points at ("read the raw log at the end
// of this response"), and it must keep working.
describe('renderFailureLog', () => {
  const HEADER = [
    '=== xppc invocation ===',
    'C:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    '  -modelmodule=MyModel',
    '=======================',
    '',
  ];

  /** A captured-shape xppc log: long phase table, one diagnostic, a tally. */
  const CAPTURED = [
    ...HEADER,
    ...Array.from({ length: 400 }, (_, i) => `Phase timing row ${i}`),
    "Compile Error: Class dynamics://MyModel/MyClass: [(1,1),(1,2)]: ';' expected.",
    ...Array.from({ length: 400 }, (_, i) => `More phase timing ${i}`),
    'Errors: 1',
  ].join('\n');

  beforeEach(() => { vi.resetAllMocks(); });

  it('returns the whole excerpt when NO diagnostic could be parsed — the raw log is the only evidence', async () => {
    readFileMock.mockResolvedValue(CAPTURED);

    const out = await renderFailureLog('C:\\Temp\\d365build_log.log', false);

    expect(out).toBe(await readFullLog('C:\\Temp\\d365build_log.log'));
    expect(out).toContain('=== xppc invocation ===');
    expect(out).toContain('Compile Error:');
  });

  it('returns a short tail plus the log path once diagnostics were parsed', async () => {
    readFileMock.mockResolvedValue(CAPTURED);

    const trimmed = await renderFailureLog('C:\\Temp\\d365build_log.log', true);
    const full = await readFullLog('C:\\Temp\\d365build_log.log');

    // The tail still carries xppc's own tally, which is what the diagnostics get
    // cross-checked against (see renderUnexplainedFailure).
    expect(trimmed).toContain('Errors: 1');
    // …and it names where the rest is, so nothing is lost, only deferred.
    expect(trimmed).toContain('C:\\Temp\\d365build_log.log');
    // 41 lines of tail + one header line, whatever the log's length.
    expect(trimmed.split('\n').length).toBeLessThanOrEqual(42);
    expect(trimmed.length).toBeLessThan(full.length);
  });
});
