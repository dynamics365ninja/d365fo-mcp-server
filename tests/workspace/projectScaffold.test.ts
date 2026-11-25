import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  scaffoldProject, ScaffoldError, validateProjectName, parseSolutionProjects,
  addProjectToSolutionText, inferProjectsRoot, looksLikeProjectsRoot,
} from '../../src/workspace/projectScaffold.js';
import { ProjectFileManager } from '../../src/workspace/projectFile.js';

// A solution as VS writes it: BOM, CRLF, a leading blank line, one project.
const EXISTING_SLN = '﻿' + [
  '',
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  '# Visual Studio Version 17',
  'VisualStudioVersion = 17.9.34728.123',
  'MinimumVisualStudioVersion = 10.0.40219.1',
  'Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "T-001 (CUS) [ContosoInventory]", "T-001\\T-001.rnrproj", "{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661}"',
  'EndProject',
  'Global',
  '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
  '\t\tDebug|Any CPU = Debug|Any CPU',
  '\tEndGlobalSection',
  '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
  '\t\t{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
  '\t\t{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661}.Debug|Any CPU.Build.0 = Debug|Any CPU',
  '\tEndGlobalSection',
  '\tGlobalSection(SolutionProperties) = preSolution',
  '\t\tHideSolutionNode = FALSE',
  '\tEndGlobalSection',
  'EndGlobal',
  '',
].join('\r\n');

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function sharedRepo() {
  await fs.mkdir(path.join(root, 'T-001'));
  await fs.writeFile(path.join(root, 'T-001', 'T-001.rnrproj'), '<Project/>');
  await fs.writeFile(path.join(root, 'ContosoInventory.sln'), EXISTING_SLN, 'utf-8');
}

describe('validateProjectName', () => {
  it('accepts real project names', () => {
    for (const n of ['T-002-Example', 'T-003 Some Name', 'Proj_1.2', 'A(B)']) {
      expect(validateProjectName(n), n).toBeNull();
    }
  });
  it('rejects anything that could escape the folder or break the XML', () => {
    for (const n of ['', ' x', 'x ', '..\\evil', 'a/b', 'a<b', 'a&b', '-lead', 'trail.', 'CON', 'x'.repeat(101)]) {
      expect(validateProjectName(n), JSON.stringify(n)).not.toBeNull();
    }
  });
});

describe('addProjectToSolutionText', () => {
  it('adds the project block and both configuration lines, preserving CRLF', () => {
    const out = addProjectToSolutionText(EXISTING_SLN.slice(1), {
      displayName: 'C-1', relPath: 'C-1\\C-1.rnrproj', guid: '{AAAAAAAA-0000-0000-0000-000000000001}', dependsOnGuids: [],
    });
    expect(parseSolutionProjects(out).map(p => p.name)).toEqual(['T-001 (CUS) [ContosoInventory]', 'C-1']);
    expect(out).toContain('{AAAAAAAA-0000-0000-0000-000000000001}.Debug|Any CPU.ActiveCfg = Debug|Any CPU');
    expect(out).toContain('{AAAAAAAA-0000-0000-0000-000000000001}.Debug|Any CPU.Build.0 = Debug|Any CPU');
    expect(out).not.toMatch(/[^\r]\n/);
    // Project entries stay before Global; the config lines stay inside their section.
    expect(out.indexOf('"C-1"')).toBeLessThan(out.indexOf('\r\nGlobal'));
    const cfg = out.slice(out.indexOf('ProjectConfigurationPlatforms'), out.indexOf('SolutionProperties'));
    expect(cfg).toContain('{AAAAAAAA-0000-0000-0000-000000000001}.Debug|Any CPU.Build.0');
  });

  // 7 of the 115 solutions in a real 187-project repo also declare Release; a project
  // given only the Debug pair is unconfigured there. The mapping is the sibling's:
  // those repos split between Release -> Release|Any CPU and Release -> Debug|Any CPU.
  it('configures the new project for every solution configuration, mapped like its sibling', () => {
    const withRelease = EXISTING_SLN.slice(1)
      .replace('\t\tDebug|Any CPU = Debug|Any CPU', '\t\tDebug|Any CPU = Debug|Any CPU\r\n\t\tRelease|Any CPU = Release|Any CPU')
      .replace('.Debug|Any CPU.Build.0 = Debug|Any CPU',
        '.Debug|Any CPU.Build.0 = Debug|Any CPU\r\n\t\t{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661}.Release|Any CPU.ActiveCfg = Debug|Any CPU');
    const out = addProjectToSolutionText(withRelease, {
      displayName: 'C-1', relPath: 'C-1\\C-1.rnrproj', guid: '{AAAAAAAA-0000-0000-0000-000000000001}', dependsOnGuids: [],
    });
    expect(out).toContain('{AAAAAAAA-0000-0000-0000-000000000001}.Debug|Any CPU.Build.0 = Debug|Any CPU');
    expect(out).toContain('{AAAAAAAA-0000-0000-0000-000000000001}.Release|Any CPU.ActiveCfg = Debug|Any CPU');
    // The sibling is not built in Release, so neither is the new project.
    expect(out).not.toContain('{AAAAAAAA-0000-0000-0000-000000000001}.Release|Any CPU.Build.0');
  });

  it('writes dependencies as a ProjectSection in the .sln', () => {
    const out = addProjectToSolutionText(EXISTING_SLN.slice(1), {
      displayName: 'C-1', relPath: 'C-1\\C-1.rnrproj', guid: '{AAAAAAAA-0000-0000-0000-000000000001}',
      dependsOnGuids: ['{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661}'],
    });
    expect(out).toContain('ProjectSection(ProjectDependencies) = postProject');
    expect(out).toContain('\t\t{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661} = {2F5073BA-ECD9-4907-A3DC-8D6CC8DCF661}');
  });
});

