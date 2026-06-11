import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const {
  accessMock, writeFileMock, appendFileMock, unlinkMock, readFileMock, readdirMock, spawnMock, execFileMock,
  cfgEnsureLoaded, cfgGetProjectPath, cfgGetPackagePath, cfgGetContext,
  cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath,
  cfgGetActiveXppConfig, cfgGetModelName,
} = vi.hoisted(() => {
  const accessMock = vi.fn();
  const writeFileMock = vi.fn().mockResolvedValue(undefined);
  const appendFileMock = vi.fn().mockResolvedValue(undefined);
  const unlinkMock = vi.fn().mockResolvedValue(undefined);
  const readFileMock = vi.fn();
  const readdirMock = vi.fn().mockRejectedValue(new Error('not found'));
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
    accessMock, writeFileMock, appendFileMock, unlinkMock, readFileMock, readdirMock, spawnMock, execFileMock,
    cfgEnsureLoaded, cfgGetProjectPath, cfgGetPackagePath, cfgGetContext,
    cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath,
    cfgGetActiveXppConfig, cfgGetModelName,
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

import path from 'path';
import { buildProjectTool } from '../../src/tools/buildProject';

const PROJECT_PATH = 'C:\\MyProject\\MyProject.rnrproj';
const MODEL_NAME = 'MyModel';
const RNRPROJ_XML = `<Project><Model>${MODEL_NAME}</Model></Project>`;
const PKG = 'C:\\AOSService\\PackagesLocalDirectory';
const XPPC = path.join(PKG, 'bin', 'xppc.exe');

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
    writeFileMock.mockResolvedValue(undefined);
    appendFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(new Error('not found'));
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
    // No CHE candidates accessible, no configManager paths
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot resolve D365FO package paths');
    expect(spawnMock).not.toHaveBeenCalled();
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

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.content[0].text).toContain('succeeded');
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
    expect(args).toContain(`-compilermetadata=${MSFT}`);
    expect(args).toContain(`-modelmodule=${MODEL_NAME}`);
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
