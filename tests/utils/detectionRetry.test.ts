/**
 * ConfigManager re-runs workspace detection once the sources it needs are up
 * (#833).
 *
 * The first pass fires roughly two seconds into startup, before the bridge and
 * the workspace roots have arrived. Treating its empty result as final is what
 * made the server report "could not auto-detect" for a workspace it resolved
 * moments later by another route.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfigManager } from '../../src/utils/configManager.js';
import { getWorkspaceDetectionStatus, resetWorkspaceDetectionStatus } from '../../src/utils/workspaceDetectionStatus.js';

const detected = {
  modelName: 'ContosoCore',
  projectPath: 'K:\\Solutions\\Contoso\\Contoso\\Contoso.rnrproj',
  solutionPath: 'K:\\Solutions\\Contoso',
  detectionSource: 'the workspace path',
};

const autoDetect = vi.fn(async () => null as any);
const detectProject = vi.fn(async () => null as any);

vi.mock('../../src/utils/workspaceDetector', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/workspaceDetector')>();
  return {
    ...actual,
    autoDetectD365Project: (...args: any[]) => autoDetect(...(args as [])),
    detectD365Project: (...args: any[]) => detectProject(...(args as [])),
    scanAllD365Projects: vi.fn(async () => []),
  };
});

/** A ConfigManager with no config file and nothing detected yet. */
function makeManager() {
  const ConfigManagerClass = Object.getPrototypeOf(getConfigManager()).constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json');
  (mgr as any).config = { servers: { context: {} } };
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  return mgr as any;
}

let stderr: ReturnType<typeof vi.spyOn>;
const logged = () => stderr.mock.calls.map(c => c.join(' ')).join('\n');
const savedSolutionsPath = process.env.D365FO_SOLUTIONS_PATH;
const realPlatform = process.platform;

/** Detection only scans .rnrproj on Windows, and CI is Linux. */
function pretendWindows(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  resetWorkspaceDetectionStatus();
  autoDetect.mockReset().mockResolvedValue(null);
  detectProject.mockReset().mockResolvedValue(null);
  delete process.env.D365FO_SOLUTIONS_PATH;
  delete process.env.D365FO_MODEL_NAME;
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  pretendWindows('win32');
});

afterEach(() => {
  pretendWindows(realPlatform);
  stderr.mockRestore();
  resetWorkspaceDetectionStatus();
  if (savedSolutionsPath !== undefined) process.env.D365FO_SOLUTIONS_PATH = savedSolutionsPath;
});

describe('detection retry', () => {
  it('stays silent on the boot pass and resolves on the retry', async () => {
    const mgr = makeManager();

    // Boot: nothing is configured yet and nothing is found.
    await (mgr as any).autoDetectProject(undefined);
    expect(logged()).not.toMatch(/[Cc]ould not auto-detect/);

    // The workspace root arrives (roots/list, or the packagePath from .mcp.json).
    autoDetect.mockResolvedValue(detected);
    (mgr as any).runtimeContext.workspacePath = 'K:\\Solutions\\Contoso';

    await mgr.getRawAutoDetectedModelName();

    expect(autoDetect).toHaveBeenCalledTimes(2);
    expect(await mgr.getRawAutoDetectedModelName()).toBe('ContosoCore');
    expect(logged()).not.toMatch(/[Cc]ould not auto-detect/);
  });

  it('spends the retry once, not on every call', async () => {
    const mgr = makeManager();

    await (mgr as any).autoDetectProject(undefined);
    (mgr as any).runtimeContext.workspacePath = 'K:\\Solutions\\Contoso';
    await mgr.getRawAutoDetectedModelName();
    await mgr.getRawAutoDetectedModelName();
    await mgr.getSolutionPath();

    // Two passes: the boot one and the single retry the new source bought.
    expect(autoDetect).toHaveBeenCalledTimes(2);
  });

  it('warns once nothing has resolved it and a caller needed one', async () => {
    const mgr = makeManager();

    await mgr.getRawAutoDetectedModelName();

    expect(logged()).toMatch(/Could not auto-detect/);
    expect(getWorkspaceDetectionStatus().resolved).toBe(false);
  });

  it('does not warn when the model is named in configuration', async () => {
    const mgr = makeManager();
    (mgr as any).config = { servers: { context: { modelName: 'ContosoCore' } } };

    await mgr.getRawAutoDetectedModelName();

    expect(logged()).not.toMatch(/Could not auto-detect/);
    expect(getWorkspaceDetectionStatus().source).toBe('.mcp.json');
  });
});
