import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import realFs from 'fs';
import os from 'os';
import nodePath from 'path';
import { execFileSync } from 'child_process';

// --- mocks: same shape as runBpCheck.test.ts, git calls are served by the real git below ---
const { accessMock, xppbpOutput } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  xppbpOutput: { current: '' },
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const fake: any = (file: string, args: string[], opts: any, cb: Function) => {
    if (file === 'git') return actual.execFile(file, args, opts, cb as any);
    cb(null, { stdout: xppbpOutput.current, stderr: '' });
  };
  // promisify must see a callback-style fn that resolves { stdout, stderr }
  fake[Symbol.for('nodejs.util.promisify.custom')] = (file: string, args: string[], opts: any) =>
    new Promise((resolve, reject) => {
      if (file === 'git') {
        actual.execFile(file, args, opts, (e: any, stdout: any, stderr: any) =>
          e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr }));
      } else {
        resolve({ stdout: xppbpOutput.current, stderr: '' });
      }
    });
  return { ...actual, execFile: fake, default: { ...actual, execFile: fake } };
});
vi.mock('fs/promises', () => { const m = { access: accessMock }; return { ...m, default: m }; });

const workspace: { dir: string } = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => undefined,
    getModelName: () => 'ContosoExt',
    getProjectPath: async () => null,
    getPackagePath: () => null,
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
    getActiveXppConfig: async () => null,
    getWorkspacePath: () => workspace.dir,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));
vi.mock('../../src/utils/packagesRoot.js', () => ({
  packagesRoots: () => ['C:\\Pkg'],
  findPackagesRoot: () => 'C:\\Pkg',
  defaultPackagesRoot: () => 'C:\\Pkg',
  describePackagesRootScan: () => '',
}));

import { runBpCheckTool } from '../../src/tools/sdlc/runBpCheck';
import {
  splitChangedSince, objectsFromChangedFiles, changedFilesSince, isSafeRef,
} from '../../src/tools/sdlc/bpChangedSince';

const finding = (rule: string, obj: string) =>
  `${rule}: K:\\Pkg\\ContosoExt\\ContosoExt\\AxClass\\${obj}.xml`;
const text = (r: any) => r.content[0].text as string;

describe('run_bp_check — findings baseline', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), 'bpb-'));
    accessMock.mockResolvedValue(undefined);
  });
  afterEach(() => realFs.rmSync(dataDir, { recursive: true, force: true }));

  const run = (params: any = {}) =>
    runBpCheckTool({ modelName: 'ContosoExt', ...params }, { symbolIndex: { dataDir } });

  it('first run lists everything and records it; the next lists only what is new', async () => {
    xppbpOutput.current = [finding('BPErrorXmlDocMissing', 'ContosoA'), finding('BPErrorLabelIsText', 'ContosoB')].join('\n');
    const first = text(await run());
    expect(first).toContain('ContosoA');
    expect(first).not.toContain('BP findings:');

    xppbpOutput.current = [finding('BPErrorXmlDocMissing', 'ContosoA'), finding('BPErrorLabelIsText', 'ContosoB'),
      finding('BPErrorLocalVariableNotUsed', 'ContosoC')].join('\n');
    const second = text(await run());
    expect(second).toContain('1 new, 2 known');
    expect(second).toContain('ContosoC');
    expect(second).not.toContain('ContosoA');
    expect(second).toContain('completed with issues');
  });

  it('says there is nothing new when the findings are all known', async () => {
    xppbpOutput.current = finding('BPErrorXmlDocMissing', 'ContosoA');
    await run();
    const again = text(await run());
    expect(again).toContain('0 new, 1 known');
    expect(again).not.toContain('completed with issues');
  });

  it('a whole-model run replaces the baseline, a scoped run only adds to it', async () => {
    xppbpOutput.current = finding('BPErrorXmlDocMissing', 'ContosoA');
    await run();
    xppbpOutput.current = '';
    await run();                                  // whole model, now clean: baseline emptied
    xppbpOutput.current = finding('BPErrorXmlDocMissing', 'ContosoA');
    expect(text(await run())).toContain('1 new, 0 known');
  });
});

describe('run_bp_check — git:<ref>', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();
  let repo: string;
  beforeEach(() => {
    repo = realFs.mkdtempSync(nodePath.join(os.tmpdir(), 'bpg-'));
    workspace.dir = repo;
    accessMock.mockResolvedValue(undefined);
    const cls = nodePath.join(repo, 'ContosoExt', 'AxClass');
    realFs.mkdirSync(cls, { recursive: true });
    realFs.writeFileSync(nodePath.join(cls, 'ContosoOld.xml'), '<a/>');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
  });
  afterEach(() => realFs.rmSync(repo, { recursive: true, force: true }));

  it('checks only the objects that differ from the ref, including untracked ones', async () => {
    realFs.writeFileSync(nodePath.join(repo, 'ContosoExt', 'AxClass', 'ContosoNew.xml'), '<a/>');
    xppbpOutput.current = 'clean';
    const r = await runBpCheckTool({ modelName: 'ContosoExt', objects: ['git:main'] }, {});
    expect(text(r)).toContain('Changed since main: 1 object(s) checked');
    expect(text(r)).toContain('class:ContosoNew');
    expect(text(r)).not.toContain('ContosoOld');
  });

  it('answers without running xppbp when nothing changed', async () => {
    const r = await runBpCheckTool({ modelName: 'ContosoExt', objects: ['git:main'] }, {});
    expect(text(r)).toContain('Nothing to check');
  });

  it('reports a bad ref as an error', async () => {
    const r: any = await runBpCheckTool({ modelName: 'ContosoExt', objects: ['git:no-such-ref'] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('no-such-ref');
  });
});

describe('bpChangedSince helpers', () => {
  it('splits the magic entry from named objects', () => {
    const { ref, rest } = splitChangedSince({ objects: ['git:origin/main', { objectName: 'ContosoX', objectType: 'class' }] });
    expect(ref).toBe('origin/main');
    expect(rest.objects).toEqual([{ objectName: 'ContosoX', objectType: 'class' }]);
    expect(splitChangedSince({ objects: ['ContosoX'] }).ref).toBeUndefined();
    expect(splitChangedSince({ objects: 'git:HEAD~1' }).rest.objects).toBeUndefined();
  });

  it('maps changed files of the model to element types, skipping other models and unchecked kinds', () => {
    const { objects, skipped } = objectsFromChangedFiles([
      'r/ContosoExt/AxClass/ContosoA.xml',
      'r/ContosoExt/AxTableExtension/ContosoT.Ext.xml',
      'r/ContosoExt/AxClass/ContosoA.xml',
      'r/ContosoExt/AxSecurityRole/ContosoR.xml',
      'r/ContosoCore/AxClass/ContosoB.xml',
      'r/ContosoExt/Descriptor/ContosoExt.xml',
    ], 'ContosoExt');
    expect(objects).toEqual([
      { name: 'ContosoA', elementType: 'class' },
      { name: 'ContosoT.Ext', elementType: 'tableextension' },
    ]);
    expect(skipped).toBe(1);
  });

  it('refuses option-like refs', async () => {
    expect(isSafeRef('--output=x')).toBe(false);
    expect(isSafeRef('origin/main')).toBe(true);
    expect('error' in await changedFilesSince('--output=x', [os.tmpdir()])).toBe(true);
  });
});
