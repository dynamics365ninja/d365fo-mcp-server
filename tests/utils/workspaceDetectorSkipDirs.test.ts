/**
 * The .rnrproj walk never enters profile or system folders.
 *
 * The workspace it starts from is whatever the client reported — process.cwd()
 * when VS Code gives nothing better — and that has been C:\Users\<user> itself.
 * Five levels of AppData is hundreds of thousands of entries, walked on the
 * first tool call of the session to find nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { detectD365Project, isSkippedProjectWalkDir, scanAllD365Projects } from '../../src/utils/workspaceDetector';

const RNRPROJ = (model: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Project><Model>${model}</Model></Project>\n`;

async function makeProject(root: string, relDir: string, model: string): Promise<string> {
  const dir = path.join(root, relDir);
  await fs.mkdir(dir, { recursive: true });
  const projectPath = path.join(dir, `${model}.rnrproj`);
  await fs.writeFile(projectPath, RNRPROJ(model), 'utf-8');
  return projectPath;
}

const tempDirs: string[] = [];
async function makeProfile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'd365fo-skipdirs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map(d => fs.rm(d, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('isSkippedProjectWalkDir', () => {
  it('skips the profile, package-cache and system folders, case-insensitively', () => {
    for (const name of [
      'AppData', 'appdata', 'APPDATA', 'Application Data', 'Local Settings',
      '.nuget', '.npm', '.cache', '$Recycle.Bin', 'Windows', 'Program Files',
      'Program Files (x86)', 'ProgramData', 'System Volume Information',
      'node_modules', '.git', '.vs', 'PackagesLocalDirectory', 'AxClass', 'axtable',
    ]) {
      expect(isSkippedProjectWalkDir(name), name).toBe(true);
    }
  });

  it('still enters ordinary solution folders', () => {
    for (const name of ['source', 'repos', 'FMProofs', 'AutoSettle', 'Projects', 'Documents', 'Temp']) {
      expect(isSkippedProjectWalkDir(name), name).toBe(false);
    }
  });
});

describe('detectD365Project from a user-profile workspace', () => {
  it('finds the solution under source\\repos and ignores a project buried in AppData', async () => {
    const profile = await makeProfile();
    const real = await makeProject(profile, path.join('source', 'repos', 'FMProofs', 'AutoSettle'), 'FMProofs');
    // A leftover under AppData (an extension cache, a template) must not become
    // a candidate — with it, two custom models make the workspace ambiguous.
    await makeProject(profile, path.join('AppData', 'Local', 'SomeTool', 'Cache'), 'Stale');
    await makeProject(profile, path.join('Windows', 'Temp', 'x'), 'Stale2');

    const result = await detectD365Project(profile);
    expect(result?.projectPath).toBe(real);
    expect(result?.modelName).toBe('FMProofs');
  });

  it('keeps the skipped folders out of scanAllD365Projects too', async () => {
    const profile = await makeProfile();
    await makeProject(profile, path.join('source', 'repos', 'Contoso', 'Contoso'), 'Contoso');
    await makeProject(profile, path.join('AppData', 'Roaming', 'x'), 'Stale');

    const all = await scanAllD365Projects(profile);
    expect(all.map(p => p.modelName)).toEqual(['Contoso']);
  });
});
