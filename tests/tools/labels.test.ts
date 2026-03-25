/**
 * Label Tools Tests
 * Covers: search_labels, get_label_info, create_label, rename_label
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchLabelsTool } from '../../src/tools/searchLabels';
import { getLabelInfoTool } from '../../src/tools/getLabelInfo';
import { createLabelTool } from '../../src/tools/createLabel';
import { renameLabelTool } from '../../src/tools/renameLabel';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock filesystem access — label tools write to disk
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => '; Label file\nMyExistingLabel=Existing label text\n'),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      access: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
    },
  };
});

const mockAddToProject = vi.fn(async () => true);
const mockFindProjectInSolution = vi.fn(async (_sol: string, _model: string): Promise<string | null> => null);
vi.mock('../../src/tools/createD365File', () => ({
  ProjectFileManager: vi.fn().mockImplementation(function(this: any) {
    this.addToProject = mockAddToProject;
  }),
  ProjectFileFinder: {
    findProjectInSolution: (solutionPath: string, modelName: string) => mockFindProjectInSolution(solutionPath, modelName),
  },
}));

const mockConfigMgr = {
  ensureLoaded: vi.fn(async () => {}),
  getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
  getModelName: vi.fn(() => 'MyModel'),
  getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
  getProjectPath: vi.fn(async () => null as string | null),
  getSolutionPath: vi.fn(async () => null as string | null),
  getDevEnvironmentType: vi.fn(async () => 'traditional'),
  getCustomPackagesPath: vi.fn(async () => null),
  getMicrosoftPackagesPath: vi.fn(async () => null),
};
vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => mockConfigMgr),
}));

vi.mock('../../src/utils/packageResolver', () => ({
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (modelName: string) => ({
      packageName: modelName,
      modelName,
      rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((modelName: string, packageName: string) => ({
      packageName,
      modelName,
      rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const makeLabelResult = (overrides: Partial<any> = {}) => ({
  labelId: 'CustAccount',
  labelFileId: 'MyModel',
  model: 'MyModel',
  language: 'en-US',
  text: 'Customer account',
  comment: '',
  ...overrides,
});

const buildContext = (overrides: Partial<XppServerContext> = {}): XppServerContext => ({
  symbolIndex: {
    searchLabels: vi.fn(() => []),
    getLabelById: vi.fn(() => undefined),
    getLabelFileIds: vi.fn(() => []),
    getCustomModels: vi.fn(() => ['MyModel']),
    insertOrUpdateLabel: vi.fn(),
    searchSymbols: vi.fn(() => []),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
    getReadDb: vi.fn(function(this: any) { return this.db; }),
  } as any,
  parser: {} as any,
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    generateSearchKey: vi.fn((q: string) => `k:${q}`),
  } as any,
  workspaceScanner: {} as any,
  hybridSearch: {} as any,
  termRelationshipGraph: {} as any,
  ...overrides,
});

// ─── search_labels ───────────────────────────────────────────────────────────

describe('search_labels', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns matching labels with reference syntax', async () => {
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([
      makeLabelResult({ labelId: 'CustomerName', text: 'Customer name', labelFileId: 'MyModel', model: 'MyModel' }),
      makeLabelResult({ labelId: 'CustomerAccount', text: 'Customer account', labelFileId: 'MyModel', model: 'MyModel' }),
    ]);

    const result = await searchLabelsTool(req('search_labels', { query: 'customer' }), ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('CustomerName');
    expect(text).toContain('@MyModel:');
  });

  it('returns no-results message when nothing matches', async () => {
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);
    const result = await searchLabelsTool(req('search_labels', { query: 'zzznomatch' }), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/no.*found|0 label/i);
  });

  it('filters by model when provided', async () => {
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([
      makeLabelResult({ model: 'MyModel' }),
    ]);
    const result = await searchLabelsTool(
      req('search_labels', { query: 'customer', model: 'MyModel' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('filters by labelFileId when provided', async () => {
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([
      makeLabelResult({ labelFileId: 'MyModel' }),
    ]);
    const result = await searchLabelsTool(
      req('search_labels', { query: 'customer', labelFileId: 'MyModel' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when query is missing', async () => {
    const result = await searchLabelsTool(req('search_labels', {}), ctx);
    expect(result.isError).toBe(true);
  });
});

// ─── get_label_info ──────────────────────────────────────────────────────────

describe('get_label_info', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('lists available label files when labelId is omitted', async () => {
    (ctx.symbolIndex.getLabelFileIds as any).mockReturnValue([
      { labelFileId: 'MyModel', model: 'MyModel', languages: 'en-US' },
      { labelFileId: 'SYS', model: 'ApplicationSuite', languages: 'en-US' },
    ]);

    const result = await getLabelInfoTool(req('get_label_info', {}), ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('MyModel');
    expect(text).toContain('SYS');
  });

  it('returns no-files message when no label files exist', async () => {
    (ctx.symbolIndex.getLabelFileIds as any).mockReturnValue([]);
    const result = await getLabelInfoTool(req('get_label_info', {}), ctx);
    expect(result.content[0].text).toMatch(/no.*label.*file|not.*found/i);
  });

  it('returns all translations for a specific labelId', async () => {
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([
      makeLabelResult({ language: 'en-US', text: 'Customer account' }),
      makeLabelResult({ language: 'cs', text: 'Účet zákazníka' }),
      makeLabelResult({ language: 'de', text: 'Kundenkonto' }),
    ]);

    const result = await getLabelInfoTool(
      req('get_label_info', { labelId: 'CustAccount', labelFileId: 'MyModel' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('en-US');
    expect(text).toContain('cs');
    expect(text).toContain('@MyModel:CustAccount');
  });

  it('returns not-found when label does not exist', async () => {
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    const result = await getLabelInfoTool(
      req('get_label_info', { labelId: 'NoSuchLabel', labelFileId: 'MyModel' }),
      ctx,
    );
    expect(result.content[0].text).toMatch(/not found|no.*label|does not exist/i);
  });
});

// ─── create_label ────────────────────────────────────────────────────────────

describe('create_label', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('creates label with multiple translations', async () => {
    // Simulate label not existing yet
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MyNewFeature',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [
          { language: 'en-US', text: 'My new feature' },
          { language: 'cs', text: 'Moje nová funkce' },
          { language: 'de', text: 'Meine neue Funktion' },
        ],
      }),
      ctx,
    );
    // Result is success (file write is mocked) or at minimum not a Zod validation error
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/created|success|MyNewFeature/i);
  });

  it('adds label file descriptors to VS project', async () => {
    mockAddToProject.mockClear();
    // Enable project path for this test
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\repos\\MySolution\\MyProject\\MyProject.rnrproj');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'ProjectTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [
          { language: 'en-US', text: 'Project test label' },
          { language: 'cs', text: 'Projektový test' },
        ],
      }),
      ctx,
    );
    if (result.isError) throw new Error(result.content[0].text);
    expect(result.isError).toBeFalsy();
    // ProjectFileManager.addToProject should have been called for each language descriptor
    expect(mockAddToProject).toHaveBeenCalled();
    const calls = mockAddToProject.mock.calls;
    // Each call receives (projectPath, 'label-file', descriptorName, '')
    const descriptorNames = calls.map((c: any[]) => c[2]);
    expect(descriptorNames).toContain('MyModel_en-US');
    expect(descriptorNames).toContain('MyModel_cs');
    // Summary should mention project addition
    expect(result.content[0].text).toContain('Added to VS project');
  });

  it('uses explicit projectPath arg over configManager', async () => {
    mockAddToProject.mockClear();
    // configManager.getProjectPath returns null, but explicit arg is provided
    const result = await createLabelTool(
      req('create_label', {
        labelId: 'ExplicitPathTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        projectPath: 'K:\\repos\\Explicit\\Explicit.rnrproj',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [
          { language: 'en-US', text: 'Explicit path test' },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(mockAddToProject).toHaveBeenCalled();
    // Verify the explicit path was used (not the null from configManager)
    expect(mockAddToProject.mock.calls.length).toBeGreaterThan(0);
    expect((mockAddToProject.mock.calls as any[][])[0][0]).toBe('K:\\repos\\Explicit\\Explicit.rnrproj');
    expect(result.content[0].text).toContain('Added to VS project');
  });

  it('skips addToProject when addToProject=false', async () => {
    mockAddToProject.mockClear();
    // projectPath doesn't matter — addToProject=false should skip the entire block

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'NoProjectTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        addToProject: false,
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [
          { language: 'en-US', text: 'No project test' },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(mockAddToProject).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain('Added to VS project');
  });

  it('falls back to solutionPath when projectPath is null', async () => {
    mockAddToProject.mockClear();
    mockFindProjectInSolution.mockClear();
    mockConfigMgr.getProjectPath.mockReset();
    mockConfigMgr.getSolutionPath.mockReset();
    // projectPath returns null, solutionPath returns a path, finder resolves .rnrproj
    mockConfigMgr.getProjectPath.mockResolvedValue(null);
    mockFindProjectInSolution.mockResolvedValueOnce('K:\\repos\\Found\\Found.rnrproj');
    mockConfigMgr.getSolutionPath.mockResolvedValueOnce('K:\\repos\\Found');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'SolutionFallbackTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [
          { language: 'en-US', text: 'Solution fallback test' },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // ProjectFileFinder should have been called with the solution path and model
    expect(mockFindProjectInSolution).toHaveBeenCalledWith('K:\\repos\\Found', 'MyModel');
    // addToProject should have been called with the found project path
    expect(mockAddToProject).toHaveBeenCalled();
    expect((mockAddToProject.mock.calls as any[][])[0][0]).toBe('K:\\repos\\Found\\Found.rnrproj');
    expect(result.content[0].text).toContain('Added to VS project');
  });

  it('shows warning when projectPath cannot be resolved', async () => {
    mockAddToProject.mockClear();
    mockFindProjectInSolution.mockClear();
    mockConfigMgr.getProjectPath.mockReset();
    mockConfigMgr.getSolutionPath.mockReset();
    // All resolution paths return null
    mockConfigMgr.getProjectPath.mockResolvedValue(null);
    mockConfigMgr.getSolutionPath.mockResolvedValue(null);
    const result = await createLabelTool(
      req('create_label', {
        labelId: 'NoPathTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [
          { language: 'en-US', text: 'No path test' },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(mockAddToProject).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('projectPath not resolved');
  });

  it('returns error when labelId contains invalid characters', async () => {
    const result = await createLabelTool(
      req('create_label', {
        labelId: 'invalid label id!',
        labelFileId: 'MyModel',
        model: 'MyModel',
        translations: [{ language: 'en-US', text: 'text' }],
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it('returns error when required fields are missing', async () => {
    const result = await createLabelTool(req('create_label', { labelId: 'Foo' }), ctx);
    expect(result.isError).toBe(true);
  });

  it('defaults description to model name when no comment is provided', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFF');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'TestDesc',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Test label' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // The written content should contain the model name as comment
    const labelWrite = writeCalls.find(c => c.includes('TestDesc='));
    expect(labelWrite).toContain(' ;MyModel');
  });

  it('uses explicit description over model name default', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFF');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'TestDesc2',
        labelFileId: 'MyModel',
        model: 'MyModel',
        description: 'Custom project description',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Test label 2' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('TestDesc2='));
    expect(labelWrite).toContain(' ;Custom project description');
  });

  it('per-translation comment takes priority over description', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFF');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'TestDesc3',
        labelFileId: 'MyModel',
        model: 'MyModel',
        description: 'Should be overridden',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Test label 3', comment: 'Explicit comment' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('TestDesc3='));
    expect(labelWrite).toContain(' ;Explicit comment');
    expect(labelWrite).not.toContain('Should be overridden');
  });
});

// ─── rename_label ────────────────────────────────────────────────────────────

describe('rename_label', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('performs a dry-run rename without writing files', async () => {
    // Provide a label file with the old label so the rename tool can find it
    const fsMock = await import('fs');
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFFOldFeatureName=Some text\n');

    (ctx.symbolIndex.searchLabels as any).mockReturnValue([
      makeLabelResult({ labelId: 'OldFeatureName' }),
    ]);

    const result = await renameLabelTool(
      req('rename_label', {
        oldLabelId: 'OldFeatureName',
        newLabelId: 'NewFeatureName',
        labelFileId: 'MyModel',
        model: 'MyModel',
        dryRun: true,
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/dry.?run|preview|would rename/i);
  });

  it('returns error when oldLabelId does not exist', async () => {
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);

    const result = await renameLabelTool(
      req('rename_label', {
        oldLabelId: 'NoSuchLabel',
        newLabelId: 'NewName',
        labelFileId: 'MyModel',
        model: 'MyModel',
      }),
      ctx,
    );
    expect(result.content[0].text).toMatch(/not found|does not exist|no.*label/i);
  });

  it('returns error when required fields are missing', async () => {
    const result = await renameLabelTool(req('rename_label', { oldLabelId: 'Foo' }), ctx);
    expect(result.isError).toBe(true);
  });
});
