/**
 * WorkspaceDetector Tests
 * Covers: detectD365Project's handling of ambiguous multi-project workspaces.
 *
 * A workspace containing more than one .rnrproj must never be silently
 * resolved to "the first one found" — that previously caused newly created
 * files to be registered into an arbitrary, unrelated VS project. These tests
 * use real temp directories (detectD365Project does real fs I/O) rather than
 * mocking fs, since the behavior under test is directory-tree traversal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { detectD365Project } from '../../src/utils/workspaceDetector';

const RNRPROJ_TEMPLATE = (modelName: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Project><Model>${modelName}</Model></Project>\n`;

async function makeProject(root: string, relDir: string, modelName: string): Promise<string> {
  const dir = path.join(root, relDir);
  await fs.mkdir(dir, { recursive: true });
  const projectPath = path.join(dir, `${modelName}.rnrproj`);
  await fs.writeFile(projectPath, RNRPROJ_TEMPLATE(modelName), 'utf-8');
  return projectPath;
}

const tempDirs: string[] = [];
async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'd365fo-workspace-detector-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('detectD365Project', () => {
  it('resolves the single .rnrproj when only one exists', async () => {
    const workspace = await makeTempWorkspace();
    const projectPath = await makeProject(workspace, 'ProjectAlpha', 'ProjectAlphaModel');

    const result = await detectD365Project(workspace);

    expect(result?.projectPath).toBe(projectPath);
    expect(result?.modelName).toBe('ProjectAlphaModel');
  });

  it('refuses to guess when multiple .rnrproj exist and none matches the workspace name', async () => {
    // Regression test: when two unrelated projects exist and neither folder
    // name matches the workspace, the detector must not silently fall back to
    // whichever .rnrproj sorts first alphabetically — that previously caused
    // newly created files to be registered into the wrong VS project.
    const workspace = await makeTempWorkspace();
    await makeProject(workspace, 'ProjectAlpha', 'ProjectAlphaModel');
    await makeProject(workspace, 'ProjectBeta', 'ProjectBetaModel');

    const result = await detectD365Project(workspace);

    expect(result).toBeNull();
  });

  it('resolves unambiguously when one .rnrproj folder name matches the workspace basename', async () => {
    const tempRoot = await makeTempWorkspace();
    // Workspace root is itself the intended project's folder, and directly
    // contains its .rnrproj — so its own folder name matches the workspace
    // basename. A second, unrelated .rnrproj also exists in a subfolder
    // (e.g. a nested/legacy project) but must not win.
    const workspace = path.join(tempRoot, 'ProjectBeta');
    await fs.mkdir(workspace, { recursive: true });
    const intendedProject = await makeProject(workspace, '.', 'ProjectBetaModel');
    await makeProject(workspace, 'ProjectAlpha', 'ProjectAlphaModel');

    const result = await detectD365Project(workspace);

    expect(result?.projectPath).toBe(intendedProject);
    expect(result?.modelName).toBe('ProjectBetaModel');
  });

  it('returns null when no .rnrproj files exist', async () => {
    const workspace = await makeTempWorkspace();

    const result = await detectD365Project(workspace);

    expect(result).toBeNull();
  });
});
