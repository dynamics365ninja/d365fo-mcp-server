/**
 * forceProject persistence + git-branch auto-switch tests
 *
 * Covers two scenarios:
 *  A) forceProject persistence — after forceProject(B), subsequent
 *     setRuntimeContext / setRuntimeContextFromRoots calls must NOT revert to A.
 *
 *  B) git-branch auto-switch — get_workspace_info (no args) re-checks the git
 *     branch on every call; when the branch changes to one that matches a
 *     different project, the server switches automatically (no manual forceProject
 *     needed when the user switches branches / solutions in VS 2022).
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';

// ── Mocks must be declared before any imports that load the mocked modules ──

vi.mock('../../src/utils/workspaceDetector.js', () => ({
  autoDetectD365Project: vi.fn(async () => null),
  detectD365Project:     vi.fn(async () => null),
  scanAllD365Projects:   vi.fn(async () => []),
  detectGitBranch:       vi.fn(async () => null),
  extractModelNameFromProject: vi.fn(async (p: string) => {
    if (p.includes('ProjectB')) return 'ModelB';
    if (p.includes('ProjectA')) return 'ModelA';
    return null;
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), realpathSync: vi.fn((p: string) => p) };
});

// ── Import after mocks ──
import { getConfigManager } from '../../src/utils/configManager.js';

// ─────────────────────────────────────────────────────────────────────────────

const WORKSPACE  = 'K:\\repos\\Contoso';
const PROJECT_A  = 'K:\\repos\\Contoso\\SolutionA\\ProjectA\\ProjectA.rnrproj';
const PROJECT_B  = 'K:\\repos\\Contoso\\SolutionB\\ProjectB\\ProjectB.rnrproj';
const INFO_A = { projectPath: PROJECT_A, modelName: 'ModelA', solutionPath: 'K:\\repos\\Contoso\\SolutionA' };
const INFO_B = { projectPath: PROJECT_B, modelName: 'ModelB', solutionPath: 'K:\\repos\\Contoso\\SolutionB' };

/** Create a fresh ConfigManager instance (bypasses singleton). */
function makeManager() {
  const proto = Object.getPrototypeOf(getConfigManager());
  const ConfigManagerClass = proto.constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json') as ReturnType<typeof getConfigManager>;

  // No .mcp.json config — blank slate
  (mgr as any).config = { servers: {} };

  // Simulate: initial detection already ran and found ProjectA
  (mgr as any).autoDetectionAttempted = true;
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  (mgr as any).autoDetectedProject = INFO_A;
  (mgr as any).runtimeContext = { workspacePath: WORKSPACE };
  // Cache reflects initial detection
  (mgr as any).autoDetectionCache.set(WORKSPACE, INFO_A);
  // Two known projects (D365FO_SOLUTIONS_PATH scan result)
  (mgr as any).allDetectedProjects = [INFO_A, INFO_B];

  return mgr;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('forceProject — basic switch', () => {
  it('immediately returns the forced model name', async () => {
    const mgr = makeManager();
    expect(mgr.getModelName()).toBe('ModelA'); // initial state

    await mgr.forceProject(PROJECT_B);

    expect(mgr.getModelName()).toBe('ModelB');
  });
});

describe('forceProject — persistence across HTTP requests', () => {
  it('keeps forced project when setRuntimeContext is called with same workspace', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    expect(mgr.getModelName()).toBe('ModelB');

    // Simulate HTTP transport calling setRuntimeContext on next request
    mgr.setRuntimeContext({ workspacePath: WORKSPACE });

    expect(mgr.getModelName()).toBe('ModelB');
  });

  it('keeps forced project when setRuntimeContext is called twice with same workspace', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);

    mgr.setRuntimeContext({ workspacePath: WORKSPACE });
    mgr.setRuntimeContext({ workspacePath: WORKSPACE });

    expect(mgr.getModelName()).toBe('ModelB');
  });

  it('keeps forced projectPath in getWorkspaceInfoDiagnostics', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    mgr.setRuntimeContext({ workspacePath: WORKSPACE });

    const info = await mgr.getWorkspaceInfoDiagnostics();
    expect(info.modelName).toBe('ModelB');
    expect(info.projectPath).toBe(PROJECT_B);
  });
});

describe('forceProject — persistence across stdio roots/list notifications', () => {
  it('keeps forced project when setRuntimeContextFromRoots fires with ambiguous root', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    expect(mgr.getModelName()).toBe('ModelB');

    // Simulate stdio: roots/list notification arrives with the broad solution root.
    // WORKSPACE covers both ProjectA and ProjectB → ambiguous → BFS fallback.
    // Previously, the BFS fallback deleted the cache and reverted to ProjectA.
    await mgr.setRuntimeContextFromRoots([WORKSPACE]);

    expect(mgr.getModelName()).toBe('ModelB');
  });

  it('keeps forced project across multiple roots/list notifications', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);

    await mgr.setRuntimeContextFromRoots([WORKSPACE]);
    await mgr.setRuntimeContextFromRoots([WORKSPACE]);

    expect(mgr.getModelName()).toBe('ModelB');
  });

  it('allows a second forceProject to override the first', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    await mgr.setRuntimeContextFromRoots([WORKSPACE]);

    // User explicitly switches again
    await mgr.forceProject(PROJECT_A);

    expect(mgr.getModelName()).toBe('ModelA');

    // And it should persist
    await mgr.setRuntimeContextFromRoots([WORKSPACE]);
    expect(mgr.getModelName()).toBe('ModelA');
  });
});


