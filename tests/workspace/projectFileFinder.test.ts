/**
 * Regression: ProjectFileFinder.findProjectInSolution picked the first project
 * whose file name CONTAINED the model name.
 *
 * In a solution with one project per feature area of one model — ContosoCore
 * split into ContosoCoreBilling, ContosoCoreClaims, … — every project matched,
 * so every create, modify and label write without a configured projectPath was
 * registered into whichever project readdir listed first. An exact
 * `<Model>.rnrproj` one level deeper lost to a substring match one level up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { ProjectFileFinder } from '../../src/workspace/projectFile';

let root: string;

async function project(...segments: string[]): Promise<string> {
  const file = path.join(root, ...segments);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '<Project />', 'utf-8');
  return file;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-finder-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('ProjectFileFinder.findProjectInSolution', () => {
  it('does not pick a project when several feature projects match the model', async () => {
    await project('ContosoCoreBilling', 'ContosoCoreBilling.rnrproj');
    await project('ContosoCoreClaims', 'ContosoCoreClaims.rnrproj');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const found = await ProjectFileFinder.findProjectInSolution(root, 'ContosoCore');

    const said = log.mock.calls.map(c => c.join(' ')).join('\n');
    log.mockRestore();
    expect(found).toBeNull();
    expect(said).toMatch(/2 projects .* match model "ContosoCore"/);
    expect(said).toContain('projectPath');
  });

  it('returns <Model>.rnrproj even when a substring match is shallower', async () => {
    await project('ContosoCoreBilling.rnrproj');
    const exact = await project('Core', 'ContosoCore.rnrproj');

    await expect(ProjectFileFinder.findProjectInSolution(root, 'ContosoCore')).resolves.toBe(exact);
  });

  it('still returns the only project that matches', async () => {
    const only = await project('Billing', 'ContosoCoreBilling.rnrproj');
    await project('Other', 'FabrikamTools.rnrproj');

    await expect(ProjectFileFinder.findProjectInSolution(root, 'ContosoCore')).resolves.toBe(only);
  });

  it('refuses two projects with the exact name in different folders', async () => {
    await project('A', 'ContosoCore.rnrproj');
    await project('B', 'ContosoCore.rnrproj');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ProjectFileFinder.findProjectInSolution(root, 'ContosoCore')).resolves.toBeNull();
    log.mockRestore();
  });

  it('returns the first project when no model name is given', async () => {
    // create uses this to READ the model from a project, so there is no choice to get wrong.
    await project('A', 'ContosoCoreBilling.rnrproj');
    await project('B', 'ContosoCoreClaims.rnrproj');

    await expect(ProjectFileFinder.findProjectInSolution(root, '')).resolves.toMatch(/\.rnrproj$/);
  });

  it('returns null for a missing folder or no match', async () => {
    await project('Other', 'FabrikamTools.rnrproj');

    await expect(ProjectFileFinder.findProjectInSolution(root, 'ContosoCore')).resolves.toBeNull();
    await expect(ProjectFileFinder.findProjectInSolution(path.join(root, 'nope'), 'ContosoCore')).resolves.toBeNull();
  });

  it('does not look deeper than three levels', async () => {
    await project('a', 'b', 'c', 'd', 'ContosoCore.rnrproj');

    await expect(ProjectFileFinder.findProjectInSolution(root, 'ContosoCore')).resolves.toBeNull();
  });
});

describe('ProjectFileFinder.describeNoProject', () => {
  it('says several projects match rather than that none was found', async () => {
    // Found live: with 45 matching projects the create reply read
    // "Could not find .rnrproj for model …", the opposite of what happened.
    await project('ContosoCoreBilling', 'ContosoCoreBilling.rnrproj');
    await project('ContosoCoreClaims', 'ContosoCoreClaims.rnrproj');

    const said = await ProjectFileFinder.describeNoProject(root, 'ContosoCore');

    expect(said).toMatch(/^2 projects in .* match model 'ContosoCore', so none was picked\./);
    expect(said).toContain('projectPath');
    expect(said).not.toMatch(/could not find|no \.rnrproj/i);
  });

  it('says no project exists when none matches', async () => {
    await project('Other', 'FabrikamTools.rnrproj');

    const said = await ProjectFileFinder.describeNoProject(root, 'ContosoCore');

    expect(said).toMatch(/^No \.rnrproj for model 'ContosoCore' in /);
    expect(said).toContain('projectPath');
  });
});