describe('scaffoldProject — shared solution', () => {
  it('creates the project and registers it, keeping the solution BOM and existing entries', async () => {
    await sharedRepo();
    const r = await scaffoldProject({
      projectName: 'T-002-Foo', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto',
      dependsOn: ['T-001'],
    });
    expect(r.solutionMode).toBe('shared');
    const proj = await fs.readFile(r.projectPath, 'utf-8');
    expect(proj).toContain('<Model>ContosoInventory</Model>');
    expect(proj).toContain('<Name>T-002-Foo</Name>');

    const sln = await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8');
    expect(sln.charCodeAt(0)).toBe(0xFEFF);
    const projects = parseSolutionProjects(sln.slice(1));
    expect(projects.map(p => p.relPath)).toEqual(['T-001\\T-001.rnrproj', 'T-002-Foo\\T-002-Foo.rnrproj']);
    expect(sln).toContain('ProjectSection(ProjectDependencies)');
  });

  it('a template it cannot fill stops before anything is written', async () => {
    await sharedRepo();
    const before = await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8');
    const template = {
      text: '<Project>\n  <PropertyGroup>\n    <X>$NewThing$</X>\n  </PropertyGroup>\n</Project>',
      source: 'visual-studio' as const, warnings: [], info: [],
    };
    await expect(scaffoldProject({
      projectName: 'T-002', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto', template,
    })).rejects.toThrow(ScaffoldError);
    await expect(fs.access(path.join(root, 'T-002'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8')).toBe(before);
  });

  it('two projects created in a row both land in the solution', async () => {
    await sharedRepo();
    const base = { modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto' as const };
    await Promise.all([
      scaffoldProject({ ...base, projectName: 'P-1' }),
      scaffoldProject({ ...base, projectName: 'P-2' }),
    ]);
    const names = parseSolutionProjects(await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8')).map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['P-1', 'P-2']));
  });

  it('a new project accepts entries through ProjectFileManager.addToProject', async () => {
    await sharedRepo();
    const r = await scaffoldProject({ projectName: 'P-1', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto' });
    const added = await new ProjectFileManager().addToProject(r.projectPath, 'class', 'ContosoHelper', '');
    expect(added).toBe(true);
    const xml = await fs.readFile(r.projectPath, 'utf-8');
    expect(xml.charCodeAt(0)).toBe(0xFEFF);
    expect(xml).toContain('AxClass\\ContosoHelper');
    expect(xml).toContain('Microsoft.Dynamics.Framework.Tools.BuildTasks');
  });

  it('refuses an unknown dependency, an existing project and writes nothing', async () => {
    await sharedRepo();
    await expect(scaffoldProject({
      projectName: 'P-1', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto', dependsOn: ['Nope'],
    })).rejects.toThrow(/not in ContosoInventory\.sln/);
    await expect(fs.access(path.join(root, 'P-1'))).rejects.toThrow();

    await expect(scaffoldProject({
      projectName: 'T-001', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto',
    })).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8')).toBe(EXISTING_SLN);
  });

  it('refuses a dependsOn that matches more than one project, instead of taking the first', async () => {
    await sharedRepo();
    // "T-001" is neither project's display name nor file stem, only a prefix of both names.
    const sln = EXISTING_SLN.replace('"T-001\\T-001.rnrproj"', '"New\\New.rnrproj"').replace('EndProject', 'EndProject\r\n' +
      'Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "T-001 (old)", "Old\\Old.rnrproj", "{2F5073BA-ECD9-4907-A3DC-8D6CC8DCF662}"\r\nEndProject');
    await fs.writeFile(path.join(root, 'ContosoInventory.sln'), sln, 'utf-8');
    await expect(scaffoldProject({
      projectName: 'P-1', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto', dependsOn: ['T-001'],
    })).rejects.toThrow(/matches 2 projects/);
    expect(await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8')).toBe(sln);
  });

  it('refuses a displayName that would break out of its .sln line, and writes nothing', async () => {
    await sharedRepo();
    for (const displayName of ['A", "..\\..\\evil.rnrproj', 'A\r\nEndProject']) {
      await expect(scaffoldProject({
        projectName: 'P-1', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto', displayName,
      })).rejects.toThrow(/displayName/);
    }
    await expect(fs.access(path.join(root, 'P-1'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'ContosoInventory.sln'), 'utf-8')).toBe(EXISTING_SLN);
  });

  it('asks for solutionFile when several solutions sit in the folder', async () => {
    await sharedRepo();
    await fs.writeFile(path.join(root, 'Other.sln'), EXISTING_SLN, 'utf-8');
    await expect(scaffoldProject({
      projectName: 'P-1', modelName: 'ContosoInventory', projectsRoot: root, solutionMode: 'auto',
    })).rejects.toThrow(/pass solutionFile/);
  });
});

describe('scaffoldProject — other layouts', () => {
  it('per-project: creates a solution beside the project', async () => {
    await fs.mkdir(path.join(root, 'Old'));
    await fs.writeFile(path.join(root, 'Old', 'Old.sln'), EXISTING_SLN, 'utf-8');
    const r = await scaffoldProject({ projectName: 'New-1', modelName: 'M', projectsRoot: root, solutionMode: 'auto' });
    expect(r.solutionMode).toBe('per-project');
    expect(r.solutionPath).toBe(path.join(root, 'New-1', 'New-1.sln'));
    const sln = await fs.readFile(r.solutionPath!, 'utf-8');
    expect(parseSolutionProjects(sln).map(p => p.relPath)).toEqual(['New-1.rnrproj']);
    expect(sln).toContain(`${r.projectGuid}.Debug|Any CPU.Build.0`);
  });

  it('an undecidable layout stops before writing anything', async () => {
    await fs.mkdir(path.join(root, 'Old'));
    await fs.writeFile(path.join(root, 'Old', 'Old.rnrproj'), '<Project/>');
    await expect(scaffoldProject({
      projectName: 'New-1', modelName: 'M', projectsRoot: root, solutionMode: 'auto',
    })).rejects.toBeInstanceOf(ScaffoldError);
    await expect(fs.access(path.join(root, 'New-1'))).rejects.toThrow();
  });

  it('none: only the .rnrproj', async () => {
    const r = await scaffoldProject({ projectName: 'Solo', modelName: 'M', projectsRoot: root, solutionMode: 'none' });
    expect(r.solutionPath).toBeNull();
    expect(r.written).toEqual([r.projectPath]);
  });

  it('dependsOn needs a shared solution', async () => {
    await expect(scaffoldProject({
      projectName: 'Solo', modelName: 'M', projectsRoot: root, solutionMode: 'none', dependsOn: ['X'],
    })).rejects.toThrow(/only with a shared solution/);
  });
});

describe('root handling', () => {
  it('infers the projects folder from where the model\'s projects already live', () => {
    const p = (n: string) => path.join('R', 'Projects', 'M', n, `${n}.rnrproj`);
    expect(inferProjectsRoot([p('A'), p('B'), path.join('Elsewhere', 'X', 'X.rnrproj')]))
      .toBe(path.join('R', 'Projects', 'M'));
    expect(inferProjectsRoot([])).toBeNull();
  });

  it('only a folder that already looks like a projects folder is accepted', async () => {
    expect(await looksLikeProjectsRoot(root)).toBe(false);
    await sharedRepo();
    expect(await looksLikeProjectsRoot(root)).toBe(true);
  });
});
