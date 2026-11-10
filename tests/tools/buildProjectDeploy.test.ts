import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

// build_d365fo_project(deploy): the wiring only — udeDeploy.ts itself is covered by udeDeploy.test.ts.
const m = vi.hoisted(() => ({
  files: new Map<string, string>(), children: [] as any[],
  spawn: vi.fn(), metadata: vi.fn(), sync: vi.fn(), scan: vi.fn(),
  check: vi.fn(), signIn: vi.fn(), deploy: vi.fn(), paths: vi.fn(),
  // The model's source tree as hasSourceChangesSince sees it: entries per folder, file mtimes.
  tree: new Map<string, Array<{ name: string; isDirectory: () => boolean }>>(), mtimes: new Map<string, number>(), unreadable: new Set<string>(),
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => { if (m.files.has(p)) return m.files.get(p); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
  writeFile: vi.fn(async (p: string, text: string) => { m.files.set(p, text); }),
  unlink: vi.fn(async (p: string) => { m.files.delete(p); }),
  appendFile: vi.fn(async (p: string, text: string) => { m.files.set(p, (m.files.get(p) ?? '') + text); }),
  access: vi.fn(async (p: string) => { if (p.endsWith('xppc.exe') || p === 'C:\\Packages') return; throw new Error('missing'); }),
  readdir: vi.fn(async (p: string) => { if (m.unreadable.has(p)) throw new Error('EACCES'); return m.tree.get(p) ?? []; }),
  stat: vi.fn(async (p: string) => ({ mtimeMs: m.mtimes.get(p) ?? 0 })), rm: vi.fn(),
}));
vi.mock('fs', () => ({ openSync: vi.fn(() => 3), closeSync: vi.fn() }));
vi.mock('child_process', () => ({ spawn: m.spawn, execFile: vi.fn((_f, _a, _o, cb) => cb(null, { stdout: '', stderr: '' })) }));
vi.mock('../../src/utils/configManager.js', () => ({ getConfigManager: () => ({
  ensureLoaded: vi.fn(), getActiveXppConfig: async () => null,
  getCustomPackagesPath: async () => 'C:\\Packages', getMicrosoftPackagesPath: async () => 'C:\\Packages',
  getModelName: () => 'ContosoExt', getContext: () => ({}), getDevEnvironmentType: async () => 'ude',
}) }));
vi.mock('../../src/utils/operationLocks.js', () => ({ forceReleaseLock: vi.fn(), withOperationLock: async (_key: string, fn: any) => fn() }));
vi.mock('../../src/tools/write/compileLabels.js', () => ({ compileModelLabels: async () => ({ success: true, skipped: true, message: 'No labels' }) }));
vi.mock('../../src/tools/sdlc/compilerMetadataPrune.js', () => ({ pruneStaleCompilerMetadata: async () => ({ removed: [], preserved: [] }) }));
vi.mock('../../src/tools/xml/generateMetadata.js', () => ({ generateRuntimeMetadata: m.metadata }));
vi.mock('../../src/tools/sdlc/dbSync.js', () => ({ dbSyncTool: m.sync }));
vi.mock('../../src/tools/sdlc/odataActionGuard.js', async () => ({
  ...(await vi.importActual<any>('../../src/tools/sdlc/odataActionGuard.js')), scanODataActions: m.scan,
}));
vi.mock('../../src/tools/sdlc/udeDeploy.js', () => ({
  checkDeployPrerequisites: m.check, signInForDeploy: m.signIn, deployModelToUde: m.deploy, udePackagePaths: m.paths,
}));
import { buildProjectTool } from '../../src/tools/sdlc/buildProject.js';

const DATAVERSE = { url: 'https://contoso-dev.crm.dynamics.com', clientId: 'c', tenant: 'organizations' };
/** Ends the latest xppc run of `model`: its log says `log`, its process exits with `code`. */
async function finish(log = 'Errors: 0', code = 0, model = 'ContosoExt') {
  const state = [...m.files.entries()]
    .filter(([p]) => p.includes('d365build_state'))
    .map(([, text]) => JSON.parse(text))
    .find(s => s.targetModel === model);
  m.files.set(state.logFile.replace('.log', '.xppc.err'), log);
  // The children are in spawn order; each spawn names its model in -modelmodule=.
  const models = m.spawn.mock.calls.map(c => (c[1] as string[] ?? []).find(a => a.startsWith('-modelmodule='))?.slice(13));
  await m.children[models.lastIndexOf(model)].handlers.close(code);
}
const collect = (extra: object = {}) => buildProjectTool({ modelName: 'ContosoExt', wait: false, ...extra }, {});

describe('build_d365fo_project deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks(); m.files.clear(); m.children.length = 0; m.tree.clear(); m.mtimes.clear(); m.unreadable.clear();
    m.spawn.mockImplementation(() => { const child = { pid: 4200 + m.children.length, unref: vi.fn(), handlers: {} as any, on(event: string, fn: any) { this.handlers[event] = fn; } }; m.children.push(child); return child; });
    m.metadata.mockResolvedValue({ success: true, skipped: false, message: 'Generated' });
    m.sync.mockResolvedValue({ content: [{ type: 'text', text: 'Sync succeeded' }] });
    m.scan.mockResolvedValue({ recompiled: [], missing: [], runtimeFile: null, errors: [] });
    m.check.mockResolvedValue({ ok: true, dataverse: DATAVERSE });
    m.signIn.mockResolvedValue(undefined);
    m.paths.mockResolvedValue({ customPackagesPath: 'C:\\Packages', microsoftPackagesPath: 'C:\\Microsoft' });
    m.deploy.mockResolvedValue({ section: '\n\n--- Deployment (deploy) ---\n✅ Deployed ContosoExt', failed: false });
  });

  it('refuses before compiling when the deployment cannot happen', async () => {
    m.check.mockResolvedValue({ ok: false, message: 'deploy is for UDE environments. Nothing was built.' });
    const result = await buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('deploy is for UDE environments');
    expect(m.spawn).not.toHaveBeenCalled();
  });

  it('refuses before compiling when the sign-in fails', async () => {
    m.signIn.mockResolvedValue('Signing in to https://contoso-dev.crm.dynamics.com failed: cancelled. Nothing was built.');
    const result = await buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    expect(result).toMatchObject({ isError: true });
    expect(m.spawn).not.toHaveBeenCalled();
  });

  it('deploys after a successful build, without a sync by default', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', deploy: true, wait: false }, {});
    await finish();
    const result = await collect();
    expect(m.deploy).toHaveBeenCalledTimes(1);
    expect(m.deploy.mock.calls[0][0]).toMatchObject({
      modelName: 'ContosoExt', customPackagesPath: 'C:\\Packages', microsoftPackagesPath: 'C:\\Microsoft',
      dataverse: DATAVERSE, fullSync: false,
    });
    expect(m.deploy.mock.calls[0][0].logFile).toMatch(/\.deploy\.log$/);
    expect(result.content[0].text).toContain('✅ Deployed ContosoExt');
    expect(result.isError).toBeUndefined();
  });

  it('keeps the progress value increasing when the deployment counts from its own start', async () => {
    // The build counts seconds since it began; the deployment, from when it began.
    // Here the deployment reports 0, a value the build's wait has already sent.
    m.deploy.mockImplementation(async (options: any) => {
      await options.onProgress('🚀 Deploying ContosoExt — Staging, 0s', 0);
      return { section: '\n\n--- Deployment (deploy) ---\n✅ Deployed ContosoExt', failed: false };
    });
    const sent: Array<[string, number]> = [];
    const onProgress = vi.fn(async (message: string, progress: number) => { sent.push([message, progress]); });
    const build = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {}, onProgress);
    for (let i = 0; i < 100 && m.children.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 1_200)); // the wait has reported at least once
    await finish();
    await build;
    const values = sent.map(([, v]) => v);
    expect(sent.some(([message]) => message.startsWith('🔨 Building'))).toBe(true);
    expect(sent.at(-1)![0]).toContain('🚀 Deploying');
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
  }, 20_000);

  it('on UDE, dbSync becomes the deployment\'s full sync instead of a local SyncEngine run', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', deploy: true, dbSync: ['ContosoTable'], wait: false }, {});
    await finish();
    const text = (await collect()).content[0].text;
    expect(m.sync).not.toHaveBeenCalled();
    expect(m.deploy.mock.calls[0][0].fullSync).toBe(true);
    expect(text).toContain('table list was not used');
  });

  it('is an error when the deployment failed, though the build did not', async () => {
    m.deploy.mockResolvedValue({ section: '\n\n--- Deployment (deploy) — FAILED, the build did not ---\n❌ Upload Error', failed: true });
    await buildProjectTool({ modelName: 'ContosoExt', deploy: true, wait: false }, {});
    await finish();
    const result = await collect();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('✅ Build succeeded');
  });

  it('does not deploy a failed build', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', deploy: true, wait: false }, {});
    await finish('Compile Error: Class Method dynamics://ContosoExt/ContosoClass/run: [(1,1)]: bad', 1);
    await collect();
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it('keeps a plain build without deploy exactly as it was', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', dbSync: true, wait: false }, {});
    await finish();
    await collect();
    expect(m.deploy).not.toHaveBeenCalled();
    expect(m.check).not.toHaveBeenCalled();
    expect(m.sync).toHaveBeenCalledTimes(1);
  });
});

