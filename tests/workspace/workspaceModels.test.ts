/**
 * A workspace develops a SET of models, not one (#1332).
 *
 * The model of the workspace's project used to be the only model it could write
 * into without a refusal or a warning, and the only project anything was
 * registered in. A test model next to it, or a solution split across several
 * models, then either got refused, got a note telling the agent to undo correct
 * work, or had its objects registered into the main model's project, whose build
 * fails on an element of a model it does not build.
 *
 * These tests use real files: the solution and the projects are what the
 * feature reads, and a mocked read would only restate the implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSolutionProjects,
  refreshWorkspaceModels,
  resetWorkspaceModelsCache,
  isWorkspaceModel,
  workspaceModels,
  resolveProjectForModel,
  describeProjectMismatch,
} from '../../src/workspace/workspaceModels';
import { crossModelWriteRefusal, standDownNotice } from '../../src/utils/crossModelWriteGuard';

let root: string;
let main: string;
let tests: string;

function project(dir: string, name: string, model: string): string {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.rnrproj`);
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="utf-8"?>\r\n<Project>\r\n  <PropertyGroup>\r\n    <Model>${model}</Model>\r\n  </PropertyGroup>\r\n</Project>\r\n`,
  );
  return file;
}

/** A .sln in the shape Visual Studio writes, listing `projects` relative to `dir`. */
function solution(dir: string, name: string, projects: string[]): string {
  const file = path.join(dir, `${name}.sln`);
  const entries = projects.map((p, i) => {
    const rel = path.relative(dir, p).split(path.sep).join('\\');
    const stem = path.basename(p, '.rnrproj');
    return `Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "${stem}", "${rel}", "{00000000-0000-0000-0000-00000000000${i}}"\r\nEndProject\r\n`;
  });
  fs.writeFileSync(file, `\r\nMicrosoft Visual Studio Solution File, Format Version 12.00\r\n${entries.join('')}Global\r\nEndGlobal\r\n`);
  return file;
}

/** A ConfigManager stand-in: the project the server detected, and nothing switched. */
const cm = (detected: string | null, extra: Record<string, unknown> = {}) => ({
  getServerDetectedProject: () => (detected ? { projectPath: detected } : null),
  getConfiguredProjectPath: () => undefined,
  getWriteAnchorModel: () => 'ContosoCore',
  getProjectsForModel: () => [] as string[],
  ...extra,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmodels-'));
  main = project(root, 'ContosoCore', 'ContosoCore');
  tests = project(root, 'ContosoCoreTests', 'ContosoCoreTests');
  resetWorkspaceModelsCache();
  delete process.env.D365FO_WORKSPACE_MODELS;
  delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS;
  delete process.env.D365FO_ALLOW_CROSS_MODEL_WRITE;
  delete process.env.D365FO_SOLUTION_PATH;
});

afterEach(() => {
  resetWorkspaceModelsCache();
  delete process.env.D365FO_WORKSPACE_MODELS;
  delete process.env.D365FO_SOLUTION_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseSolutionProjects', () => {
  it('reads the .rnrproj entries of a .sln, relative to its folder, and skips other project types', () => {
    const sln = path.join(root, 'X.sln');
    const text =
      'Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "ContosoCore", "ContosoCore\\ContosoCore.rnrproj", "{A}"\r\nEndProject\r\n' +
      'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Tool", "Tool\\Tool.csproj", "{B}"\r\nEndProject\r\n';

    expect(parseSolutionProjects(sln, text)).toEqual([path.join(root, 'ContosoCore', 'ContosoCore.rnrproj')]);
  });

  it('reads the .slnx format too', () => {
    const slnx = path.join(root, 'X.slnx');
    const text = '<Solution>\n  <Project Path="ContosoCoreTests/ContosoCoreTests.rnrproj" />\n  <Project Path="Tool/Tool.csproj" />\n</Solution>\n';

    expect(parseSolutionProjects(slnx, text)).toEqual([path.join(root, 'ContosoCoreTests', 'ContosoCoreTests.rnrproj')]);
  });
});