/**
 * The write anchor. A project switch is a TOOL call — the agent can make it for
 * itself — so it moves reads only. Writes stay measured against the model the
 * workspace resolved on its own, otherwise the cross-model guard is comparing
 * a value the caller just changed (live demo, 2026-08-07: every write landed in
 * the shared Core model and the open project stayed empty).
 */
describe('forceProject — write anchor', () => {
  it('keeps the write anchor on the workspace model after a switch', async () => {
    const mgr = makeManager();
    expect(mgr.getWriteAnchorModel()).toBe('ModelA');

    await mgr.forceProject(PROJECT_B);

    expect(mgr.getModelName()).toBe('ModelB');        // reads follow the switch
    expect(mgr.getWriteAnchorModel()).toBe('ModelA'); // writes do not
    expect(mgr.getToolProjectSwitch()).toEqual({ anchorModel: 'ModelA', forcedModel: 'ModelB' });
  });

  it('does not walk the anchor along with repeated switches', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    await mgr.forceProject(PROJECT_B);

    expect(mgr.getWriteAnchorModel()).toBe('ModelA');
  });

  it('clears the anchor when switched back to the workspace model', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    await mgr.forceProject(PROJECT_A);

    expect(mgr.getToolProjectSwitch()).toBeNull();
    expect(mgr.getWriteAnchorModel()).toBe('ModelA');
  });

  // The only case in this file that needs matchProjectForWorkspace to actually
  // MATCH, which means real path parsing: the Windows literals above are inert on
  // a POSIX runner (path.dirname of a backslash path is "."), so every other test
  // here passes on CI by taking the no-match branch. Build this one natively —
  // the gate runs on ubuntu-latest.
  const NATIVE_ROOT = path.join(path.parse(process.cwd()).root, 'repos', 'Contoso');
  const NATIVE_B_DIR = path.join(NATIVE_ROOT, 'SolutionB', 'ProjectB');
  const NATIVE_B = path.join(NATIVE_B_DIR, 'ProjectB.rnrproj');

  it('clears the anchor when the workspace itself resolves a project', async () => {
    const mgr = makeManager();
    (mgr as any).allDetectedProjects = [
      INFO_A,
      { projectPath: NATIVE_B, modelName: 'ModelB', solutionPath: path.join(NATIVE_ROOT, 'SolutionB') },
    ];

    await mgr.forceProject(NATIVE_B);
    expect(mgr.getWriteAnchorModel()).toBe('ModelA');

    // roots/list with a root that matches ProjectB unambiguously: the USER moved.
    await mgr.setRuntimeContextFromRoots([NATIVE_B_DIR]);

    expect(mgr.getToolProjectSwitch()).toBeNull();
    expect(mgr.getWriteAnchorModel()).toBe('ModelB');
  });

  it('leaves reads and writes in agreement when nothing was switched', async () => {
    const mgr = makeManager();
    expect(mgr.getToolProjectSwitch()).toBeNull();
    expect(mgr.getWriteAnchorModel()).toBe(mgr.getModelName());
  });

  it('waits for a detection still in flight before taking the anchor', async () => {
    // The switch can be the FIRST tool call of a session, while the background
    // workspace scan is still running. forceProject used to read the model
    // synchronously, get null, store no anchor at all — and hand the caller the
    // bypass the anchor exists to deny: writes would follow the switch.
    const mgr = makeManager();
    let resolveDetection!: () => void;
    (mgr as any).autoDetectedProject = null;
    (mgr as any).autoDetectionAttempted = true;
    (mgr as any).detectionInProgress = new Promise<void>(resolve => {
      resolveDetection = () => { (mgr as any).autoDetectedProject = INFO_A; resolve(); };
    });

    const switching = mgr.forceProject(PROJECT_B);
    resolveDetection();
    await switching;

    expect(mgr.getModelName()).toBe('ModelB');
    expect(mgr.getWriteAnchorModel()).toBe('ModelA');
  });
});

/**
 * The mirror of the bug the anchor prevents: an anchor left standing after the
 * user genuinely moved refuses every write into the model the NEW workspace
 * targets, naming a model they no longer have open. Only two of the six places
 * that re-resolve a project used to clear it.
 */
describe('forceProject — the anchor does not outlive its workspace', () => {
  it('clears the anchor when a request arrives for a workspace never seen before', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);
    expect(mgr.getWriteAnchorModel()).toBe('ModelA');

    // VS 2022 sends the workspace path per request; this one is new, so
    // detection is reset and re-run for it.
    mgr.setRuntimeContext({ workspacePath: 'K:\\repos\\SomethingElse' });

    expect(mgr.getToolProjectSwitch()).toBeNull();
  });

  it('keeps the anchor when the SAME workspace reports in again', async () => {
    // The per-request path fires constantly with an unchanged workspace, and
    // forceProject cached its project under that key. Clearing here would undo
    // the anchor on the very next request.
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);

    mgr.setRuntimeContext({ workspacePath: WORKSPACE });
    mgr.setRuntimeContext({ workspacePath: WORKSPACE });

    expect(mgr.getWriteAnchorModel()).toBe('ModelA');
    expect(mgr.getModelName()).toBe('ModelB');
  });

  it('clears the anchor when roots/list falls back to BFS on an unknown root', async () => {
    const mgr = makeManager();
    await mgr.forceProject(PROJECT_B);

    await mgr.setRuntimeContextFromRoots(['K:\\repos\\AnotherSolution']);

    expect(mgr.getToolProjectSwitch()).toBeNull();
  });
});
