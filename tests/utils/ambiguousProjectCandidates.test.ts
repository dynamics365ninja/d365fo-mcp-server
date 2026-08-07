/**
 * Candidate listing for ambiguous workspaces
 *
 * When auto-detection refuses to pick a .rnrproj, the tools that need one
 * (createD365File's addToProject, get_workspace_info) must be able to name the
 * real alternatives. getAllDetectedProjects() used to be fed exclusively by the
 * D365FO_SOLUTIONS_PATH scan, so in the very setup that triggers the refusal —
 * a multi-project workspace, no D365FO_SOLUTIONS_PATH — it returned an empty
 * list and the warning degraded to a generic "could not resolve".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const AMBIGUOUS = {
  modelName: 'ContosoCore',
  ambiguousProjects: [
    'K:\\repos\\Contoso\\Alpha\\Alpha.rnrproj',
    'K:\\repos\\Contoso\\Beta\\Beta.rnrproj',
  ],
};

const CANDIDATES = [
  { projectPath: 'K:\\repos\\Contoso\\Alpha\\Alpha.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\repos\\Contoso' },
  { projectPath: 'K:\\repos\\Contoso\\Beta\\Beta.rnrproj', modelName: 'ContosoCore', solutionPath: 'K:\\repos\\Contoso' },
];

vi.mock('../../src/utils/workspaceDetector.js', () => ({
  autoDetectD365Project: vi.fn(async () => AMBIGUOUS),
  detectD365Project:     vi.fn(async () => null),
  scanAllD365Projects:   vi.fn(async () => CANDIDATES),
  detectGitBranch:       vi.fn(async () => null),
  extractModelNameFromProject: vi.fn(async () => 'ContosoCore'),
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

const WORKSPACE = 'K:\\repos\\Contoso';

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
  delete process.env.D365FO_SOLUTIONS_PATH;
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('ambiguous workspace — candidate listing', () => {
  it('records the workspace candidates when no project could be auto-selected', async () => {
    const mgr = makeManager();

    await (mgr as any).autoDetectProject(WORKSPACE);

    expect(scanAllD365Projects).toHaveBeenCalledWith(WORKSPACE);
    expect(mgr.getWorkspaceProjectCandidates().map(p => p.projectPath)).toEqual(
      CANDIDATES.map(p => p.projectPath),
    );
  });

  it('keeps the resolved model name even though no project was selected', async () => {
    const mgr = makeManager();

    await (mgr as any).autoDetectProject(WORKSPACE);

    expect(mgr.getModelName()).toBe('ContosoCore');
  });

  it('does not re-scan the workspace when a project was resolved', async () => {
    const { autoDetectD365Project } = await import('../../src/utils/workspaceDetector.js');
    vi.mocked(autoDetectD365Project).mockResolvedValueOnce({
      ...CANDIDATES[0],
    } as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject(WORKSPACE);

    expect(scanAllD365Projects).not.toHaveBeenCalled();
    expect(mgr.getWorkspaceProjectCandidates()).toEqual([]);
  });

  it('keeps the candidate list out of the solutions-path list', async () => {
    // Two lists, two meanings. Feeding workspace candidates into
    // allDetectedProjects made a populated list look like a finished
    // D365FO_SOLUTIONS_PATH scan, so the scan below was skipped as unnecessary
    // AND its "no project detected → use the first one found" fallback adopted an
    // arbitrary workspace .rnrproj — reinstating, one branch over, exactly the
    // silent wrong-project pick this change removes.
    const SOLUTIONS = [
      { projectPath: 'K:\\solutions\\Fin\\Fin.rnrproj', modelName: 'IsvFin', solutionPath: 'K:\\solutions\\Fin' },
    ];
    process.env.D365FO_SOLUTIONS_PATH = 'K:\\solutions';
    vi.mocked(scanAllD365Projects).mockImplementation(async (root: string) =>
      (root === WORKSPACE ? CANDIDATES : SOLUTIONS) as any);
    const mgr = makeManager();

    await (mgr as any).autoDetectProject(WORKSPACE);

    expect(scanAllD365Projects).toHaveBeenCalledWith('K:\\solutions');
    expect(mgr.getAllDetectedProjects().map(p => p.modelName)).toEqual(['IsvFin']);
    expect(mgr.getWorkspaceProjectCandidates().map(p => p.modelName)).toEqual(['ContosoCore', 'ContosoCore']);
  });
});
