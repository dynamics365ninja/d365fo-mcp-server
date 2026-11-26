import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { d365foFileTool, D365_FILE_ACTIONS } from '../../src/tools/d365foFile.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';
import { d365foFileTool as publishedSchema } from '../../src/server/toolSchemas/d365foFile.js';
import { getConfigManager } from '../../src/utils/configManager.js';

let root: string;
beforeEach(async () => {
  registerCustomModel('ContosoCore');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'create-project-'));
  await fs.mkdir(path.join(root, 'T-001'));
  await fs.writeFile(path.join(root, 'T-001', 'T-001.rnrproj'), '<Project/>');
  await fs.writeFile(path.join(root, 'ContosoCore.sln'),
    'Microsoft Visual Studio Solution File, Format Version 12.00\r\nGlobal\r\nEndGlobal\r\n');
  // The temp folder stands in for a configured solution root (project-path containment).
  getConfigManager().setRuntimeContext({ solutionPath: root });
});
afterEach(async () => {
  getConfigManager().setRuntimeContext({ solutionPath: undefined });
  await fs.rm(root, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>) =>
  d365foFileTool({ method: 'tools/call', params: { name: 'd365fo_file', arguments: args } } as any, {} as any);

describe('d365fo_file(action="project", operation="create")', () => {
  it('is published in the schema and accepted by the dispatcher', () => {
    expect(D365_FILE_ACTIONS).toContain('project');
    expect((publishedSchema.inputSchema.properties.action as any).enum).toContain('project');
  });

  it('creates the project and registers it, with params nested as the schema advertises', async () => {
    const r: any = await call({
      action: 'project',
      params: { operation: 'create', projectName: 'T-002-New', modelName: 'ContosoCore', projectsRoot: root, activate: false },
    });
    expect(r.isError, r.content[0].text).toBeFalsy();
    // tests/setup.ts makes every test use the built-in template.
    expect(r.content[0].text).toContain('template: built-in (no Finance and Operations extension found in Visual Studio)');
    const rnrproj = await fs.readFile(path.join(root, 'T-002-New', 'T-002-New.rnrproj'), 'utf-8');
    expect(rnrproj).toContain('<Model>ContosoCore</Model>');
    expect(await fs.readFile(path.join(root, 'ContosoCore.sln'), 'utf-8')).toContain(String.raw`T-002-New\T-002-New.rnrproj`);
  });

  it('refuses an invalid name with an actionable error', async () => {
    const r: any = await call({
      action: 'project',
      params: { operation: 'create', projectName: '..\\evil', modelName: 'ContosoCore', projectsRoot: root, activate: false },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('projectName');
  });

  it('refuses a folder that is not a projects folder', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'not-projects-'));
    // Inside a configured root, so the refusal below is the projects-folder check's.
    getConfigManager().setRuntimeContext({ solutionPath: empty });
    try {
      const r: any = await call({
        action: 'project',
        params: { operation: 'create', projectName: 'X-1', modelName: 'ContosoCore', projectsRoot: empty, activate: false },
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('does not look like a projects folder');
      expect(await fs.readdir(empty)).toEqual([]);
    } finally { await fs.rm(empty, { recursive: true, force: true }); }
  });
});

// activate (the default) once went through setRuntimeContext, which treats an unseen
// projectPath as a workspace move: it dropped the detected project — the model read
// null right after the create — and the write anchor with it, so a project made for
// another model let the next create write there unchecked. Every other test here
// passes activate:false, which is how that went unnoticed.
describe('d365fo_file(action="project", operation="create") — activation', () => {
  const cfg: any = getConfigManager();
  let saved: Record<string, unknown>;
  beforeEach(async () => {
    await cfg.ensureLoaded();
    saved = {
      autoDetectedProject: cfg.autoDetectedProject, autoDetectionAttempted: cfg.autoDetectionAttempted,
      toolForcedProject: cfg.toolForcedProject, runtimeContext: cfg.runtimeContext,
    };
    const old = { modelName: 'ContosoCore', projectPath: path.join(root, 'T-001', 'T-001.rnrproj'), solutionPath: root };
    cfg.runtimeContext = { ...cfg.runtimeContext, projectPath: undefined, modelName: undefined };
    cfg.autoDetectedProject = old;
    cfg.autoDetectionAttempted = true;
    cfg.toolForcedProject = null;
  });
  afterEach(() => { Object.assign(cfg, saved); });

  it('makes the new project active and keeps the model it builds', async () => {
    const r: any = await call({ action: 'project', params: { operation: 'create', projectName: 'T-003', modelName: 'ContosoCore', projectsRoot: root } });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('now the active project');
    expect(path.resolve((await cfg.getProjectPath())!)).toBe(path.resolve(root, 'T-003', 'T-003.rnrproj'));
    expect(cfg.getModelName()).toBe('ContosoCore');
    expect(cfg.getToolProjectSwitch()).toBeNull();
  });

  it('a project for another model keeps the write anchor on the workspace model', async () => {
    registerCustomModel('ContosoOther');
    const r: any = await call({ action: 'project', params: { operation: 'create', projectName: 'T-004', modelName: 'ContosoOther', projectsRoot: root } });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(cfg.getModelName()).toBe('ContosoOther');
    expect(cfg.getToolProjectSwitch()).toEqual({ anchorModel: 'ContosoCore', forcedModel: 'ContosoOther' });
    expect(cfg.getWriteAnchorModel()).toBe('ContosoCore');
  });
});
