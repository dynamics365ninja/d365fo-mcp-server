/**
 * get_workspace_info must not wait for the .rnrproj scan when the model is
 * already named in D365FO_MODEL_NAME or the config.
 *
 * Measured on the dev VM: with the server started in a package folder that holds
 * no .rnrproj, the scan found the model from the path in 2.1 s, then fell back to
 * scanning the whole PackagesLocalDirectory (7.5 s, nothing found). The first
 * get_workspace_info waited for it until its 5 s cap — on every session, for a
 * project path that writes do not need.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfigManager } from '../../src/utils/configManager.js';
import { resetWorkspaceDetectionStatus } from '../../src/utils/workspaceDetectionStatus.js';

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

function makeManager(context: Record<string, unknown> = {}) {
  const ConfigManagerClass = Object.getPrototypeOf(getConfigManager()).constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json');
  (mgr as any).config = { servers: { context } };
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  return mgr as any;
}

const realPlatform = process.platform;
const pretendWindows = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

/** A scan that runs until the test lets it finish. */
function slowScan() {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  autoDetect.mockImplementation(async () => {
    await gate;
    return { modelName: 'BenchmarkTestMcp', projectPath: 'K:\\Sol\\Bench\\Bench.rnrproj', solutionPath: 'K:\\Sol', detectionSource: 'the workspace path' };
  });
  return release;
}

beforeEach(() => {
  resetWorkspaceDetectionStatus();
  autoDetect.mockReset().mockResolvedValue(null);
  detectProject.mockReset().mockResolvedValue(null);
  delete process.env.D365FO_MODEL_NAME;
  delete process.env.D365FO_SOLUTIONS_PATH;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  pretendWindows('win32');
});

afterEach(() => {
  pretendWindows(realPlatform);
  vi.restoreAllMocks();
  delete process.env.D365FO_MODEL_NAME;
});

describe('get_workspace_info and the .rnrproj scan', () => {
  it('answers at once when D365FO_MODEL_NAME names the model, and says the scan is still running', async () => {
    process.env.D365FO_MODEL_NAME = 'BenchmarkTestMcp';
    const release = slowScan();
    const mgr = makeManager({ workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\BenchmarkTestMcp' });

    const t = Date.now();
    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(diag.modelName).toBe('BenchmarkTestMcp');
    expect(diag.projectPath).toBeNull();
    expect(diag.projectDetectionPending).toBe(true);

    // The scan finishes in the background; the next call has the project.
    release();
    await vi.waitFor(() => expect((mgr as any).projectScanRunning).toBe(false));
    const again = await mgr.getWorkspaceInfoDiagnostics();
    expect(again.projectPath).toBe('K:\\Sol\\Bench\\Bench.rnrproj');
    expect(again.projectDetectionPending).toBe(false);
  });

  it('treats a model in the config file the same way', async () => {
    const release = slowScan();
    const mgr = makeManager({ modelName: 'BenchmarkTestMcp' });
    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.projectDetectionPending).toBe(true);
    release();
  });

  it('still waits for the scan when nothing names the model — the scan is how it is found', async () => {
    const release = slowScan();
    const mgr = makeManager();
    let done = false;
    const pending = mgr.getWorkspaceInfoDiagnostics().then((d: any) => { done = true; return d; });
    await new Promise(r => setTimeout(r, 50));
    expect(done).toBe(false);
    release();
    const diag = await pending;
    expect(diag.modelName).toBe('BenchmarkTestMcp');
    expect(diag.projectDetectionPending).toBe(false);
  });
});

describe('the packagePath fallback scan', () => {
  it("scans only the detected model's package, not every package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pld-'));
    try {
      fs.mkdirSync(path.join(root, 'BenchmarkTestMcp'));
      fs.mkdirSync(path.join(root, 'ApplicationSuite'));
      autoDetect.mockResolvedValue({ modelName: 'BenchmarkTestMcp', packagePath: root, detectionSource: 'the PackagesLocalDirectory path' });
      const mgr = makeManager({ packagePath: root });
      await mgr.autoDetectProject(path.join(root, 'BenchmarkTestMcp'));
      expect(detectProject).toHaveBeenCalledWith(path.join(root, 'BenchmarkTestMcp'), 4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the whole root when no package folder carries the model name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pld-'));
    try {
      autoDetect.mockResolvedValue(null);
      const mgr = makeManager({ packagePath: root });
      await mgr.autoDetectProject(undefined);
      expect(detectProject).toHaveBeenCalledWith(root, 4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
