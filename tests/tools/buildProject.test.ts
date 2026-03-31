import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const { execFilePromisified, execFileMock, accessMock, writeFileMock, unlinkMock } = vi.hoisted(() => {
  const execFilePromisified = vi.fn();
  const execFileMock: any = vi.fn();
  execFileMock[Symbol.for('nodejs.util.promisify.custom')] = (
    file: string,
    args: string[],
    opts: any,
  ) => execFilePromisified(file, args, opts);
  const accessMock = vi.fn();
  const writeFileMock = vi.fn().mockResolvedValue(undefined);
  const unlinkMock = vi.fn().mockResolvedValue(undefined);
  return { execFilePromisified, execFileMock, accessMock, writeFileMock, unlinkMock };
});

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('fs/promises', () => ({
  access: accessMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
}));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: vi.fn(),
    getProjectPath: vi.fn().mockResolvedValue('C:\\MyProject\\MyProject.rnrproj'),
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import { buildProjectTool } from '../../src/tools/buildProject';

// --- helpers -----------------------------------------------------------------
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const VS_INSTALL = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise';
const VSDEVCMD = `${VS_INSTALL}\\Common7\\Tools\\VsDevCmd.bat`;
const MSBUILD = `${VS_INSTALL}\\MSBuild\\Current\\Bin\\MSBuild.exe`;

/** Make `access()` succeed only for the listed paths. */
function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    if (paths.includes(p)) return;
    throw new Error(`ENOENT: ${p}`);
  });
}

/** Simulate vswhere returning the given install path. */
function setupVswhere(installPath: string) {
  execFilePromisified.mockImplementation(
    async (file: string, _args: string[], _opts: any) => {
      if (file === VSWHERE) {
        return { stdout: `${installPath}\r\n`, stderr: '' };
      }
      // cmd.exe or MSBuild invocation — succeed with empty output
      return { stdout: '', stderr: '' };
    },
  );
}

describe('build_d365fo_project', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
  });

  it('writes a temp batch file with VsDevCmd and MSBuild on separate lines', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    // A temp .cmd file should have been written
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [tempPath, batContent] = writeFileMock.mock.calls[0];
    expect(tempPath).toMatch(/d365build_[0-9a-f]+\.cmd$/);

    // The batch content must have VsDevCmd and MSBuild on separate lines
    expect(batContent).toContain('@echo off');
    expect(batContent).toContain(`call "${VSDEVCMD}"`);
    expect(batContent).toContain(`"${MSBUILD}"`);
    // VsDevCmd and MSBuild must NOT be on the same line (no && chaining)
    expect(batContent).not.toContain('&&');

    // cmd.exe should be invoked with just the temp file path — no embedded quotes
    const cmdCall = execFilePromisified.mock.calls.find(
      (c: any[]) => c[0] === 'cmd.exe',
    );
    expect(cmdCall).toBeDefined();
    expect(cmdCall![1]).toEqual(['/C', tempPath]);
  });

  it('cleans up the temp batch file after build', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    const tempPath = writeFileMock.mock.calls[0][0];
    expect(unlinkMock).toHaveBeenCalledWith(tempPath);
  });

  it('cleans up the temp file even when build fails', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD]);
    // vswhere succeeds, but cmd.exe fails
    execFilePromisified.mockImplementation(
      async (file: string, _args: string[], _opts: any) => {
        if (file === VSWHERE) {
          return { stdout: `${VS_INSTALL}\r\n`, stderr: '' };
        }
        const err: any = new Error('Build failed');
        err.stdout = 'error CS0001: something broke';
        err.stderr = '';
        throw err;
      },
    );

    await buildProjectTool({}, {});

    // Temp file must still be cleaned up despite the error
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('does not create temp batch file when running MSBuild directly (no VsDevCmd)', async () => {
    // vswhere returns an install path where VsDevCmd does NOT exist
    allowPaths([VSWHERE, MSBUILD]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    // No temp file should be written
    expect(writeFileMock).not.toHaveBeenCalled();

    const msbuildCall = execFilePromisified.mock.calls.find(
      (c: any[]) => c[0] === MSBUILD,
    );
    expect(msbuildCall).toBeDefined();
  });

  it('handles VS paths with spaces correctly in temp batch file', async () => {
    const spaceInstall = 'C:\\Program Files\\Microsoft Visual Studio\\2026\\Preview';
    const spaceDevCmd = `${spaceInstall}\\Common7\\Tools\\VsDevCmd.bat`;
    const spaceMsbuild = `${spaceInstall}\\MSBuild\\Current\\Bin\\MSBuild.exe`;

    allowPaths([VSWHERE, spaceMsbuild, spaceDevCmd]);
    setupVswhere(spaceInstall);

    await buildProjectTool({}, {});

    const [, batContent] = writeFileMock.mock.calls[0];
    // Paths with spaces must be properly quoted inside the batch file
    expect(batContent).toContain(`call "${spaceDevCmd}"`);
    expect(batContent).toContain(`"${spaceMsbuild}"`);
  });

  it('falls back to hardcoded candidates when vswhere is unavailable', async () => {
    const hardcodedMsbuild =
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe';
    const hardcodedDevCmd =
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat';

    // vswhere NOT available; hardcoded paths exist
    allowPaths([hardcodedMsbuild, hardcodedDevCmd]);
    execFilePromisified.mockResolvedValue({ stdout: '', stderr: '' });

    await buildProjectTool({}, {});

    // Should still use temp batch file approach
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, batContent] = writeFileMock.mock.calls[0];
    expect(batContent).toContain(`call "${hardcodedDevCmd}"`);
    expect(batContent).toContain(`"${hardcodedMsbuild}"`);
  });
});
