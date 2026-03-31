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
    getPackagePath: vi.fn().mockReturnValue(null),
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import path from 'path';
import { buildProjectTool } from '../../src/tools/buildProject';

// --- helpers -----------------------------------------------------------------
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const VS_INSTALL = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise';
const VSDEVCMD = path.join(VS_INSTALL, 'Common7', 'Tools', 'VsDevCmd.bat');
const MSBUILD = path.join(VS_INSTALL, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
const DEVENV = path.join(VS_INSTALL, 'Common7', 'IDE', 'devenv.com');

function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    if (paths.includes(p)) return;
    throw new Error(`ENOENT: ${p}`);
  });
}

function setupVswhere(installPath: string) {
  execFilePromisified.mockImplementation(
    async (file: string, _args: string[], _opts: any) => {
      if (file === VSWHERE) return { stdout: `${installPath}\r\n`, stderr: '' };
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

  // --- MSBuild + VsDevCmd (primary path) ---

  it('writes a temp .cmd with VsDevCmd and MSBuild on separate lines', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD, DEVENV]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [tempPath, batContent] = writeFileMock.mock.calls[0];
    expect(tempPath).toMatch(/d365build_[0-9a-f]+\.cmd$/);
    expect(batContent).toContain('@echo off');
    expect(batContent).toContain(`call "${VSDEVCMD}"`);
    expect(batContent).toContain(`"${MSBUILD}"`);
    expect(batContent).not.toContain('&&');

    const cmdCall = execFilePromisified.mock.calls.find((c: any[]) => c[0] === 'cmd.exe');
    expect(cmdCall).toBeDefined();
    expect(cmdCall![1]).toEqual(['/C', tempPath]);
  });

  it('cleans up the temp .cmd after build', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD, DEVENV]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith(writeFileMock.mock.calls[0][0]);
  });

  it('cleans up even when build fails', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD, DEVENV]);
    execFilePromisified.mockImplementation(async (file: string) => {
      if (file === VSWHERE) return { stdout: `${VS_INSTALL}\r\n`, stderr: '' };
      const err: any = new Error('Build failed');
      err.stdout = 'error CS0001: something broke';
      err.stderr = '';
      throw err;
    });

    await buildProjectTool({}, {});
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('runs MSBuild directly when VsDevCmd is missing', async () => {
    allowPaths([VSWHERE, MSBUILD, DEVENV]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(execFilePromisified.mock.calls.find((c: any[]) => c[0] === MSBUILD)).toBeDefined();
  });

  it('handles VS paths with spaces correctly', async () => {
    const spaceInstall = 'C:\\Program Files\\Microsoft Visual Studio\\2026\\Preview';
    const spaceDevCmd = path.join(spaceInstall, 'Common7', 'Tools', 'VsDevCmd.bat');
    const spaceMsbuild = path.join(spaceInstall, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
    const spaceDevenv = path.join(spaceInstall, 'Common7', 'IDE', 'devenv.com');

    allowPaths([VSWHERE, spaceMsbuild, spaceDevCmd, spaceDevenv]);
    setupVswhere(spaceInstall);

    await buildProjectTool({}, {});

    const [, batContent] = writeFileMock.mock.calls[0];
    expect(batContent).toContain(`call "${spaceDevCmd}"`);
    expect(batContent).toContain(`"${spaceMsbuild}"`);
  });

  it('falls back to hardcoded candidates when vswhere is unavailable', async () => {
    const hcMsbuild = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe';
    const hcDevCmd = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat';

    allowPaths([hcMsbuild, hcDevCmd]);
    execFilePromisified.mockResolvedValue({ stdout: '', stderr: '' });

    await buildProjectTool({}, {});

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, batContent] = writeFileMock.mock.calls[0];
    expect(batContent).toContain(`call "${hcDevCmd}"`);
    expect(batContent).toContain(`"${hcMsbuild}"`);
  });

  it('sets PackagesFolder env vars in batch file', async () => {
    const PKG = 'C:\\AOSService\\PackagesLocalDirectory';
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD, DEVENV, PKG]);
    setupVswhere(VS_INSTALL);

    await buildProjectTool({}, {});

    const batContent = writeFileMock.mock.calls[0][1] as string;
    expect(batContent).toContain(`set "PackagesFolder=${PKG}"`);
    expect(batContent).toContain(`set "MetadataDir=${PKG}"`);
    expect(batContent).toContain(`set "PATH=%PATH%;${PKG}\\bin"`);
  });

  // --- devenv.com /build fallback ---

  it('falls back to devenv.com on MSB4062', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD, DEVENV]);
    execFilePromisified.mockImplementation(async (file: string) => {
      if (file === VSWHERE) return { stdout: `${VS_INSTALL}\r\n`, stderr: '' };
      if (file === 'cmd.exe') {
        const err: any = new Error('Build failed');
        err.stdout = 'error MSB4062: The "CopyReferencesTask" task could not be loaded from the assembly Microsoft.Dynamics.Framework.Tools.BuildTasks.17.0';
        err.stderr = '';
        throw err;
      }
      if (file === DEVENV) return { stdout: 'Build: 1 succeeded, 0 failed, 0 skipped', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await buildProjectTool({}, {});

    expect(result.content[0].text).toContain('devenv.com');
    expect(result.content[0].text).toContain('succeeded');
    expect(result.isError).toBeFalsy();

    const devenvCall = execFilePromisified.mock.calls.find((c: any[]) => c[0] === DEVENV);
    expect(devenvCall).toBeDefined();
    expect(devenvCall![1]).toContain('/build');
    expect(devenvCall![1]).toContain('Debug');
  });

  it('reports MSB4062 with instructions when devenv.com is unavailable', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD]);
    execFilePromisified.mockImplementation(async (file: string) => {
      if (file === VSWHERE) return { stdout: `${VS_INSTALL}\r\n`, stderr: '' };
      if (file === 'cmd.exe') {
        const err: any = new Error('Build failed');
        err.stdout = 'error MSB4062: Microsoft.Dynamics.Framework.Tools.BuildTasks';
        err.stderr = '';
        throw err;
      }
      return { stdout: '', stderr: '' };
    });

    const result = await buildProjectTool({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('MSB4062');
    expect(result.content[0].text).toContain('devenv.com was not found');
    expect(result.content[0].text).toContain('Visual Studio 2022');
  });

  it('reports devenv.com build failure', async () => {
    allowPaths([VSWHERE, MSBUILD, VSDEVCMD, DEVENV]);
    execFilePromisified.mockImplementation(async (file: string) => {
      if (file === VSWHERE) return { stdout: `${VS_INSTALL}\r\n`, stderr: '' };
      if (file === 'cmd.exe') {
        const err: any = new Error('Build failed');
        err.stdout = 'error MSB4062: Microsoft.Dynamics.Framework.Tools.BuildTasks';
        err.stderr = '';
        throw err;
      }
      if (file === DEVENV) return { stdout: 'Build: 0 succeeded, 1 failed\nerror AX0001: bad', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await buildProjectTool({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('devenv.com');
    expect(result.content[0].text).toContain('FAILED');
  });
});