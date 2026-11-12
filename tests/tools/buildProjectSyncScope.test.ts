import { beforeEach, describe, expect, it, vi } from 'vitest';

// build_d365fo_project: which tables a dbSync request is satisfied by. `dbSync: true` syncs the
// project's tables (a full sync only when there is no project), so a table list asked for later
// is covered only by what that sync actually synced.
const m = vi.hoisted(() => ({
  files: new Map<string, string>(), children: [] as any[],
  spawn: vi.fn(), metadata: vi.fn(), sync: vi.fn(), scan: vi.fn(),
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => { if (m.files.has(p)) return m.files.get(p); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
  writeFile: vi.fn(async (p: string, text: string) => { m.files.set(p, text); }),
  unlink: vi.fn(async (p: string) => { m.files.delete(p); }),
  appendFile: vi.fn(async (p: string, text: string) => { m.files.set(p, (m.files.get(p) ?? '') + text); }),
  access: vi.fn(async (p: string) => { if (p.endsWith('xppc.exe') || p === 'C:\\Packages') return; throw new Error('missing'); }),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ mtimeMs: 0 })), rm: vi.fn(),
}));
vi.mock('fs', () => ({ openSync: vi.fn(() => 3), closeSync: vi.fn() }));
vi.mock('child_process', () => ({ spawn: m.spawn, execFile: vi.fn((_f, _a, _o, cb) => cb(null, { stdout: '', stderr: '' })) }));
vi.mock('../../src/utils/configManager.js', () => ({ getConfigManager: () => ({
  ensureLoaded: vi.fn(), getActiveXppConfig: async () => null,
  getCustomPackagesPath: async () => 'C:\\Packages', getMicrosoftPackagesPath: async () => 'C:\\Packages',
  getModelName: () => 'ContosoExt', getContext: () => ({}), getDevEnvironmentType: async () => 'traditional',
}) }));
vi.mock('../../src/utils/operationLocks.js', () => ({ forceReleaseLock: vi.fn(), withOperationLock: async (_key: string, fn: any) => fn() }));
vi.mock('../../src/tools/write/compileLabels.js', () => ({ compileModelLabels: async () => ({ success: true, skipped: true, message: 'No labels' }) }));
vi.mock('../../src/tools/sdlc/compilerMetadataPrune.js', () => ({ pruneStaleCompilerMetadata: async () => ({ removed: [], preserved: [] }) }));
vi.mock('../../src/tools/xml/generateMetadata.js', () => ({ generateRuntimeMetadata: m.metadata }));
vi.mock('../../src/tools/sdlc/dbSync.js', () => ({ dbSyncTool: m.sync }));
vi.mock('../../src/tools/sdlc/odataActionGuard.js', async () => ({
  ...(await vi.importActual<any>('../../src/tools/sdlc/odataActionGuard.js')), scanODataActions: m.scan,
}));
import { buildProjectTool } from '../../src/tools/sdlc/buildProject.js';

/** The project's tables: what `dbSync: true` syncs when a project is found. */
const PROJECT_TABLES = ['ContosoRentEquipmentTable'];

/** dbSyncTool as it answers: a named list syncs that list, no list syncs the project's tables. */
function syncsProject(scope: 'project' | 'full' = 'project') {
  m.sync.mockImplementation(async (args: any) => {
    const synced = args.tables ?? (scope === 'full' ? 'full' : PROJECT_TABLES);
    return {
      content: [{ type: 'text', text: `✅ DB Sync completed — ${synced === 'full' ? 'full' : synced.join(', ')}` }],
      syncedScope: synced,
    };
  });
}
/** The tables every sync of this test was asked for, or 'project' for a call without a list. */
const syncCalls = () => m.sync.mock.calls.map(c => (c[0] as any).tables ?? 'project');

