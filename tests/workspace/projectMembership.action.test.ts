import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The file lookup resolves against a model tree; point it at a temp one.
const found = new Map<string, string>();
const lookedUpIn: Array<string | undefined> = [];
vi.mock('../../src/utils/objectFileLookup.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/objectFileLookup.js')>()),
  findD365FileOnDisk: async (type: string, name: string, model?: string) => {
    lookedUpIn.push(model);
    return found.get(`${type}:${name}`) ?? null;
  },
}));

import { d365foFileTool } from '../../src/tools/d365foFile.js';
import { scaffoldProject } from '../../src/workspace/projectScaffold.js';
import { readProjectIncludes } from '../../src/workspace/projectMembership.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';
import { getConfigManager } from '../../src/utils/configManager.js';

const SLN = 'Microsoft Visual Studio Solution File, Format Version 12.00\r\nGlobal\r\nEndGlobal\r\n';

let root: string;
let a: string;
let b: string;

beforeEach(async () => {
  registerCustomModel('ContosoCore');
  found.clear();
  lookedUpIn.length = 0;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'membership-'));
  await fs.writeFile(path.join(root, 'ContosoCore.sln'), SLN);
  await fs.mkdir(path.join(root, 'T-000'));
  await fs.writeFile(path.join(root, 'T-000', 'T-000.rnrproj'), '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"/>');
  a = (await scaffoldProject({ projectName: 'T-001', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'shared' })).projectPath;
  b = (await scaffoldProject({ projectName: 'T-002', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'shared' })).projectPath;
  found.set('class:CtsoHelper', path.join(root, 'CtsoHelper.xml'));
  // The temp folder stands in for a configured solution root (project-path containment).
  getConfigManager().setRuntimeContext({ solutionPath: root });
});
afterEach(async () => {
  getConfigManager().setRuntimeContext({ solutionPath: undefined });
  await fs.rm(root, { recursive: true, force: true });
});

const call = (operation: string, params: Record<string, unknown>) =>
  d365foFileTool({
    method: 'tools/call',
    params: { name: 'd365fo_file', arguments: { action: 'project', params: { operation, modelName: 'ContosoCore', ...params } } },
  } as any, {} as any) as Promise<any>;

const has = async (project: string, include: string) => (await readProjectIncludes(project)).has(include.toLowerCase());

