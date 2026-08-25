/**
 * get_workspace_info must say WHICH state it is in, and answer the question it
 * was asked even when the argument it was given is refused.
 *
 * Two gaps this pins:
 *
 *  1. "(not detected)" reads as a broken configuration. When the solutions-path
 *     scan resolves the model and stops short of choosing between the projects
 *     that build it, nothing is broken — a choice is missing, and the names to
 *     choose from were recorded and then never printed. The agent's only route
 *     to them was a second call with diagnostics=true.
 *  2. A projectName that resolved to nothing returned the refusal ALONE. This is
 *     the first call of every session, and the parameter is one the agent is now
 *     told to pass from context, so a miss is expected traffic — and it cost the
 *     whole call, plus a round trip to ask again without the argument.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';

const MODEL = 'ContosoCore';
const CANDIDATES = [
  'K:\\solutions\\Contoso\\Core\\Contoso - Core.rnrproj',
  'K:\\solutions\\Contoso\\Fin\\Contoso - Fin.rnrproj',
  'K:\\solutions\\Contoso\\Whs\\Contoso - Whs.rnrproj',
];

/** Mutable so each test can set the state the tool is supposed to describe. */
const state = {
  projectPath: null as string | null,
  ambiguousProjects: [] as string[],
  allProjects: [] as { projectPath?: string; modelName: string }[],
  forceProjectResult: null as unknown,
};

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
    getRawAutoDetectedModelName: () => MODEL,
    getAllDetectedProjects: () => state.allProjects,
    getAmbiguousProjectPaths: () => state.ambiguousProjects,
    getToolProjectSwitch: () => null,
    getDevEnvironmentType: async () => 'local',
    getMicrosoftPackagesPath: async () => null,
    forceProject: async () => state.forceProjectResult,
    getWorkspaceInfoDiagnostics: async () => ({
      modelName: MODEL,
      modelSource: 'auto-detected from .rnrproj',
      isModelSourceAutoDetected: true,
      projectPath: state.projectPath,
      projectSource: state.projectPath ? 'auto-detected from .rnrproj' : 'not selected',
      ambiguousProjects: state.ambiguousProjects,
      packagePath: null,
      packageSource: 'test',
      customPackagesPath: 'K:\\repos\\Contoso',
      customPackagesSource: 'test',
    }),
  })),
}));

import { getWorkspaceInfoTool } from '../../src/tools/readers/getWorkspaceInfo.js';

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

const call = async (args: Record<string, unknown> = {}) => {
  const request: CallToolRequest = {
    method: 'tools/call',
    params: { name: 'get_workspace_info', arguments: args },
  };
  const result: any = await getWorkspaceInfoTool(request, buildContext());
  return { text: String(result.content[0].text), isError: result.isError === true };
};

const originalEnv = { ...process.env };

beforeEach(() => {
  state.projectPath = null;
  state.ambiguousProjects = [];
  state.allProjects = [];
  state.forceProjectResult = null;
  process.env.EXTENSION_PREFIX = 'CON';
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_NAMING_STYLE;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('get_workspace_info — no project selected', () => {
  it('distinguishes "not selected" from "not detected"', async () => {
    state.ambiguousProjects = CANDIDATES;
    state.allProjects = CANDIDATES.map(projectPath => ({ projectPath, modelName: MODEL }));

    const { text } = await call();

    expect(text).toContain('not selected');
    expect(text).toContain('3 projects build this model');
    expect(text).not.toContain('(not detected)');
  });

  it('names the projects to choose between, without a second diagnostics call', async () => {
    state.ambiguousProjects = CANDIDATES;
    state.allProjects = CANDIDATES.map(projectPath => ({ projectPath, modelName: MODEL }));

    const { text } = await call();

    expect(text).toContain('Contoso - Core');
    expect(text).toContain('Contoso - Fin');
    expect(text).toContain('Contoso - Whs');
  });

  it('does not count an active project that does not exist', async () => {
    // "N besides the active one" subtracted a project nobody selected, so the
    // count was one short and named a project the agent would go looking for.
    state.ambiguousProjects = CANDIDATES;
    state.allProjects = CANDIDATES.map(projectPath => ({ projectPath, modelName: MODEL }));

    const { text } = await call();

    expect(text).toContain('3 in solution (none selected)');
    expect(text).not.toContain('besides the active one');
  });

  it('still says "(not detected)" when nothing resolved a project at all', async () => {
    const { text } = await call();

    expect(text).toContain('(not detected)');
    expect(text).not.toContain('not selected —');
  });
});

describe('get_workspace_info — a refused projectName', () => {
  beforeEach(() => {
    state.projectPath = 'K:\\solutions\\Contoso\\Core\\Contoso - Core.rnrproj';
    state.allProjects = CANDIDATES.map(projectPath => ({ projectPath, modelName: MODEL }));
  });

  it('answers the workspace question anyway, so the miss costs no round trip', async () => {
    const { text, isError } = await call({ projectName: 'ContosoCore' });

    // The model name matches three projects — a set, not a selection.
    expect(text).toContain('is a model, not one project');
    expect(isError).toBe(true);
    // ...and the facts the call was made for are in the same response.
    expect(text).toContain('## D365FO Workspace');
    expect(text).toContain(MODEL);
  });

  it('puts the refusal first, so a rejected switch cannot read as a completed one', async () => {
    const { text } = await call({ projectName: 'NoSuchProject' });

    expect(text.indexOf('No project matches')).toBeLessThan(text.indexOf('## D365FO Workspace'));
  });

  it('reports an unreadable projectPath the same way', async () => {
    state.forceProjectResult = null;

    const { text, isError } = await call({ projectPath: 'K:\\nope\\nope.rnrproj' });

    expect(text).toContain('Could not read model name from');
    expect(isError).toBe(true);
    expect(text).toContain('## D365FO Workspace');
  });
});
