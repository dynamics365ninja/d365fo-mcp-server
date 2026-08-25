/**
 * D365FO_SOLUTIONS_PATH fallback — multi-project models
 *
 * Regression test for the "always defaults to the first project" bug: when
 * workspace/branch heuristics resolve nothing, autoDetectProject() falls back
 * to scanning the whole D365FO_SOLUTIONS_PATH tree and used to pin
 * autoDetectedProject to all[0] — whichever .rnrproj the scan happened to see
 * first — even when several projects shared the target model. Every write
 * after that landed in an arbitrary project nobody chose. The model must
 * still resolve (every candidate agrees on it), but the project must not be
 * auto-selected — mirroring the existing ambiguousProjects convention used
 * for workspace-level ambiguity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SOLUTIONS_ROOT = 'K:\\solutions';

const SHARED_MODEL_PROJECTS = [
  { projectPath: 'K:\\solutions\\ProjectAlpha\\ProjectAlpha.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\solutions\\ProjectAlpha' },
  { projectPath: 'K:\\solutions\\ProjectBeta\\ProjectBeta.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\solutions\\ProjectBeta' },
];

const SINGLE_PROJECT = [
  { projectPath: 'K:\\solutions\\ProjectGamma\\ProjectGamma.rnrproj', modelName: 'IsvFin', solutionPath: 'K:\\solutions\\ProjectGamma' },
];

vi.mock('../../src/utils/workspaceDetector.js', () => ({
  autoDetectD365Project: vi.fn(async () => null),
  detectD365Project: vi.fn(async () => null),
  scanAllD365Projects: vi.fn(async () => []),
  detectGitBranch: vi.fn(async () => null),
  extractModelNameFromProject: vi.fn(async () => null),
  isMicrosoftDemoModel: vi.fn(() => false),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), realpathSync: vi.fn((p: string) => p) };
});

import { getConfigManager } from '../../src/utils/configManager.js';
import { scanAllD365Projects } from '../../src/utils/workspaceDetector.js';

/** Fresh ConfigManager with detection not yet attempted. */
function makeManager() {
  const proto = Object.getPrototypeOf(getConfigManager());
  const mgr = new proto.constructor('/nonexistent/.mcp.json') as ReturnType<typeof getConfigManager>;
  (mgr as any).config = { servers: {} };
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  (mgr as any).runtimeContext = {};
  return mgr;
}

// .rnrproj scanning is Windows-only in autoDetectProject; pretend we are there
// so the test is meaningful on Linux CI too.
const realPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.D365FO_SOLUTIONS_PATH = SOLUTIONS_ROOT;
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete process.env.D365FO_SOLUTIONS_PATH;
});

describe('D365FO_SOLUTIONS_PATH fallback — multi-project models', () => {
  it('does not auto-select a project when several under the scan share one model', async () => {
    vi.mocked(scanAllD365Projects).mockResolvedValue(SHARED_MODEL_PROJECTS as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    expect(mgr.getModelName()).toBe('ContosoCore');
    await expect(mgr.getProjectPath()).resolves.toBeNull();
  });

  it('records every same-model candidate as ambiguousProjects, not just the first', async () => {
    vi.mocked(scanAllD365Projects).mockResolvedValue(SHARED_MODEL_PROJECTS as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    expect((mgr as any).autoDetectedProject?.ambiguousProjects?.sort()).toEqual(
      SHARED_MODEL_PROJECTS.map(p => p.projectPath).sort(),
    );
  });

  it('still auto-selects the project when only one is found for the model', async () => {
    // Control case: the fix must not turn ordinary single-project resolution
    // into an unnecessary refusal.
    vi.mocked(scanAllD365Projects).mockResolvedValue(SINGLE_PROJECT as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    expect(mgr.getModelName()).toBe('IsvFin');
    await expect(mgr.getProjectPath()).resolves.toBe(SINGLE_PROJECT[0].projectPath);
  });
});