describe('the models a workspace develops', () => {
  it('counts every model of the detected project\'s solution', async () => {
    solution(root, 'Contoso', [main, tests]);

    await refreshWorkspaceModels(cm(main));

    expect(isWorkspaceModel('ContosoCoreTests')).toBe(true);
    expect(isWorkspaceModel('contosocoretests')).toBe(true);
    expect(workspaceModels('ContosoCore')).toEqual([
      { name: 'ContosoCore', source: 'anchor' },
      { name: 'ContosoCoreTests', source: 'solution' },
    ]);
  });

  it('ignores a solution next door that does not list the workspace\'s project', async () => {
    const other = project(root, 'ContosoOther', 'ContosoOther');
    solution(root, 'Contoso', [main]);
    solution(root, 'Other', [other]);

    await refreshWorkspaceModels(cm(main));

    expect(isWorkspaceModel('ContosoOther')).toBe(false);
  });

  it('never reads the solution from a project a tool call switched to', async () => {
    const other = project(root, 'ContosoOther', 'ContosoOther');
    solution(root, 'Other', [other, tests]);

    // getServerDetectedProject is null after a switch: nothing to widen the set with.
    await refreshWorkspaceModels(cm(null));

    expect(isWorkspaceModel('ContosoCoreTests')).toBe(false);
  });

  it('picks up a project added to the solution without a restart', async () => {
    const sln = solution(root, 'Contoso', [main]);
    await refreshWorkspaceModels(cm(main));
    expect(isWorkspaceModel('ContosoCoreTests')).toBe(false);

    fs.writeFileSync(sln, fs.readFileSync(sln, 'utf-8') +
      'Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "ContosoCoreTests", "ContosoCoreTests\\ContosoCoreTests.rnrproj", "{C}"\r\nEndProject\r\n');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(sln, future, future);
    await refreshWorkspaceModels(cm(main));

    expect(isWorkspaceModel('ContosoCoreTests')).toBe(true);
  });

  it('counts the models listed in workspace.models and in the older env name', () => {
    process.env.D365FO_WORKSPACE_MODELS = 'ContosoCoreTests';
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'ContosoExt';

    expect(isWorkspaceModel('ContosoCoreTests')).toBe(true);
    expect(isWorkspaceModel('ContosoExt')).toBe(true);
    expect(isWorkspaceModel('ContosoOther')).toBe(false);
  });
});

describe('the cross-model guard and the workspace\'s models', () => {
  const write = (owningModel: string) => ({
    objectName: 'ContosoCoreTaxTest',
    objectType: 'class',
    owningModel,
    activeModel: 'ContosoCore',
    action: 'create' as const,
  });

  it('neither refuses nor flags a write into a model of the solution', async () => {
    solution(root, 'Contoso', [main, tests]);
    await refreshWorkspaceModels(cm(main));

    expect(crossModelWriteRefusal(write('ContosoCoreTests'))).toBeNull();
    expect(standDownNotice(write('ContosoCoreTests'))).toBe('');
  });

  it('still refuses a model the workspace does not develop, naming the ones it does', async () => {
    solution(root, 'Contoso', [main, tests]);
    await refreshWorkspaceModels(cm(main));

    const msg = crossModelWriteRefusal(write('ContosoOther'))!;

    expect(msg).toContain('Refusing to create "ContosoCoreTaxTest" in model "ContosoOther"');
    expect(msg).toContain('this workspace develops "ContosoCore", "ContosoCoreTests"');
    // A NEW class has nothing to extend: the remedy is the model it belongs in.
    expect(msg).toContain('modelName="ContosoCore" or modelName="ContosoCoreTests"');
    expect(msg).not.toContain('Extend it from');
    expect(msg).toContain('`workspace.models`');
  });
});

describe('resolveProjectForModel', () => {
  it('keeps the active project when it builds the object\'s model', async () => {
    const r = await resolveProjectForModel('ContosoCore', main);

    expect(r).toMatchObject({ projectPath: main, rerouted: false });
  });

  it('moves an object of the test model to the test model\'s project', async () => {
    solution(root, 'Contoso', [main, tests]);
    await refreshWorkspaceModels(cm(main));

    const r = await resolveProjectForModel('ContosoCoreTests', main);

    expect(r.projectPath).toBe(tests);
    expect(r.rerouted).toBe(true);
    expect(describeProjectMismatch('ContosoCoreTests', r)).toContain('not to ContosoCore.rnrproj');
  });

  it('registers nowhere, and says why, when the model has no project to go to', async () => {
    const r = await resolveProjectForModel('ContosoCoreTests', main);

    expect(r.projectPath).toBeUndefined();
    expect(describeProjectMismatch('ContosoCoreTests', r)).toMatch(/not added to ContosoCore\.rnrproj: that project builds model "ContosoCore"/);
  });

  it('does not guess between several projects of the model', async () => {
    const tests2 = project(path.join(root, 'more'), 'ContosoCoreTests2', 'ContosoCoreTests');
    solution(root, 'Contoso', [main, tests, tests2]);
    await refreshWorkspaceModels(cm(main));

    const r = await resolveProjectForModel('ContosoCoreTests', main);

    expect(r.projectPath).toBeUndefined();
    expect(r.ambiguous).toHaveLength(2);
    expect(describeProjectMismatch('ContosoCoreTests', r)).toContain('pass projectPath');
  });

  it('finds the model\'s project through the solutions scan too', async () => {
    const r = await resolveProjectForModel('ContosoCoreTests', main, { getProjectsForModel: () => [tests] });

    expect(r.projectPath).toBe(tests);
  });
});
