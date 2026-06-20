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

