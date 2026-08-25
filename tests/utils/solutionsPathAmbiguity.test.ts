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

/** Two projects, one model, two different solution folders. */
const SPLIT_SOLUTION_PROJECTS = [
  { projectPath: 'K:\\solutions\\Alpha\\Alpha.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\solutions\\Alpha' },
  { projectPath: 'K:\\other\\Beta\\Beta.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\other\\Beta' },
];

/** Two projects of one solution folder, one model — the ordinary VS split. */
const SHARED_SOLUTION_PROJECTS = [
  { projectPath: 'K:\\solutions\\Contoso\\One\\One.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\solutions\\Contoso' },
  { projectPath: 'K:\\solutions\\Contoso\\Two\\Two.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\solutions\\Contoso' },
];

/** Several models under one scan root — K:\repos\ASL holds 31 of them. */
const MANY_MODEL_PROJECTS = [
  { projectPath: 'K:\\solutions\\Audit\\Audit.rnrproj', modelName: 'AslAuditReports', solutionPath: 'K:\\solutions\\Audit' },
  { projectPath: 'K:\\solutions\\Bank\\Bank.rnrproj', modelName: 'AslBankCommunication', solutionPath: 'K:\\solutions\\Bank' },
  { projectPath: 'K:\\solutions\\Bank2\\Bank2.rnrproj', modelName: 'AslBankCommunication', solutionPath: 'K:\\solutions\\Bank2' },
];

const SINGLE_PROJECT = [
  { projectPath: 'K:\\solutions\\ProjectGamma\\ProjectGamma.rnrproj', modelName: 'IsvFin', solutionPath: 'K:\\solutions\\ProjectGamma' },
];

// Spread the real modules and override only the disk-touching entry points: a
// hand-listed mock silently drops every export added later (distinctCustomModels
// was one), and the failure surfaces as "no export is defined on the mock" from a
// test that has nothing to do with the change.
vi.mock('../../src/utils/workspaceDetector.js', async (orig) => ({
  ...await orig<typeof import('../../src/utils/workspaceDetector.js')>(),
  autoDetectD365Project: vi.fn(async () => null),
  detectD365Project: vi.fn(async () => null),
  scanAllD365Projects: vi.fn(async () => []),
  detectGitBranch: vi.fn(async () => null),
  extractModelNameFromProject: vi.fn(async () => null),
}));

vi.mock('fs/promises', async (orig) => ({
  ...await orig<typeof import('fs/promises')>(),
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), realpathSync: vi.fn((p: string) => p) };
});

import { getConfigManager } from '../../src/utils/configManager.js';
import { scanAllD365Projects } from '../../src/utils/workspaceDetector.js';
import {
  describeWorkspaceDetection, resetWorkspaceDetectionStatus,
} from '../../src/utils/workspaceDetectionStatus.js';

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
  resetWorkspaceDetectionStatus();
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

  it('reports no projectPath to the detection status, so doctor and get_workspace_info agree', async () => {
    // recordDetectionSuccess kept being handed the project that was deliberately
    // NOT selected, so `d365fo-mcp doctor` printed a path next to a
    // get_workspace_info that says "(not selected)" — two answers, one state.
    vi.mocked(scanAllD365Projects).mockResolvedValue(SHARED_MODEL_PROJECTS as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    expect(describeWorkspaceDetection()).toContain('ContosoCore');
    expect(describeWorkspaceDetection()).not.toContain('.rnrproj');
  });

  it('surfaces the unselected candidates so the caller can name one', async () => {
    // Recorded and never shown was the whole gap: the warning the caller got said
    // "no projectPath could be resolved" and listed nothing.
    vi.mocked(scanAllD365Projects).mockResolvedValue(SHARED_MODEL_PROJECTS as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    expect(mgr.getAmbiguousProjectPaths().sort()).toEqual(
      SHARED_MODEL_PROJECTS.map(p => p.projectPath).sort(),
    );
  });

  it('keeps solutionPath when every candidate agrees on one', async () => {
    // solutionPath is a fact about the model when the candidates share a folder,
    // and getSolutionPath() consumers (createLabel, create) are entitled to it.
    vi.mocked(scanAllD365Projects).mockResolvedValue(SHARED_SOLUTION_PROJECTS as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    await expect(mgr.getProjectPath()).resolves.toBeNull();
    await expect(mgr.getSolutionPath()).resolves.toBe(SHARED_SOLUTION_PROJECTS[0].solutionPath);
  });

  it('drops solutionPath when the candidates disagree about it', async () => {
    // Then it is as much a guess as projectPath, and handing it out just moves
    // the arbitrary pick into ProjectFileFinder.findProjectInSolution().
    vi.mocked(scanAllD365Projects).mockResolvedValue(SPLIT_SOLUTION_PROJECTS as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    await expect(mgr.getSolutionPath()).resolves.toBeNull();
  });

  it('says the model was picked by scan order when the root holds several', async () => {
    // The guard only ever compared against `primary`, which is itself whichever
    // project scanned first. With 31 models under one root, whether the caller is
    // protected is decided by disk order — so the pick is at least stated.
    vi.mocked(scanAllD365Projects).mockResolvedValue(MANY_MODEL_PROJECTS as any);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mgr = makeManager();

    await (mgr as any).autoDetectProject();

    const said = warn.mock.calls.map(c => c.join(' ')).join('\n');
    warn.mockRestore();
    expect(said).toMatch(/2 custom models/);
    expect(said).toMatch(/picked by scan order/);
    // ...and the pick itself still stands: withholding the model would break
    // detection for every workspace whose only source is this scan.
    expect(mgr.getModelName()).toBe('AslAuditReports');
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