// A call that attaches to a build another call started (same model, build still running).
describe('build_d365fo_project attached to a running build', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await sleep(50);
    expect(cond()).toBe(true);
  };
  const MODEL_DIR = path.join('C:\\Packages', 'ContosoExt');
  /** A source file of the model, changed `msAfter` ms after now. */
  function changeSource(msAfter: number) {
    const classes = path.join(MODEL_DIR, 'ContosoExt', 'AxClass');
    m.tree.set(MODEL_DIR, [{ name: 'ContosoExt', isDirectory: () => true }]);
    m.tree.set(path.join(MODEL_DIR, 'ContosoExt'), [{ name: 'AxClass', isDirectory: () => true }]);
    m.tree.set(classes, [{ name: 'ContosoClass.xml', isDirectory: () => false }]);
    m.mtimes.set(path.join(classes, 'ContosoClass.xml'), Date.now() + msAfter);
  }

  beforeEach(() => {
    vi.clearAllMocks(); m.files.clear(); m.children.length = 0; m.tree.clear(); m.mtimes.clear(); m.unreadable.clear();
    m.spawn.mockImplementation(() => { const child = { pid: process.pid, // alive: a running build is attached to, not reaped
      unref: vi.fn(), handlers: {} as any, on(event: string, fn: any) { this.handlers[event] = fn; } }; m.children.push(child); return child; });
    m.metadata.mockResolvedValue({ success: true, skipped: false, message: 'Generated' });
    m.sync.mockResolvedValue({ content: [{ type: 'text', text: 'Sync succeeded' }] });
    m.scan.mockResolvedValue({ recompiled: [], missing: [], runtimeFile: null, errors: [] });
    m.check.mockResolvedValue({ ok: true, dataverse: DATAVERSE });
    m.signIn.mockResolvedValue(undefined);
    m.paths.mockResolvedValue({ customPackagesPath: 'C:\\Packages', microsoftPackagesPath: 'C:\\Microsoft' });
    m.deploy.mockResolvedValue({ section: '\n\n--- Deployment (deploy) ---\n✅ Deployed ContosoExt', failed: false });
  });

  it('deploys for a call that attached with deploy to a plain build, whichever call renders it', async () => {
    const plain = buildProjectTool({ modelName: 'ContosoExt' }, {});
    await until(() => m.children.length === 1);
    const deploying = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    await sleep(1_200); // both have seen the running build
    await finish();
    const [, withDeploy] = await Promise.all([plain, deploying]);
    expect(m.spawn).toHaveBeenCalledTimes(1);
    expect(m.deploy).toHaveBeenCalledTimes(1);
    expect(withDeploy.content[0].text).toContain('✅ Deployed ContosoExt');
  }, 20_000);

  it('does not deploy twice when both calls asked for it', async () => {
    const first = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    await until(() => m.children.length === 1);
    const second = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    await sleep(1_200);
    await finish();
    await Promise.all([first, second]);
    expect(m.deploy).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('deploys once for two calls that attached with deploy to a plain build', async () => {
    // A client that timed out and retried: two waiters asking for the step the render skips.
    let release!: () => void;
    m.deploy.mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ section: '\n\n--- Deployment (deploy) ---\n✅ Deployed ContosoExt', failed: false });
    }));
    const plain = buildProjectTool({ modelName: 'ContosoExt' }, {});
    await until(() => m.children.length === 1);
    await sleep(1_100); // the plain call reads the state first, so it is the one that renders
    const b = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    // One after the other: two calls importing the mocked udeDeploy at the same instant were seen
    // to give the second the real module (a test-runner effect; Node shares one module).
    await until(() => m.signIn.mock.calls.length === 1);
    const c = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    await sleep(1_200);
    await finish();
    await until(() => m.deploy.mock.calls.length > 0);
    await sleep(300); // c has had its chance to start a second one
    expect(m.deploy).toHaveBeenCalledTimes(1);
    release();
    const [rp, rb, rc] = await Promise.all([plain, b, c]);
    for (const r of [rb, rc]) expect(r.content[0].text).toContain('✅ Deployed ContosoExt');
    expect(m.deploy).toHaveBeenCalledTimes(1);
    // What this test is about: the plain call rendered, and one waiting call joined the other's
    // deployment. Should the order change, fail here rather than cover something else.
    expect(rp.content[0].text).not.toContain('Deployed');
    expect([rb, rc].filter(r => r.content[0].text.includes('run by another call waiting on this build'))).toHaveLength(1);
  }, 20_000);

  it('does not hold up other builds while a deploy waits for the sign-in', async () => {
    let signedIn!: () => void;
    m.signIn.mockImplementation(() => new Promise<undefined>(resolve => { signedIn = () => resolve(undefined); }));
    const deploying = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    await until(() => m.signIn.mock.calls.length === 1);
    // Another model's build starts while the browser sign-in is still open.
    await buildProjectTool({ modelName: 'ContosoOther', wait: false }, {});
    expect(m.spawn).toHaveBeenCalledTimes(1);
    signedIn();
    await until(() => m.children.length === 2);
    await finish();
    expect((await deploying).content[0].text).toContain('✅ Deployed ContosoExt');
  }, 20_000);

  it('does not compile again while a call waiting on the earlier build still deploys it', async () => {
    let release!: () => void;
    m.deploy.mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ section: '\n\n--- Deployment (deploy) ---\n✅ Deployed ContosoExt', failed: false });
    }));
    const plain = buildProjectTool({ modelName: 'ContosoExt' }, {});
    await until(() => m.children.length === 1);
    await sleep(1_100); // the plain call reads the state first, so it renders (quickly: no steps)
    const deploying = buildProjectTool({ modelName: 'ContosoExt', deploy: true }, {});
    await sleep(1_200); // attached, before the edit
    changeSource(1_000);
    const later = buildProjectTool({ modelName: 'ContosoExt' }, {});
    await sleep(1_200); // found the running build stale and waits for it
    await finish();
    await until(() => m.deploy.mock.calls.length === 1);
    await sleep(1_500); // long enough for the compile-again call to start xppc, were it not waiting
    expect(m.spawn).toHaveBeenCalledTimes(1);
    release();
    await until(() => m.children.length === 2);
    await finish();
    const [, , result] = await Promise.all([plain, deploying, later]);
    expect(result.content[0].text).toContain('requested a build of the current sources');
  }, 30_000);

  it('attaches, and says so, when it cannot tell whether sources changed', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', wait: false }, {});
    m.unreadable.add(MODEL_DIR); // the scan cannot finish: 'unknown', not 'changed'
    const later = buildProjectTool({ modelName: 'ContosoExt' }, {});
    await sleep(1_200);
    await finish();
    const result = await later;
    expect(m.spawn).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('could not be checked in time');
    expect(result.content[0].text).toContain('✅ Build succeeded');
  }, 20_000);

  it('compiles again when sources changed after the running build started', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', wait: false }, {});
    changeSource(1_000);
    const later = buildProjectTool({ modelName: 'ContosoExt' }, {});
    await sleep(1_200); // it found the running build stale and waits for it
    expect(m.spawn).toHaveBeenCalledTimes(1);
    await finish();
    await until(() => m.children.length === 2); // the earlier build was left to finish first
    await finish();
    const result = await later;
    expect(result.content[0].text).toContain('requested a build of the current sources');
    expect(result.content[0].text).toContain('✅ Build succeeded');
  }, 30_000);

  it('says a deploy is not confirmed when another process collected the build', async () => {
    await buildProjectTool({ modelName: 'ContosoExt', wait: false }, {});
    // A short wait window: should the waiter miss the state, the test fails fast instead of
    // hanging on the default 30 minutes.
    const deploying = buildProjectTool({ modelName: 'ContosoExt', deploy: true, waitTimeoutMs: 8_000 }, {});
    await sleep(1_200);
    // Collected elsewhere: the state is gone, and no result is shared in this process.
    for (const key of [...m.files.keys()].filter(k => k.includes('d365build_state'))) m.files.delete(key);
    const result = await deploying;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not confirmed: deploy');
    expect(m.deploy).not.toHaveBeenCalled();
  }, 20_000);
});
