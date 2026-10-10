/**
 * `workspace.projectPath` / D365FO_PROJECT_PATH pins the project.
 *
 * The config file loads its settings into process.env (configFile.ts), so
 * `workspace.projectPath` arrives as D365FO_PROJECT_PATH. getProjectPath(),
 * getSolutionPath() and get_workspace_info read only the .mcp.json context, so the
 * documented "Pinned .rnrproj file" setting did nothing: with it set, the benchmark
 * server (2026-10-10) reported "Project : (not detected)" and could not register
 * a single file in the project.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfigManager } from '../../src/utils/configManager.js';
import { resetWorkspaceDetectionStatus } from '../../src/utils/workspaceDetectionStatus.js';

vi.mock('../../src/utils/workspaceDetector', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/workspaceDetector')>();
  return {
    ...actual,
    autoDetectD365Project: vi.fn(async () => null),
    detectD365Project: vi.fn(async () => null),
    scanAllD365Projects: vi.fn(async () => []),
  };
});

const PINNED = 'K:\\AosService\\PackagesLocalDirectory\\BenchmarkTestMcp\\BenchmarkTestMcp.rnrproj';
const ENV = ['D365FO_PROJECT_PATH', 'D365FO_SOLUTION_PATH', 'D365FO_MODEL_NAME'];
let saved: Record<string, string | undefined>;

function makeManager(context: Record<string, unknown> = {}) {
  const ConfigManagerClass = Object.getPrototypeOf(getConfigManager()).constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json');
  (mgr as any).config = { servers: { context } };
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  return mgr as any;
}

beforeEach(() => {
  resetWorkspaceDetectionStatus();
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('a pinned project path', () => {
  it('is the project when it comes from D365FO_PROJECT_PATH (the config file setting)', async () => {
    process.env.D365FO_PROJECT_PATH = PINNED;
    process.env.D365FO_MODEL_NAME = 'BenchmarkTestMcp';
    const mgr = makeManager({ workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\BenchmarkTestMcp\\BenchmarkTestMcp' });

    expect(await mgr.getProjectPath()).toBe(PINNED);
    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.projectPath).toBe(PINNED);
    expect(diag.projectSource).toMatch(/D365FO_PROJECT_PATH/);
  });

  it('pins the solution the same way', async () => {
    process.env.D365FO_SOLUTION_PATH = 'K:\\Sol';
    expect(await makeManager().getSolutionPath()).toBe('K:\\Sol');
  });

  it('still reads the .mcp.json context', async () => {
    expect(await makeManager({ projectPath: PINNED }).getProjectPath()).toBe(PINNED);
  });

  it('puts the environment over .mcp.json, as getContext() does', async () => {
    process.env.D365FO_PROJECT_PATH = PINNED;
    expect(await makeManager({ projectPath: 'K:\\Other\\Other.rnrproj' }).getProjectPath()).toBe(PINNED);
  });

  it('leaves auto-detection to run when nothing is pinned', async () => {
    expect(await makeManager().getProjectPath()).toBeNull();
  });
});
