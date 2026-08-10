/**
 * When workspace detection may warn, and which source it reports as the winner
 * (#833).
 *
 * The detector used to print "⚠️ Could not auto-detect D365FO project from any
 * source" from inside its own last fallback, roughly two seconds into startup —
 * before the packagePath scan, the solutions-path scan and .mcp.json had had
 * their turn. Detection then succeeded by one of those routes and the warning
 * stayed in the log, blaming configuration that was fine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { autoDetectD365Project } from '../../src/utils/workspaceDetector.js';
import {
  describeWorkspaceDetection, getWorkspaceDetectionStatus, recordDetectionSuccess,
  reportUnresolvedDetection, resetWorkspaceDetectionStatus,
} from '../../src/utils/workspaceDetectionStatus.js';

const tempDirs: string[] = [];
async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'd365fo-detection-status-'));
  tempDirs.push(dir);
  return dir;
}

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetWorkspaceDetectionStatus();
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  stderr.mockRestore();
  resetWorkspaceDetectionStatus();
  await Promise.all(tempDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tempDirs.length = 0;
});

/** Everything written to stderr during the test, as one string. */
const logged = () => stderr.mock.calls.map(c => c.join(' ')).join('\n');

describe('workspace detection status', () => {
  it('does not warn when a detection pass finds nothing', async () => {
    // The pass is one route among several; the packagePath and solutions-path
    // scans run after it and .mcp.json may settle the model outright.
    // Priority 4 (well-known VS project directories) reads the real
    // %USERPROFILE%\Documents\Visual Studio 2022\Projects on the dev's own
    // machine — override it, and unset the env-var routes, so a real D365FO
    // solution sitting there doesn't leak a false positive into the test.
    const empty = await makeTempWorkspace();
    const savedUserProfile = process.env.USERPROFILE;
    const savedWorkspacePath = process.env.WORKSPACE_PATH;
    const savedSolutionsPath = process.env.D365FO_SOLUTIONS_PATH;
    process.env.USERPROFILE = empty;
    delete process.env.WORKSPACE_PATH;
    delete process.env.D365FO_SOLUTIONS_PATH;

    try {
      const result = await autoDetectD365Project(empty);

      expect(result).toBeNull();
      expect(logged()).not.toMatch(/[Cc]ould not auto-detect/);
      expect(getWorkspaceDetectionStatus().resolved).toBe(false);
      expect(getWorkspaceDetectionStatus().tried).toContain('workspace path');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
      if (savedWorkspacePath === undefined) delete process.env.WORKSPACE_PATH; else process.env.WORKSPACE_PATH = savedWorkspacePath;
      if (savedSolutionsPath === undefined) delete process.env.D365FO_SOLUTIONS_PATH; else process.env.D365FO_SOLUTIONS_PATH = savedSolutionsPath;
    }
  });

  it('names the source that won', async () => {
    const workspace = await makeTempWorkspace();
    const dir = path.join(workspace, 'ProjectAlpha');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'ProjectAlpha.rnrproj'),
      '<?xml version="1.0" encoding="utf-8"?>\n<Project><Model>AlphaModel</Model></Project>\n',
      'utf-8',
    );

    const result = await autoDetectD365Project(workspace);

    expect(result?.detectionSource).toBe('the workspace path');
    expect(describeWorkspaceDetection()).toContain('model "AlphaModel" detected from the workspace path');
  });

  it('lists the sources it looked at instead of "any source"', () => {
    reportUnresolvedDetection();

    expect(logged()).toMatch(/Could not auto-detect/);
    expect(logged()).toContain('Sources tried');
  });

  it('warns at most once', () => {
    expect(reportUnresolvedDetection()).toBe(true);
    expect(reportUnresolvedDetection()).toBe(false);
  });

  it('never warns once a source has resolved the project', () => {
    recordDetectionSuccess('the configured packagePath', 'ContosoCore', 'K:\\p\\Contoso.rnrproj');

    expect(reportUnresolvedDetection()).toBe(false);
    expect(logged()).not.toMatch(/Could not auto-detect/);
  });

  it('retracts a warning that a later success proved wrong', () => {
    reportUnresolvedDetection();
    recordDetectionSuccess('the D365FO_SOLUTIONS_PATH scan', 'ContosoCore');

    expect(logged()).toMatch(/Detection resolved after all/);
    expect(getWorkspaceDetectionStatus().warned).toBe(false);
    expect(getWorkspaceDetectionStatus().source).toBe('the D365FO_SOLUTIONS_PATH scan');
  });

  it('does not count re-recording the same answer as a new attempt', () => {
    recordDetectionSuccess('.mcp.json', 'ContosoCore');
    recordDetectionSuccess('.mcp.json', 'ContosoCore');

    expect(getWorkspaceDetectionStatus().attempts).toBe(1);
  });
});
