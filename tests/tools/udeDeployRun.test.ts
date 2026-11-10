import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// deployModelToUde with the PowerShell child, the sign-in and the lock replaced: the order of
// sign-in, lock and token, and the run around the child.
const m = vi.hoisted(() => ({
  events: [] as string[], spawn: vi.fn(), token: vi.fn(), requests: [] as any[], lockHeld: false,
}));
vi.mock('node:child_process', () => ({ spawn: m.spawn, execFile: vi.fn() }));
vi.mock('../../src/utils/dataverseAuth.js', () => ({
  DEFAULT_DATAVERSE_CLIENT_ID: 'default',
  getDataverseAccessToken: m.token,
  readDataverseSettings: () => undefined,
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: async (_key: string, fn: () => Promise<unknown>) => {
    m.events.push('lock');
    m.lockHeld = true;
    try { return await fn(); } finally { m.lockHeld = false; m.events.push('unlock'); }
  },
}));
import { deployModelToUde } from '../../src/tools/sdlc/udeDeploy';

const DATAVERSE = { url: 'https://contoso-dev.crm.dynamics.com', clientId: 'c', tenant: 'organizations' };
const UPLOAD = 'Upload Finance and Operations Module ContosoExt_1_0_0_1_managed.zip';

/** A powershell.exe that reads the program and request from stdin and reports a deployment that went through. */
function fakeChild(lines: object[], exitCode = 0) {
  const child: any = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = {
    on: vi.fn(),
    end: (json: string) => {
      const input = JSON.parse(json);
      expect(input.script).toContain('param($request)');
      m.requests.push(input.request);
      setImmediate(() => {
        child.stdout.emit('data', `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
        child.emit('close', exitCode);
      });
    },
  };
  return child;
}

describe('deployModelToUde', () => {
  let root: string;
  let packages: string;
  const saved = { pf: process.env.ProgramFiles, pf86: process.env['ProgramFiles(x86)'] };

  beforeEach(() => {
    m.events.length = 0; m.requests.length = 0; m.lockHeld = false;
    m.spawn.mockReset(); m.token.mockReset();
    root = mkdtempSync(path.join(os.tmpdir(), 'ude-deploy-run-'));
    // A Visual Studio with Power Platform Tools, where visualStudioInstallations looks for one.
    const ext = path.join(root, 'pf', 'Microsoft Visual Studio', '2022', 'Enterprise', 'Common7', 'IDE', 'Extensions', 'abc');
    mkdirSync(ext, { recursive: true });
    writeFileSync(path.join(ext, 'Microsoft.PowerPlatform.VSShared.Util.dll'), '');
    process.env.ProgramFiles = path.join(root, 'pf');
    process.env['ProgramFiles(x86)'] = path.join(root, 'pf86'); // no vswhere there
    packages = path.join(root, 'packages');
    mkdirSync(path.join(packages, 'ContosoExt', 'Descriptor'), { recursive: true });
    writeFileSync(path.join(packages, 'ContosoExt', 'Descriptor', 'ContosoExt.xml'), '<AxModelInfo/>');
    m.token.mockImplementation(async (_settings: unknown, _open: unknown, options?: { forceRefresh?: boolean }) => {
      m.events.push(options?.forceRefresh ? `token(force, lock ${m.lockHeld ? 'held' : 'free'})` : `sign-in(lock ${m.lockHeld ? 'held' : 'free'})`);
      return 'token-value';
    });
    m.spawn.mockImplementation(() => {
      m.events.push('spawn');
      return fakeChild([
        { type: 'module', message: 'ContosoExt' },
        { type: 'status', message: `${UPLOAD} - Succeeded` },
        { type: 'done', message: '' },
      ]);
    });
  });

  afterEach(() => {
    process.env.ProgramFiles = saved.pf;
    process.env['ProgramFiles(x86)'] = saved.pf86;
    rmSync(root, { recursive: true, force: true });
  });

  const deploy = () => deployModelToUde({
    modelName: 'ContosoExt', customPackagesPath: packages, microsoftPackagesPath: path.join(root, 'microsoft'),
    dataverse: DATAVERSE, fullSync: false, logFile: path.join(root, 'deploy.log'), tempDir: root,
  });

  it('signs in before the lock, and fetches the token for the child inside it', async () => {
    const result = await deploy();
    expect(result.failed).toBe(false);
    expect(m.events).toEqual(['sign-in(lock free)', 'lock', 'token(force, lock held)', 'spawn', 'unlock']);
    // The token goes to the child on stdin, with only the junction to the one package.
    expect(m.requests[0]).toMatchObject({ token: 'token-value', orgUrl: DATAVERSE.url, packageType: 'Dev', syncKind: 'None' });
    expect(m.spawn.mock.calls[0][1].join(' ')).not.toContain('token-value');
    expect(result.section).not.toContain('token-value');
  });

  it('takes no lock when the sign-in fails', async () => {
    m.token.mockRejectedValueOnce(new Error('cancelled'));
    const result = await deploy();
    expect(result).toMatchObject({ failed: true, section: expect.stringContaining('Signing in to https://contoso-dev.crm.dynamics.com failed: cancelled') });
    expect(m.events).toEqual([]);
    expect(m.spawn).not.toHaveBeenCalled();
  });

  it('releases the lock and starts nothing when the token refresh fails', async () => {
    m.token.mockImplementation(async (_s: unknown, _o: unknown, options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh) throw new Error('refresh token expired');
      return 'token-value';
    });
    const result = await deploy();
    expect(result).toMatchObject({ failed: true, section: expect.stringContaining('refresh token expired') });
    expect(m.events).toEqual(['lock', 'unlock']);
    expect(m.spawn).not.toHaveBeenCalled();
  });

  it.each(['..\\ContosoExt', '../ContosoExt', 'C:ContosoExt', '..', '.'])(
    'refuses a model name that is not a plain name (%s), before anything else', async name => {
      const result = await deployModelToUde({
        modelName: name, customPackagesPath: packages, microsoftPackagesPath: path.join(root, 'microsoft'),
        dataverse: DATAVERSE, fullSync: false, logFile: path.join(root, 'deploy.log'), tempDir: root,
      });
      expect(result).toMatchObject({ failed: true, section: expect.stringContaining('is not a model name') });
      expect(m.token).not.toHaveBeenCalled();
      expect(m.events).toEqual([]);
      expect(m.spawn).not.toHaveBeenCalled();
    });

  it('removes the junction and its folder, leaving the package', async () => {
    await deploy();
    const staging = m.requests[0].modulesDir as string;
    expect(path.dirname(staging)).toBe(root); // the given temp folder, not the system one
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(path.join(packages, 'ContosoExt', 'Descriptor', 'ContosoExt.xml'))).toBe(true);
  });
});
