import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
const m = vi.hoisted(() => ({
  files: new Map<string, string>(), children: [] as any[],
  spawn: vi.fn(), restart: vi.fn(), metadata: vi.fn(), sync: vi.fn(), bp: vi.fn(), lockTail: Promise.resolve(),
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => { if (m.files.has(p)) return m.files.get(p); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
  writeFile: vi.fn(async (p: string, text: string, opts: any) => { if (opts?.flag === 'wx' && m.files.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); m.files.set(p, text); }),
  unlink: vi.fn(async (p: string) => { m.files.delete(p); }),
  appendFile: vi.fn(async (p: string, text: string) => { m.files.set(p, (m.files.get(p) ?? '') + text); }),
  access: vi.fn(async (p: string) => { if (p.endsWith('xppc.exe') || p === 'C:\\Packages') return; throw new Error('missing'); }),
  readdir: vi.fn(async (p: string) => p === os.tmpdir() ? [...m.files.keys()].filter(key => key.includes('d365build_state')).map(key => path.basename(key)) : []), stat: vi.fn(async () => ({ mtimeMs: 0 })), rm: vi.fn(),
}));
vi.mock('fs', () => ({ openSync: vi.fn(() => 3), closeSync: vi.fn() }));
vi.mock('child_process', () => ({ spawn: m.spawn, execFile: vi.fn((_f, _a, _o, cb) => cb(null, { stdout: '', stderr: '' })) }));
vi.mock('../../src/utils/configManager.js', () => ({ getConfigManager: () => ({
  ensureLoaded: vi.fn(), getActiveXppConfig: async () => null,
  getCustomPackagesPath: async () => 'C:\\Packages', getMicrosoftPackagesPath: async () => 'C:\\Packages',
  getModelName: () => 'MyModel', getContext: () => ({}),
}) }));
vi.mock('../../src/utils/operationLocks.js', () => ({ forceReleaseLock: vi.fn(), withOperationLock: async (_key: string, fn: any) => {
  const previous = m.lockTail;
  let release!: () => void;
  m.lockTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
} }));
vi.mock('../../src/tools/write/compileLabels.js', () => ({ compileModelLabels: async () => ({ success: true, skipped: true, message: 'No labels' }) }));
vi.mock('../../src/tools/sdlc/compilerMetadataPrune.js', () => ({ pruneStaleCompilerMetadata: async () => ({ removed: [], preserved: [] }) }));
vi.mock('../../src/tools/xml/generateMetadata.js', () => ({ generateRuntimeMetadata: m.metadata }));
vi.mock('../../src/tools/sdlc/aosRuntime.js', () => ({ restartAosRuntime: m.restart }));
vi.mock('../../src/tools/sdlc/dbSync.js', () => ({ dbSyncTool: m.sync }));
vi.mock('../../src/tools/sdlc/runBpCheck.js', () => ({ runBpCheckTool: m.bp }));
import { buildProjectTool } from '../../src/tools/sdlc/buildProject.js';
const opts = { modelName: 'MyModel', restartAos: true, aosUrl: 'https://dev.example.test/', wait: false };
const webConfig = path.join('C:\\Packages', '..', 'WebRoot', 'web.config');
// Well above any real PID: process.kill(pid, 0) reports it gone.
const DEAD_PID = 2_000_000_000;
const reservationKey = path.join(os.tmpdir(), 'd365build_aos_restart.json');
const stateKey = (model: string) => path.join(os.tmpdir(),
  `d365build_state_${createHash('md5').update(`${model.toLowerCase()}|c:\\packages`).digest('hex').slice(0, 10)}.json`);
const state = () => JSON.parse([...m.files.entries()].find(([p]) => p.includes('d365build_state'))![1]);
async function finish(log = 'Errors: 0', code = 0) {
  m.files.set(state().logFile.replace('.log', '.xppc.err'), log);
  await m.children.at(-1).handlers.close(code);
}
describe('optional AOS restart build workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks(); m.files.clear(); m.children.length = 0;
    m.spawn.mockImplementation(() => { const child = { pid: 4200 + m.children.length, unref: vi.fn(), handlers: {} as any, on(event: string, fn: any) { this.handlers[event] = fn; } }; m.children.push(child); return child; });
    m.metadata.mockResolvedValue({ success: true, skipped: false, message: 'Generated' });
    m.sync.mockResolvedValue({ content: [{ type: 'text', text: 'Sync succeeded' }] });
    m.bp.mockResolvedValue({ content: [{ type: 'text', text: 'BP checked' }] });
    m.restart.mockResolvedValue({ status: 'ready', message: 'AOS ready' });
  });
  it('executes original sync/BP and restart before completion with wait:false; collection never replays', async () => {
    await buildProjectTool({ ...opts, dbSync: ['MyTable'], bpCheck: true, projectPath: 'C:\\Proj.rnrproj' }, {});
    await finish();
    expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({ tables: ['MyTable'], projectPath: 'C:\\Proj.rnrproj' }), {});
    expect(m.bp).toHaveBeenCalledTimes(1);
    expect(m.restart).toHaveBeenCalledWith(opts.aosUrl);
    expect(m.metadata.mock.invocationCallOrder[0]).toBeLessThan(m.sync.mock.invocationCallOrder[0]);
    expect(m.sync.mock.invocationCallOrder[0]).toBeLessThan(m.restart.mock.invocationCallOrder[0]);
    const collected = await buildProjectTool({ modelName: 'MyModel', wait: false, dbSync: ['WrongTable'] }, {});
    expect(collected.content[0].text).toContain('AOS ready');
    // A re-issued restart request collects the same result again: no second restart or sync.
    const reissued = await buildProjectTool({ ...opts, dbSync: ['WrongTable'] }, {});
    expect(reissued.content[0].text).toContain('AOS ready');
    expect(m.restart).toHaveBeenCalledTimes(1); expect(m.sync).toHaveBeenCalledTimes(1); expect(m.spawn).toHaveBeenCalledTimes(1);
  });
  it('treats a delivered restart result as consumed by a call without restartAos, like a plain build', async () => {
    await buildProjectTool(opts, {}); await finish();
    expect((await buildProjectTool({ modelName: 'MyModel', wait: false }, {})).content[0].text).toContain('AOS ready');
    const next = await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    expect(next.content[0].text).not.toContain('AOS ready');
    expect(m.spawn).toHaveBeenCalledTimes(2); expect(m.restart).toHaveBeenCalledTimes(1);
  });
  it('does not restart after failed compiler diagnostics', async () => {
    await buildProjectTool({ ...opts, fullBuild: true }, {}); await finish('Compile Error: bad source');
    expect(m.restart).not.toHaveBeenCalled(); expect(state().status).toBe('failed');
  });
  it.each(['Metadata Error: broken', 'Errors: 2'])('withholds the restart, but keeps the ordinary build verdict, when the log reports: %s', async log => {
    await buildProjectTool({ ...opts, fullBuild: true, dbSync: true }, {}); await finish(log);
    expect(m.restart).not.toHaveBeenCalled();
    // The requested sync still runs, as it would without restartAos.
    expect(m.sync).toHaveBeenCalledTimes(1);
    // The same log gives the same verdict with or without restartAos.
    expect(state().status).toBe('succeeded');
    expect(state().restartWorkflow.result.message).toContain('xppc log reports errors');
  });
  it.each([{ success: false, skipped: false }, { success: true, skipped: true }])('blocks restart when metadata is not generated: %j', async result => {
    m.metadata.mockResolvedValue({ ...result, message: 'No metadata' });
    await buildProjectTool({ ...opts, dbSync: true, bpCheck: true }, {}); await finish();
    expect(m.restart).not.toHaveBeenCalled();
    const response = await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    expect(response.isError).toBe(true); expect(response.content[0].text).toContain('AOS restart blocked');
    // A blocked restart does not take the requested sync and BP check with it.
    expect(m.sync).toHaveBeenCalledTimes(1); expect(m.bp).toHaveBeenCalledTimes(1);
    expect(response.content[0].text).toContain('Sync succeeded'); expect(response.content[0].text).toContain('BP checked');
  });
  it.each([{ dbSync: [] }, { dbSync: [' '] }])('empty sync selection blocks restart: %j', async ({ dbSync }) => {
    await buildProjectTool({ ...opts, dbSync }, {}); await finish();
    expect(m.restart).not.toHaveBeenCalled(); expect(m.sync).not.toHaveBeenCalled();
  });
  it('sync failure blocks restart and preserves its result', async () => {
    m.sync.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Sync failed' }] });
    await buildProjectTool({ ...opts, dbSync: true }, {}); await finish();
    expect(m.restart).not.toHaveBeenCalled();
    expect((await buildProjectTool({ modelName: 'MyModel' }, {})).content[0].text).toContain('Sync failed');
  });
  it.each(['blocked', 'failed', 'not-ready'])('retains warning without green heading when runtime status is %s', async status => {
    m.restart.mockResolvedValue({ status, message: 'Runtime needs attention' });
    await buildProjectTool(opts, {}); await finish();
    const response = await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    expect(response.isError).toBe(true); expect(response.content[0].text).toContain('Runtime needs attention');
    expect(response.content[0].text).not.toContain('✅ Build succeeded');
  });
  it('refuses a forced/new build while restart is in flight', async () => {
    let resolve!: (value: any) => void;
    m.restart.mockImplementation(() => new Promise(r => { resolve = r; }));
    await buildProjectTool(opts, {});
    const closing = finish(); await vi.waitFor(() => expect(m.restart).toHaveBeenCalled());
    for (const request of [{ ...opts, force: true }, { modelName: 'OtherModel', wait: false }]) {
      const result = await buildProjectTool(request, {});
      expect(result.isError).toBe(true); expect(result.content[0].text).toMatch(/restart.*(active|progress|uncertain)/i);
    }
    expect(m.spawn).toHaveBeenCalledTimes(1);
    resolve({ status: 'ready', message: 'AOS ready' }); await closing;
  });
  it('requires an environment root before starting an opted-in build when no web.config names one', async () => {
    // UDE, or a packages folder without an AosService\WebRoot beside it.
    const result = await buildProjectTool({ ...opts, aosUrl: undefined }, {});
    expect(result.isError).toBe(true); expect(m.spawn).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('aosUrl');
  });
  it('takes the environment root from the local AOS web.config when aosUrl is omitted', async () => {
    m.files.set(webConfig, '<add key="Infrastructure.HostUrl" value="https://usnconeboxax1aos.cloud.onebox.dynamics.com" />');
    m.restart.mockResolvedValue({ status: 'ready', host: 'iis-express AOSService/Dynamics365 PID 33604', replacementPid: 31520, message: 'AOS ready' });
    await buildProjectTool({ ...opts, aosUrl: undefined }, {}); await finish();
    expect(m.restart).toHaveBeenCalledWith('https://usnconeboxax1aos.cloud.onebox.dynamics.com/');
    // The caller cannot see the server's log: the result says what was restarted, and why that root.
    const text = (await buildProjectTool({ modelName: 'MyModel', wait: false }, {})).content[0].text;
    expect(text).toContain(`Environment root: https://usnconeboxax1aos.cloud.onebox.dynamics.com/ (from ${webConfig})`);
    expect(text).toContain('Host: iis-express AOSService/Dynamics365 PID 33604 -> PID 31520');
    expect(text).toContain('Status: ready');
  });
  it('lets an explicit aosUrl win over the web.config', async () => {
    m.files.set(webConfig, '<add key="Infrastructure.HostUrl" value="https://other.example.test/" />');
    await buildProjectTool(opts, {}); await finish();
    expect(m.restart).toHaveBeenCalledWith(opts.aosUrl);
  });
  it('runs the bpCheck and dbSync the build was started with, even when it is collected without them', async () => {
    // A build that outlives its wait window (wait:false, or past waitTimeoutMs) is
    // collected later, typically with the model name alone.
    await buildProjectTool({ modelName: 'MyModel', wait: false, bpCheck: true, dbSync: true }, {}); await finish();
    const response = await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    expect(m.bp).toHaveBeenCalledTimes(1); expect(m.sync).toHaveBeenCalledTimes(1);
    expect(response.content[0].text).toContain('BP checked');
    expect(response.content[0].text).toContain('Sync succeeded');
  });
  it('keeps the dbSync scope the build was started with', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false, dbSync: ['MyTable'] }, {}); await finish();
    await buildProjectTool({ modelName: 'MyModel', wait: false, dbSync: true }, {});
    expect(m.sync).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(m.sync.mock.calls[0][0])).toContain('MyTable');
  });
  it('still runs a bpCheck that only the collecting call asks for', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {}); await finish();
    const response = await buildProjectTool({ modelName: 'MyModel', wait: false, bpCheck: true }, {});
    expect(m.bp).toHaveBeenCalledTimes(1); expect(m.sync).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('BP checked');
  });
  it('keeps ordinary builds free of runtime actions', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {}); await finish();
    expect(m.restart).not.toHaveBeenCalled();
  });
  it('compiles only the target model, even when an older client asks for referenced models (#1122)', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false, buildReferencedModels: true }, {}); await finish();
    expect(m.spawn).toHaveBeenCalledTimes(1);
    expect(state().modelName).toBe('MyModel');
  });
  it('renders saved restart results without replaying prerequisites', async () => {
    await buildProjectTool({ ...opts, dbSync: true }, {}); await finish();
    const [key, raw] = [...m.files.entries()].find(([p]) => p.includes('d365build_state'))!;
    const saved = JSON.parse(raw);
    saved.restartWorkflow.result = { status: 'not-ready', message: 'AOS readiness unverified' };
    m.files.set(key, JSON.stringify(saved));
    const response = await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    expect(response.content[0].text).toContain('AOS readiness unverified');
    expect(response.content[0].text).toContain('Sync succeeded');
    expect(response.content[0].text).not.toContain('✅ Build succeeded');
    expect(response.isError).toBe(true); expect(m.sync).toHaveBeenCalledTimes(1); expect(m.restart).toHaveBeenCalledTimes(1);
  });
  it('refuses replay and forced builds after the server owning a workflow disappears', async () => {
    await buildProjectTool({ ...opts, dbSync: true }, {});
    const reservationKey = [...m.files.keys()].find(p => p.endsWith('d365build_aos_restart.json'))!;
    m.files.set(reservationKey, JSON.stringify({ ...JSON.parse(m.files.get(reservationKey)!), owner: 'previous-server-instance' }));
    for (const request of [{ modelName: 'MyModel', wait: false }, { ...opts, force: true }, { modelName: 'Other', wait: false }]) {
      const response = await buildProjectTool(request, {});
      expect(response.isError).toBe(true); expect(response.content[0].text).toContain('uncertain');
    }
    expect(m.spawn).toHaveBeenCalledTimes(1); expect(m.restart).not.toHaveBeenCalled(); expect(m.sync).not.toHaveBeenCalled();
  });
  it('never invokes restart if persisting restart intent fails', async () => {
    await buildProjectTool(opts, {});
    vi.mocked(writeFile).mockImplementationOnce(async () => {}) // finalizing state
      .mockImplementationOnce(async () => {}) // prerequisites intent
      .mockRejectedValueOnce(new Error('disk full')); // restart intent
    await finish();
    expect(m.restart).not.toHaveBeenCalled();
    const response = await buildProjectTool({ ...opts, force: true }, {});
    expect(response.isError).toBe(true); expect(m.spawn).toHaveBeenCalledTimes(1);
  });
  it('does not let a forced-out compiler callback overwrite or restart the new workflow', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    const oldChild = m.children[0];
    await buildProjectTool({ ...opts, force: true }, {});
    const newJobId = state().jobId;
    await oldChild.handlers.close(0);
    expect(state().jobId).toBe(newJobId); expect(state().status).toBe('running');
    expect(m.metadata).not.toHaveBeenCalled(); expect(m.restart).not.toHaveBeenCalled();
    await finish(); expect(m.restart).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect an ordinary build whose state was removed during recovery', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    const key = [...m.files.keys()].find(p => p.includes('d365build_state'))!;
    m.files.delete(key);
    await m.children[0].handlers.close(0);
    expect(m.files.has(key)).toBe(false); expect(m.metadata).not.toHaveBeenCalled();
  });
  it('does not allow a late metadata callback from a superseded job to overwrite the new workflow', async () => {
    let release!: (value: any) => void;
    m.metadata.mockImplementationOnce(() => new Promise(r => { release = r; }));
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    const oldClose = finish(); await vi.waitFor(() => expect(m.metadata).toHaveBeenCalledTimes(1));
    await buildProjectTool({ ...opts, force: true }, {});
    const newJobId = state().jobId;
    release({ success: true, skipped: false, message: 'old metadata' }); await oldClose;
    expect(state().jobId).toBe(newJobId); expect(state().status).toBe('running');
    expect(m.restart).not.toHaveBeenCalled();
    await finish(); expect(m.restart).toHaveBeenCalledTimes(1);
  });
  it('rejects restart while an earlier ordinary build of another model is running', async () => {
    await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
    // The mocked xppc PID is not a real process; make it a live one.
    m.files.set(stateKey('OtherModel'), JSON.stringify({ ...JSON.parse(m.files.get(stateKey('OtherModel'))!), pid: process.pid }));
    const response = await buildProjectTool(opts, {});
    expect(response.isError).toBe(true); expect(response.content[0].text).toContain('OtherModel');
    expect(m.spawn).toHaveBeenCalledTimes(1); expect(m.restart).not.toHaveBeenCalled();
  });
  it('does not let an abandoned or unreadable state of another model block a restart', async () => {
    m.files.set(stateKey('Crashed'), JSON.stringify({
      jobId: 'old', targetModel: 'Crashed', modelName: 'Crashed', status: 'running', pid: DEAD_PID, logFile: 'x.log', startTime: new Date().toISOString(),
    }));
    m.files.set(stateKey('Garbled'), '{"status":"runn');
    await buildProjectTool(opts, {});
    expect(m.spawn).toHaveBeenCalledTimes(1);
  });

  it('releases its reservation and state when xppc could not be started', async () => {
    m.spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    const failed = await buildProjectTool(opts, {});
    expect(failed.isError).toBe(true);
    expect(m.files.has(reservationKey)).toBe(false); expect(m.files.has(stateKey('MyModel'))).toBe(false);
    await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
    expect(m.spawn).toHaveBeenCalledTimes(2);
  });

  describe('a reservation whose server died', () => {
    /** The state and reservation a server leaves behind when it dies mid-workflow. */
    function abandon(stage: string, xppcPid = DEAD_PID, reservationExtra: object = { ownerPid: DEAD_PID }) {
      m.files.set(stateKey('MyModel'), JSON.stringify({
        jobId: 'job-1', ownerPid: DEAD_PID, targetModel: 'MyModel', modelName: 'MyModel', status: 'running', phase: 'finalizing',
        pid: xppcPid, logFile: 'x.log', startTime: new Date().toISOString(),
        restartWorkflow: { request: { aosUrl: opts.aosUrl }, stage },
      }));
      m.files.set(reservationKey, JSON.stringify({ jobId: 'job-1', targetModel: 'MyModel', customPackagesPath: 'C:\\Packages', owner: 'dead-server', ...reservationExtra }));
    }

    it.each(['pending', 'prerequisites'])('is released when it died in the %s stage, so builds go on', async stage => {
      abandon(stage);
      const response = await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
      expect(response.isError).toBeFalsy();
      expect(response.content[0].text).toContain(`Released the AOS restart reservation of MyModel`);
      expect(response.content[0].text).toContain(`'${stage}' stage`);
      expect(m.files.has(reservationKey)).toBe(false); expect(m.files.has(stateKey('MyModel'))).toBe(false);
      expect(m.spawn).toHaveBeenCalledTimes(1);
    });

    it('stays when it died while restarting: the outcome is unknown', async () => {
      abandon('restarting');
      const response = await buildProjectTool({ ...opts, force: true }, {});
      expect(response.isError).toBe(true); expect(response.content[0].text).toContain('exited during the restart');
      expect(m.files.has(reservationKey)).toBe(true);
      expect(JSON.parse(m.files.get(stateKey('MyModel'))!).restartWorkflow.stage).toBe('uncertain');
      expect(m.spawn).not.toHaveBeenCalled();
    });

    it('stays while its xppc is still compiling', async () => {
      abandon('pending', process.pid);
      const response = await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
      expect(response.isError).toBe(true); expect(m.files.has(reservationKey)).toBe(true); expect(m.spawn).not.toHaveBeenCalled();
    });

    it('stays when its owner is alive but not ours to signal (EPERM)', async () => {
      abandon('pending');
      const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
        if (pid === DEAD_PID) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return true;
      }) as any);
      try {
        const response = await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
        expect(response.isError).toBe(true); expect(m.files.has(reservationKey)).toBe(true);
        expect(m.files.has(stateKey('MyModel'))).toBe(true); expect(m.spawn).not.toHaveBeenCalled();
      } finally { kill.mockRestore(); }
    });

    it('stays when it predates ownerPid', async () => {
      abandon('pending', DEAD_PID, {});
      const response = await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
      expect(response.isError).toBe(true); expect(m.files.has(reservationKey)).toBe(true); expect(m.spawn).not.toHaveBeenCalled();
    });

    it('does not recurse on a dead finalizing restart state that has no reservation', async () => {
      abandon('prerequisites');
      m.files.delete(reservationKey);
      const response = await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
      expect(response.isError).toBe(true); expect(response.content[0].text).toContain('exited unexpectedly');
      // Kept: only its stage can tell a later recovery whether the AOS may have been restarted.
      expect(m.files.has(stateKey('MyModel'))).toBe(true);
    });
  });

  it('keeps a failed runtime mutation reserved even for force:true', async () => {
    m.restart.mockResolvedValue({ status: 'failed', message: 'Mutation outcome unknown' });
    await buildProjectTool(opts, {}); await finish();
    const response = await buildProjectTool({ ...opts, force: true }, {});
    expect(response.isError).toBe(true); expect(response.content[0].text).toContain('Mutation outcome unknown');
    expect(m.spawn).toHaveBeenCalledTimes(1); expect(m.restart).toHaveBeenCalledTimes(1);
  });
  it('says the AOS is restarting, not compiling, while the restart is in flight', async () => {
    let resolve!: (value: any) => void;
    m.restart.mockImplementation(() => new Promise(r => { resolve = r; }));
    await buildProjectTool(opts, {});
    const closing = finish(); await vi.waitFor(() => expect(m.restart).toHaveBeenCalled());
    // wait:false snapshot
    const snapshot = await buildProjectTool({ ...opts }, {});
    expect(snapshot.content[0].text).toContain('restarting the AOS and waiting until it answers');
    // wait:true that runs out of its window, with progress along the way
    const progress: string[] = [];
    const timedOut = await buildProjectTool({ ...opts, wait: true, waitTimeoutMs: 1 }, {}, async (message: string) => { progress.push(message); });
    expect(timedOut.content[0].text).toContain('compiled and is now restarting the AOS');
    expect(timedOut.content[0].text).toContain('does not restart the AOS again');
    expect(timedOut.content[0].text).not.toContain('keeps compiling');
    expect(progress.join('\n')).toContain('restarting the AOS');
    expect(m.restart).toHaveBeenCalledTimes(1);
    resolve({ status: 'ready', message: 'AOS ready' }); await closing;
  });
  it('wait:true completes the captured restart before returning', async () => {
    const responsePromise = buildProjectTool({ ...opts, wait: true }, {});
    await vi.waitFor(() => expect(m.children.at(-1)?.handlers.close).toBeDefined());
    await finish();
    const response = await responsePromise;
    expect(response.content[0].text).toContain('AOS ready'); expect(m.restart).toHaveBeenCalledTimes(1);
  });
  it('dead-PID collection releases admission so the close callback can finish', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {});
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    try {
      const responsePromise = buildProjectTool({ modelName: 'MyModel' }, {});
      await new Promise(resolve => setTimeout(resolve, 20));
      await finish();
      const response = await responsePromise;
      expect(response.content[0].text).toContain('Build succeeded');
      expect(response.content[0].text).not.toContain('unexpectedly');
    } finally { kill.mockRestore(); }
  });
  it('cached ordinary DB sync does not hold admission against another finalizing build', async () => {
    await buildProjectTool({ modelName: 'MyModel', wait: false }, {}); await finish();
    await buildProjectTool({ modelName: 'OtherModel', wait: false }, {});
    let release!: (value: any) => void;
    m.sync.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const collecting = buildProjectTool({ modelName: 'MyModel', dbSync: true }, {});
    await vi.waitFor(() => expect(m.sync).toHaveBeenCalled());
    await m.children.at(-1).handlers.close(0);
    const other = [...m.files.entries()].filter(([key]) => key.includes('d365build_state')).map(([, raw]) => JSON.parse(raw)).find(saved => saved.targetModel === 'OtherModel');
    expect(other.status).toBe('succeeded');
    release({ content: [{ type: 'text', text: 'Sync succeeded' }] }); await collecting;
  });
});
