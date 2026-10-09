/**
 * Every tool that writes a .rnrproj on a caller's behalf is bounded by the solution
 * roots d365fo_file(action="project") already enforced. create's addToProject used to
 * write any .rnrproj it was handed — action="project" add-object then refused the very
 * project create had just registered three objects into.
 *
 * A projectPath the USER configured (D365FO_PROJECT_PATH / config file) vouches for its
 * own folder; a project a tool call activated (forceProject) does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectFileManager, registerFileInActiveProject } from '../../src/workspace/projectFile.js';
import { assertProjectPathAllowed } from '../../src/utils/pathContainment.js';
import { getConfigManager } from '../../src/utils/configManager.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';

const RNRPROJ =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n' +
  '  <PropertyGroup><Model>ContosoRobotics</Model></PropertyGroup>\n' +
  '  <ItemGroup />\n' +
  '</Project>\n';

async function projectIn(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, 'CR-001'));
  const projectPath = path.join(dir, 'CR-001', 'CR-001.rnrproj');
  await fs.writeFile(projectPath, RNRPROJ);
  return projectPath;
}

const cfg: any = getConfigManager();
let ownProject: string;
let foreignProject: string;
let saved: Record<string, unknown>;
let savedEnv: string | undefined;

beforeEach(async () => {
  registerCustomModel('ContosoRobotics');
  await cfg.ensureLoaded();
  saved = {
    autoDetectedProject: cfg.autoDetectedProject, autoDetectionAttempted: cfg.autoDetectionAttempted,
    toolForcedProject: cfg.toolForcedProject, runtimeContext: cfg.runtimeContext,
  };
  savedEnv = process.env.D365FO_PROJECT_PATH;
  delete process.env.D365FO_PROJECT_PATH;
  ownProject = await projectIn('own-');
  foreignProject = await projectIn('foreign-');
  cfg.setRuntimeContext({ solutionPath: path.dirname(path.dirname(ownProject)) });
});
afterEach(async () => {
  Object.assign(cfg, saved);
  if (savedEnv === undefined) delete process.env.D365FO_PROJECT_PATH; else process.env.D365FO_PROJECT_PATH = savedEnv;
  await fs.rm(path.dirname(path.dirname(ownProject)), { recursive: true, force: true });
  await fs.rm(path.dirname(path.dirname(foreignProject)), { recursive: true, force: true });
});

describe('ProjectFileManager({ withinSolutionRoots: true })', () => {
  const guarded = () => new ProjectFileManager({ withinSolutionRoots: true });

  it('adds to a project under a configured root', async () => {
    expect(await guarded().addToProject(ownProject, 'class', 'CRThing', '')).toBe(true);
    expect(await fs.readFile(ownProject, 'utf-8')).toContain('AxClass\\CRThing');
  });

  it('refuses a project outside the roots and leaves it byte-for-byte as it was', async () => {
    await expect(guarded().addToProject(foreignProject, 'class', 'CRThing', ''))
      .rejects.toThrow(/outside the configured solution roots/);
    await expect(guarded().addLabelToProject(foreignProject, 'CRLabels', ['en-US']))
      .rejects.toThrow(/outside the configured solution roots/);
    await expect(guarded().removeFromProject(foreignProject, 'class', 'CRThing'))
      .rejects.toThrow(/outside the configured solution roots/);
    expect(await fs.readFile(foreignProject, 'utf-8')).toBe(RNRPROJ);
  });

  it('is opt-in: a manager built without it writes where it is told', async () => {
    expect(await new ProjectFileManager().addToProject(foreignProject, 'class', 'CRThing', '')).toBe(true);
  });
});

describe('which projects vouch for their own folder', () => {
  it('a projectPath the user configured does', async () => {
    process.env.D365FO_PROJECT_PATH = foreignProject;
    expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(true);
  });

  it('a project a tool call activated does not', async () => {
    expect(await cfg.forceProject(foreignProject)).not.toBeNull();
    expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(false);
  });
});

describe('registerFileInActiveProject (create/modify on an existing, unregistered file)', () => {
  it('reports the refusal instead of writing a project outside the roots', async () => {
    const note = await registerFileInActiveProject('class', 'CRThing', 'ContosoRobotics', foreignProject);
    expect(note).toMatch(/Could not add/);
    expect(note).toContain('outside the configured solution roots');
    expect(await fs.readFile(foreignProject, 'utf-8')).toBe(RNRPROJ);
  });

  it('still registers into a project under the roots', async () => {
    const note = await registerFileInActiveProject('class', 'CRThing', 'ContosoRobotics', ownProject);
    expect(note).toContain('added it to');
    expect(await fs.readFile(ownProject, 'utf-8')).toContain('AxClass\\CRThing');
  });
});