/** Ends the running xppc build of ContosoExt. */
async function finish(code = 0) {
  const state = [...m.files.entries()]
    .filter(([p]) => p.includes('d365build_state'))
    .map(([, text]) => JSON.parse(text))
    .find(s => s.targetModel === 'ContosoExt');
  m.files.set(state.logFile.replace('.log', '.xppc.err'), 'Errors: 0');
  await m.children[m.children.length - 1].handlers.close(code);
}
const call = (extra: object = {}) => buildProjectTool({ modelName: 'ContosoExt', wait: false, ...extra }, {});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(50);
  expect(cond()).toBe(true);
};

beforeEach(() => {
  vi.clearAllMocks(); m.files.clear(); m.children.length = 0;
  m.spawn.mockImplementation(() => {
    const child = { pid: process.pid, unref: vi.fn(), handlers: {} as any, on(event: string, fn: any) { this.handlers[event] = fn; } };
    m.children.push(child);
    return child;
  });
  m.metadata.mockResolvedValue({ success: true, skipped: false, message: 'Generated' });
  m.scan.mockResolvedValue({ recompiled: [], missing: [], runtimeFile: null, errors: [] });
  syncsProject();
});

describe('build_d365fo_project dbSync scope when the result is collected', () => {
  it('syncs a table the collecting call names that the project sync did not cover', async () => {
    await call({ dbSync: true });
    await finish();
    const result = await call({ dbSync: ['ContosoOtherTable'] });
    expect(syncCalls()).toEqual(['project', ['ContosoOtherTable']]);
    expect(result.content[0].text).toContain('ContosoOtherTable');
    expect(result.isError).toBeFalsy();
  });

  it('does not sync again a table the project sync covered', async () => {
    await call({ dbSync: true });
    await finish();
    await call({ dbSync: ['ContosoRentEquipmentTable'] });
    expect(syncCalls()).toEqual(['project']);
  });

  it('treats a full sync as covering any table list', async () => {
    syncsProject('full');
    await call({ dbSync: true });
    await finish();
    await call({ dbSync: ['ContosoOtherTable'] });
    expect(syncCalls()).toEqual(['project']);
  });

  it('collects the same request once, as before', async () => {
    await call({ dbSync: true });
    await finish();
    await call({ dbSync: true });
    expect(syncCalls()).toEqual(['project']);
  });

  it('makes the result an error when the added sync fails', async () => {
    await call({ dbSync: true });
    await finish();
    m.sync.mockResolvedValueOnce({ content: [{ type: 'text', text: '✅ project synced' }], syncedScope: PROJECT_TABLES });
    m.sync.mockResolvedValueOnce({ content: [{ type: 'text', text: '❌ DB Sync failed' }], isError: true });
    const result = await call({ dbSync: ['ContosoOtherTable'] });
    expect(result.isError).toBe(true);
  });
});

describe('build_d365fo_project dbSync scope for a call waiting on a running build', () => {
  it('syncs a table the waiting call names that the rendering call\'s project sync did not cover', async () => {
    const first = buildProjectTool({ modelName: 'ContosoExt', dbSync: true }, {});
    await until(() => m.children.length === 1);
    await sleep(1_100); // the first call reads the state first, so it is the one that renders
    const second = buildProjectTool({ modelName: 'ContosoExt', dbSync: ['ContosoOtherTable'] }, {});
    await sleep(1_200);
    await finish();
    const [, waited] = await Promise.all([first, second]);
    expect(syncCalls()).toEqual(['project', ['ContosoOtherTable']]);
    expect(waited.content[0].text).toContain('ContosoOtherTable');
  }, 20_000);

  it('does not sync again for a waiting call whose table the project sync covered', async () => {
    const first = buildProjectTool({ modelName: 'ContosoExt', dbSync: true }, {});
    await until(() => m.children.length === 1);
    await sleep(1_100);
    const second = buildProjectTool({ modelName: 'ContosoExt', dbSync: ['ContosoRentEquipmentTable'] }, {});
    await sleep(1_200);
    await finish();
    await Promise.all([first, second]);
    expect(syncCalls()).toEqual(['project']);
  }, 20_000);
});