describe('d365fo_file(action="project") operations', () => {
  // A project holds objects of its own <Model> only: registering one from another
  // model fails the VS build. The configured model is not that model in general —
  // a project just created for another model is the common case.
  it('looks objects up in the model the project builds, and refuses a different modelName', async () => {
    const other = (await scaffoldProject({ projectName: 'T-009', modelName: 'ContosoOther', projectsRoot: root, solutionMode: 'shared' })).projectPath;
    const d365 = (params: Record<string, unknown>) => d365foFileTool({
      method: 'tools/call',
      params: { name: 'd365fo_file', arguments: { action: 'project', params: { operation: 'add-object', ...params } } },
    } as any, {} as any) as Promise<any>;

    const r = await d365({ projectPath: other, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(lookedUpIn).toEqual(['ContosoOther']);

    const wrong = await d365({ projectPath: other, modelName: 'ContosoCore', objectType: 'class', objectName: 'CtsoHelper' });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toContain('builds model ContosoOther');
  });


  it('add-object registers an existing object; a second add reports it is already there', async () => {
    const r = await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('added');
    expect(await has(a, 'axclass\\ctsohelper')).toBe(true);
    expect((await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' })).content[0].text)
      .toContain('already in the project');
  });

  it('add-object refuses an object with no file on disk, and still handles the rest of the batch', async () => {
    const r = await call('add-object', {
      projectPath: a,
      objects: [{ objectType: 'class', objectName: 'Ghost' }, { objectType: 'class', objectName: 'CtsoHelper' }],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('no such file on disk');
    expect(await has(a, 'axclass\\ctsohelper')).toBe(true);
  });

  it('remove-object refuses the last reference unless allowOrphan is set', async () => {
    await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    const refused = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(refused.isError).toBe(true);
    expect(await has(a, 'axclass\\ctsohelper')).toBe(true);

    const ok = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper', allowOrphan: true });
    expect(ok.isError, ok.content[0].text).toBeFalsy();
    expect(await has(a, 'axclass\\ctsohelper')).toBe(false);
  });

  it('remove-object leaves the file alone and needs no override when another project lists it', async () => {
    await fs.writeFile(found.get('class:CtsoHelper')!, '<x/>');
    await call('add-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    await call('add-object', { projectPath: b, objectType: 'class', objectName: 'CtsoHelper' });
    const r = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(await has(a, 'axclass\\ctsohelper')).toBe(false);
    expect(await has(b, 'axclass\\ctsohelper')).toBe(true);
    await expect(fs.access(found.get('class:CtsoHelper')!)).resolves.toBeUndefined();
  });

  it('reports an object that is not in the project instead of failing', async () => {
    const r = await call('remove-object', { projectPath: a, objectType: 'class', objectName: 'CtsoHelper' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('not in the project');
  });

  it('refuses an explicit project that no solution lists', async () => {
    // Inside the configured root, so the refusal is the solution-listing check's.
    const stray = path.join(root, 'stray');
    await fs.mkdir(stray);
    try {
      const file = path.join(stray, 'Z.rnrproj');
      await fs.writeFile(file, '<Project/>');
      const r = await call('add-object', { projectPath: file, objectType: 'class', objectName: 'CtsoHelper' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('not listed in a solution beside it');
    } finally { await fs.rm(stray, { recursive: true, force: true }); }
  });

  it('rejects an unknown objectType and an unknown operation', async () => {
    expect((await call('add-object', { projectPath: a, objectType: 'nope', objectName: 'X' })).isError).toBe(true);
    const r = await call('rename', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('create | delete | add-object | remove-object');
  });
});

describe('label files and the active project', () => {
  async function labelTree(langs: string[]) {
    const pkg = path.join(root, 'pkgs');
    const model = path.join(pkg, 'ContosoCore', 'ContosoCore');
    await fs.mkdir(path.join(pkg, 'ContosoCore', 'Descriptor'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'ContosoCore', 'Descriptor', 'ContosoCore.xml'),
      '<AxModelInfo><Name>ContosoCore</Name><ModelModule>ContosoCore</ModelModule></AxModelInfo>');
    await fs.mkdir(path.join(model, 'AxLabelFile'), { recursive: true });
    for (const l of langs) await fs.writeFile(path.join(model, 'AxLabelFile', `ContosoProj_${l}.xml`), '<x/>');
    return pkg;
  }

  it('add-object registers a label file with the languages found on disk', async () => {
    const pkg = await labelTree(['en-US', 'fi']);
    const r = await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    expect(r.isError, r.content[0].text).toBeFalsy();
    const xml = await fs.readFile(a, 'utf-8');
    for (const l of ['en-US', 'fi']) {
      expect(xml).toContain(`AxLabelFile\\ContosoProj_${l}`);
      expect(xml).toContain(`ContosoProj.${l}.label.txt`);
    }
    expect((await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg }))
      .content[0].text).toContain('already in the project');
  });

  it('checks an explicit languages list against the files on disk', async () => {
    const pkg = await labelTree(['en-US', 'fi']);
    // A language with no file used to be written into the project, failing the VS build later.
    const bogus = await call('add-object', {
      projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg, languages: ['en-US', 'de'],
    });
    expect(bogus.isError).toBe(true);
    expect(bogus.content[0].text).toContain('ContosoProj_<lang>.xml for de');
    expect(await fs.readFile(a, 'utf-8')).not.toContain('AxLabelFile\\ContosoProj_');
    // A listed language that exists is added alone, spelled as on disk.
    const one = await call('add-object', {
      projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg, languages: ['EN-us'],
    });
    expect(one.isError, one.content[0].text).toBeFalsy();
    const xml = await fs.readFile(a, 'utf-8');
    expect(xml).toContain('AxLabelFile\\ContosoProj_en-US');
    expect(xml).not.toContain('AxLabelFile\\ContosoProj_fi');
  });

  it('reports a label file with no descriptors, and one the project does not list', async () => {
    const pkg = await labelTree([]);
    const none = await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain('no label descriptor files');
    const gone = await call('remove-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj' });
    expect(gone.isError).toBeFalsy();
    expect(gone.content[0].text).toContain('not in the project');
  });

  // remove-object used to answer "label-file removal is not supported", so moving a
  // feature's objects to another project of the model left its label files behind.
  it('remove-object unregisters a label file listed by another project too, files untouched', async () => {
    const pkg = await labelTree(['en-US', 'fi']);
    for (const p of [a, b]) await call('add-object', { projectPath: p, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    const r = await call('remove-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('removed (en-US, fi, files untouched)');
    const xml = await fs.readFile(a, 'utf-8');
    expect(xml).not.toContain('ContosoProj');
    expect(xml).toContain('Label Files\\');
    expect(await has(b, 'AxLabelFile\\ContosoProj_en-US')).toBe(true);
    expect(await has(b, 'ContosoProj.fi.label.txt')).toBe(true);
    const files = await fs.readdir(path.join(pkg, 'ContosoCore', 'ContosoCore', 'AxLabelFile'));
    expect(files.sort()).toEqual(['ContosoProj_en-US.xml', 'ContosoProj_fi.xml']);
  });

  it('remove-object refuses the last reference to a label file unless allowOrphan is set', async () => {
    const pkg = await labelTree(['en-US']);
    await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    const refused = await call('remove-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text.toLowerCase()).toContain('the only project referencing it (en-us)');
    expect(await has(a, 'AxLabelFile\\ContosoProj_en-US')).toBe(true);

    const ok = await call('remove-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', allowOrphan: true });
    expect(ok.isError, ok.content[0].text).toBeFalsy();
    expect(await has(a, 'AxLabelFile\\ContosoProj_en-US')).toBe(false);
    expect(await has(a, 'ContosoProj.en-US.label.txt')).toBe(false);
  });

  // Stacked on the text-edit writer (#1289): a removal must take out only its own lines.
  it('remove-object of a label file leaves every other byte of the project as it was', async () => {
    const pkg = await labelTree(['en-US']);
    const before = await fs.readFile(b, 'utf-8');
    await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    await call('add-object', { projectPath: b, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    const withLabel = await fs.readFile(b, 'utf-8');
    expect(withLabel).not.toBe(before);
    const r = await call('remove-object', { projectPath: b, objectType: 'label-file', objectName: 'ContosoProj' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    const after = await fs.readFile(b, 'utf-8');
    // Only the "Label Files\" folder entry (kept on purpose) may differ from the original.
    expect(after.replace(/^[ \t]*<ItemGroup>\r?\n[ \t]*<Folder Include="Label Files\\" \/>\r?\n[ \t]*<\/ItemGroup>\r?\n/m, '')).toBe(before);
  });

  it('remove-object with languages[] removes only those, and leaves a label file with a longer id alone', async () => {
    const pkg = await labelTree(['en-US', 'fi']);
    const model = path.join(pkg, 'ContosoCore', 'ContosoCore', 'AxLabelFile');
    await fs.writeFile(path.join(model, 'ContosoProj_Extra_en-US.xml'), '<x/>');
    await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', packagePath: pkg });
    await call('add-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj_Extra', packagePath: pkg });
    const r = await call('remove-object', {
      projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', languages: ['FI'], allowOrphan: true,
    });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('removed (fi,');
    expect(await has(a, 'AxLabelFile\\ContosoProj_fi')).toBe(false);
    expect(await has(a, 'ContosoProj.fi.label.txt')).toBe(false);
    expect(await has(a, 'AxLabelFile\\ContosoProj_en-US')).toBe(true);
    expect(await has(a, 'ContosoProj.en-US.label.txt')).toBe(true);

    const all = await call('remove-object', { projectPath: a, objectType: 'label-file', objectName: 'ContosoProj', allowOrphan: true });
    expect(all.content[0].text).toContain('removed (en-US,');
    expect(await has(a, 'AxLabelFile\\ContosoProj_Extra_en-US')).toBe(true);
    expect(await has(a, 'ContosoProj_Extra.en-US.label.txt')).toBe(true);
  });

  it('a project just created is the active one, so add-object needs no projectPath', async () => {
    // Activation goes through forceProject, which sets the detected project as well as
    // runtimeContext — restore all of it, or the next test inherits an active project.
    const cfg: any = getConfigManager();
    const saved = {
      autoDetectedProject: cfg.autoDetectedProject, autoDetectionAttempted: cfg.autoDetectionAttempted,
      toolForcedProject: cfg.toolForcedProject, runtimeContext: cfg.runtimeContext,
    };
    try {
      const made = await call('create', { projectName: 'T-003', projectsRoot: root });
      expect(made.isError, made.content[0].text).toBeFalsy();
      await fs.writeFile(found.get('class:CtsoHelper')!, '<x/>');
      const r = await call('add-object', { objectType: 'class', objectName: 'CtsoHelper' });
      expect(r.isError, r.content[0].text).toBeFalsy();
      expect(await has(path.join(root, 'T-003', 'T-003.rnrproj'), 'axclass\\ctsohelper')).toBe(true);
    } finally {
      Object.assign(cfg, saved);
    }
  });

  it('without an active project the error says how to recover', async () => {
    getConfigManager().setRuntimeContext({ projectPath: undefined });
    const r = await call('add-object', { objectType: 'class', objectName: 'CtsoHelper' });
    if (r.isError) expect(r.content[0].text).toContain('pass projectPath');
  });
});

describe('objectType "reference" — .NET assembly references', () => {
  const refs = async (project: string) =>
    [...(await fs.readFile(project, 'utf-8')).matchAll(/<Reference Include="([^"]*)"/g)].map(m => m[1]);

  it('add-object writes <Reference Include>, sorted, with no file lookup; a re-run reports it', async () => {
    const r = await call('add-object', { projectPath: a, objects: [
      { objectType: 'reference', objectName: 'System.Security' },
      { objectType: 'reference', objectName: 'System.Core' },
    ] });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(lookedUpIn).toEqual([]);
    expect(await refs(a)).toEqual(['System.Core', 'System.Security']);
    expect(await fs.readFile(a, 'utf-8')).toContain('<Reference Include="System.Security" />');
    const again = await call('add-object', { projectPath: a, objectType: 'reference', objectName: 'system.security' });
    expect(again.content[0].text).toContain('already in the project');
    expect(await refs(a)).toHaveLength(2);
  });

  it('treats a full assembly name as the same reference as its simple name', async () => {
    await call('add-object', { projectPath: a, objectType: 'reference', objectName: 'System.Security' });
    const r = await call('add-object', {
      projectPath: a, objectType: 'reference',
      objectName: 'System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a',
    });
    expect(r.content[0].text).toContain('already in the project');
  });

  it('remove-object removes it (no orphan check), and reports one that is not there', async () => {
    await call('add-object', { projectPath: a, objectType: 'reference', objectName: 'System.Security' });
    const r = await call('remove-object', { projectPath: a, objectType: 'reference', objectName: 'System.Security' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(await refs(a)).toEqual([]);
    expect((await call('remove-object', { projectPath: a, objectType: 'reference', objectName: 'System.Security' }))
      .content[0].text).toContain('not in the project');
  });

  it('refuses a name that is not an assembly name', async () => {
    const r = await call('add-object', { projectPath: a, objectType: 'reference', objectName: 'System Security"/>' });
    expect(r.isError).toBe(true);
    expect(await refs(a)).toEqual([]);
  });
});
