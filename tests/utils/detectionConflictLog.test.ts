/**
 * Workspace detection logs only what is wrong.
 *
 * VS Code shows every stderr line as [warning], so the four-line
 * "Auto-detection successful" block read as four warnings on every start, on
 * every machine — while the one state that IS wrong, the configured model
 * disagreeing with the project the scan picked, was never printed at all.
 * The routine outcome now goes to the debug log; the conflict is printed once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfigManager } from '../../src/utils/configManager.js';
import { resetWorkspaceDetectionStatus } from '../../src/utils/workspaceDetectionStatus.js';

const detected = {
  modelName: 'FMProofs',
  projectPath: 'C:\\Users\\dev\\source\\repos\\FMProofs\\AutoSettle\\AutoSettle.rnrproj',
  solutionPath: 'C:\\Users\\dev\\source\\repos\\FMProofs',
  detectionSource: 'the workspace path',
};

const autoDetect = vi.fn(async () => null as any);

vi.mock('../../src/utils/workspaceDetector', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/workspaceDetector')>();
  return {
    ...actual,
    autoDetectD365Project: (...args: any[]) => autoDetect(...(args as [])),
    detectD365Project: vi.fn(async () => null),
    scanAllD365Projects: vi.fn(async () => []),
  };
});

function makeManager(fileContext: Record<string, string> = {}) {
  const ConfigManagerClass = Object.getPrototypeOf(getConfigManager()).constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json');
  (mgr as any).config = { servers: { context: { ...fileContext } } };
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  return mgr as any;
}

let stderr: ReturnType<typeof vi.spyOn>;
const logged = () => stderr.mock.calls.map(c => c.join(' ')).join('\n');
const conflicts = () => stderr.mock.calls.filter(c => c.join(' ').includes('Model conflict')).length;

const savedEnv = {
  model: process.env.D365FO_MODEL_NAME,
  project: process.env.D365FO_PROJECT_PATH,
  solutions: process.env.D365FO_SOLUTIONS_PATH,
};
const realPlatform = process.platform;

/** Detection only scans .rnrproj on Windows, and CI is Linux. */
function pretendWindows(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  resetWorkspaceDetectionStatus();
  autoDetect.mockReset().mockResolvedValue(detected);
  delete process.env.D365FO_MODEL_NAME;
  delete process.env.D365FO_PROJECT_PATH;
  delete process.env.D365FO_SOLUTIONS_PATH;
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  pretendWindows('win32');
});

afterEach(() => {
  pretendWindows(realPlatform);
  stderr.mockRestore();
  resetWorkspaceDetectionStatus();
  for (const [key, value] of [
    ['D365FO_MODEL_NAME', savedEnv.model],
    ['D365FO_PROJECT_PATH', savedEnv.project],
    ['D365FO_SOLUTIONS_PATH', savedEnv.solutions],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('workspace detection logging', () => {
  it('says nothing about a routine successful detection', async () => {
    const mgr = makeManager();
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');

    expect(mgr.autoDetectedProject?.modelName).toBe('FMProofs');
    expect(logged()).not.toMatch(/Auto-detection successful|ProjectPath:|ModelName:|SolutionPath:|Source:/);
    expect(conflicts()).toBe(0);
  });

  it('warns once when the configured model is not the model of the detected project', async () => {
    process.env.D365FO_MODEL_NAME = 'ContosoCore';
    const mgr = makeManager();
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');

    const out = logged();
    expect(conflicts()).toBe(1);
    expect(out).toMatch(/Model conflict: D365FO_MODEL_NAME names "ContosoCore"/);
    expect(out).toMatch(/AutoSettle\.rnrproj declares model "FMProofs"/);
    // The consequence is spelled out: writes go to one model, files register into the other.
    expect(out).toMatch(/Writes target "ContosoCore" while new files are registered into .*AutoSettle\.rnrproj/);

    // The same workspace resolving again must not repeat the same warning.
    mgr.autoDetectionAttempted = false;
    mgr.autoDetectionCache.clear();
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');
    expect(conflicts()).toBe(1);
  });

  it('names .mcp.json as the source when the model came from the config file', async () => {
    const mgr = makeManager({ modelName: 'ContosoCore' });
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');

    expect(logged()).toMatch(/Model conflict: \.mcp\.json modelName names "ContosoCore"/);
  });

  it('treats a case-only difference as agreement', async () => {
    process.env.D365FO_MODEL_NAME = 'fmproofs';
    const mgr = makeManager();
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');

    expect(conflicts()).toBe(0);
  });

  it('stays silent when a projectPath is configured too — the detected project is unused then', async () => {
    process.env.D365FO_MODEL_NAME = 'ContosoCore';
    const mgr = makeManager({ projectPath: 'K:\\Solutions\\Contoso\\Contoso\\Contoso.rnrproj' });
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');

    expect(conflicts()).toBe(0);
  });

  it('stays silent when nothing is configured — there is nothing to conflict with', async () => {
    const mgr = makeManager();
    await mgr.autoDetectProject('C:\\Users\\dev\\source\\repos\\FMProofs');

    expect(conflicts()).toBe(0);
  });

  it('checks the workspace-root fast path too', async () => {
    process.env.D365FO_MODEL_NAME = 'ContosoCore';
    const mgr = makeManager();
    mgr.allDetectedProjects = [detected];

    await mgr.setRuntimeContextFromRoots(['C:\\Users\\dev\\source\\repos\\FMProofs\\AutoSettle']);

    expect(mgr.autoDetectedProject?.modelName).toBe('FMProofs');
    expect(conflicts()).toBe(1);
    expect(logged()).not.toMatch(/Root matched project/);
  });
});
