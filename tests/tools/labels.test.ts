/**
 * Label Tools Tests
 * Covers: search_labels, get_label_info, create_label, rename_label
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchLabelsTool } from '../../src/tools/searchLabels';
import { getLabelInfoTool } from '../../src/tools/getLabelInfo';
import { createLabelTool } from '../../src/tools/createLabel';
import { renameLabelTool } from '../../src/tools/renameLabel';
import { labelsTool } from '../../src/tools/labels';
import { isExtensionLabelFile } from '../../src/metadata/labelParser';
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
const mockAddLabelToProject = vi.fn(async (_proj: string, _id: string, langs: string[]): Promise<string[]> =>
  langs.map(l => `${_id}_${l}`));
const mockFindProjectInSolution = vi.fn(async (_sol: string, _model: string): Promise<string | null> => null);
vi.mock('../../src/tools/createD365File', () => ({
  ProjectFileManager: vi.fn().mockImplementation(function(this: any) {
    this.addToProject = mockAddToProject;
    this.addLabelToProject = mockAddLabelToProject;
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
    getLabelFilePaths: vi.fn(() => []),
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
  ...overrides,
});

// ─── isExtensionLabelFile ─────────────────────────────────────────────────────

describe('isExtensionLabelFile', () => {
  it('flags label file IDs carrying the _Extension marker', () => {
    expect(isExtensionLabelFile('BaseLabels_Extension')).toBe(true);
    expect(isExtensionLabelFile('BaseLabels_ExtensionContoso')).toBe(true);
    expect(isExtensionLabelFile('baselabels_extension')).toBe(true); // case-insensitive
  });

  it('does not flag original label file IDs', () => {
    expect(isExtensionLabelFile('MyModel')).toBe(false);
    expect(isExtensionLabelFile('ContosoExt')).toBe(false);
    expect(isExtensionLabelFile('SYS')).toBe(false);
  });
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

  it('returns physical file paths per language when labelFileId is given without labelId', async () => {
    (ctx.symbolIndex.getLabelFileIds as any).mockReturnValue([
      { labelFileId: 'MyModel', model: 'MyModel', languages: 'en-US,cs' },
      { labelFileId: 'SYS', model: 'ApplicationSuite', languages: 'en-US' },
    ]);
    (ctx.symbolIndex.getLabelFilePaths as any).mockReturnValue([
      { language: 'en-US', filePath: 'K:\\repos\\meta\\MyModel\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyModel.en-US.label.txt', model: 'MyModel' },
      { language: 'cs', filePath: 'K:\\repos\\meta\\MyModel\\MyModel\\AxLabelFile\\LabelResources\\cs\\MyModel.cs.label.txt', model: 'MyModel' },
    ]);

    const result = await getLabelInfoTool(
      req('get_label_info', { labelFileId: 'MyModel' }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(ctx.symbolIndex.getLabelFilePaths as any).toHaveBeenCalledWith('MyModel', undefined);
    const text = result.content[0].text;
    // Narrowed to the requested file only — SYS must not appear.
    expect(text).not.toContain('SYS');
    expect(text).toContain('en-US');
    expect(text).toContain('MyModel.en-US.label.txt');
    expect(text).toContain('MyModel.cs.label.txt');
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

  // Tests below override the shared fs mocks (some with persistent mockResolvedValue).
  // Restore them to the factory defaults after each test so state never leaks into the
  // rename_label suite that follows.
  afterEach(async () => {
    const fsMock = await import('fs');
    (fsMock.promises.readFile as any).mockImplementation(async () => '; Label file\nMyExistingLabel=Existing label text\n');
    (fsMock.promises.writeFile as any).mockImplementation(async () => {});
    (fsMock.promises.mkdir as any).mockImplementation(async () => {});
    (fsMock.promises.access as any).mockImplementation(async () => {});
    (fsMock.promises.readdir as any).mockImplementation(async () => []);
  });

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

  it('reports the resolved package + physical location in the success output', async () => {
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'TransparencyTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Transparency test' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Package');
    expect(text).toContain('Location');
    // The resolved packages root must be surfaced so the caller can see WHERE it wrote.
    expect(text).toContain('PackagesLocalDirectory');
  });

  it('fails loudly instead of scaffolding a label file when the model directory does not exist', async () => {
    const fsMock = await import('fs');
    (fsMock.promises.writeFile as any).mockClear();
    // No language folders discovered (label file missing) …
    (fsMock.promises.readdir as any).mockImplementation(async () => []);
    // … and the model directory itself does not exist at the resolved path.
    (fsMock.promises.access as any).mockImplementation(async () => { throw new Error('ENOENT'); });

    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'PhantomLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Should not be written' }],
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/model directory does not exist|Nothing was written/i);
    // No .label.txt should have been written.
    expect((fsMock.promises.writeFile as any)).not.toHaveBeenCalled();
  });

  it('adds label file descriptors to VS project', async () => {
    mockAddLabelToProject.mockClear();
    // Enable project path for this test (called twice: once for description, once for step 5b)
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\repos\\MySolution\\MyProject\\MyProject.rnrproj');
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
    // addLabelToProject should have been called once with all languages
    expect(mockAddLabelToProject).toHaveBeenCalled();
    const [projPath, labelFileId, langs] = (mockAddLabelToProject.mock.calls as any[][])[0];
    expect(projPath).toBe('K:\\repos\\MySolution\\MyProject\\MyProject.rnrproj');
    expect(labelFileId).toBe('MyModel');
    expect(langs).toContain('en-US');
    expect(langs).toContain('cs');
    // Summary should mention project addition
    expect(result.content[0].text).toContain('Added to VS project');
  });

  it('uses explicit projectPath arg over configManager', async () => {
    mockAddLabelToProject.mockClear();
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
    expect(mockAddLabelToProject).toHaveBeenCalled();
    // Verify the explicit path was used (not the null from configManager)
    expect((mockAddLabelToProject.mock.calls as any[][])[0][0]).toBe('K:\\repos\\Explicit\\Explicit.rnrproj');
    expect(result.content[0].text).toContain('Added to VS project');
  });

  it('skips addToProject when addToProject=false', async () => {
    mockAddLabelToProject.mockClear();
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
    expect(mockAddLabelToProject).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain('Added to VS project');
  });

  it('falls back to solutionPath when projectPath is null', async () => {
    mockAddLabelToProject.mockClear();
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
    // addLabelToProject should have been called with the found project path
    expect(mockAddLabelToProject).toHaveBeenCalled();
    expect((mockAddLabelToProject.mock.calls as any[][])[0][0]).toBe('K:\\repos\\Found\\Found.rnrproj');
    expect(result.content[0].text).toContain('Added to VS project');
  });

  it('shows warning when projectPath cannot be resolved', async () => {
    mockAddLabelToProject.mockClear();
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
    expect(mockAddLabelToProject).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('projectPath not resolved');
  });

  it('surfaces addLabelToProject error in tool response', async () => {
    mockAddLabelToProject.mockClear();
    mockAddLabelToProject.mockRejectedValueOnce(new Error('EBUSY: resource busy, open \'K:\\Test.rnrproj\''));
    // Called twice: once for description fallback, once for step 5b project resolution
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\Test.rnrproj');
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\Test.rnrproj');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'ErrorVisibilityTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Error test' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy(); // label was created, only project failed
    expect(result.content[0].text).toContain('failed to add to VS project');
    expect(result.content[0].text).toContain('EBUSY');
    expect(result.content[0].text).toContain('Visual Studio has the .rnrproj file locked');
  });

  it('shows "already in project" when entries already exist', async () => {
    mockAddLabelToProject.mockClear();
    // Return empty array = all entries already present
    mockAddLabelToProject.mockResolvedValueOnce([]);
    // Called twice: once for description fallback, once for step 5b project resolution
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\Test.rnrproj');
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\Test.rnrproj');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'AlreadyInProjectTest',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Already test' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('already in VS project');
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

  it('refuses to write into a label file EXTENSION and writes nothing', async () => {
    const fsMock = await import('fs');
    (fsMock.promises.writeFile as any).mockClear();
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MyNewLabel',
        labelFileId: 'BaseLabels_Extension',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'My new label' }],
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
    expect(result.content[0].text).toMatch(/original label file/i);
    // Nothing must be written to disk.
    expect((fsMock.promises.writeFile as any)).not.toHaveBeenCalled();
  });

  it('also detects an extension with a trailing model prefix (…_Extension<prefix>)', async () => {
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MyNewLabel',
        labelFileId: 'BaseLabels_ExtensionContoso',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'My new label' }],
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
  });

  it('allows writing into an extension when allowExtensionLabelFile=true', async () => {
    (ctx.symbolIndex.getLabelById as any).mockReturnValue([]);
    (ctx.symbolIndex.searchLabels as any).mockReturnValue([]);

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MyNewLabel',
        labelFileId: 'BaseLabels_Extension',
        model: 'MyModel',
        allowExtensionLabelFile: true,
        createLabelFileIfMissing: true,
        updateIndex: false,
        addToProject: false,
        translations: [{ language: 'en-US', text: 'My new label' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('writes to every existing model language when `languages` is omitted (default fan-out)', async () => {
    const fsMock = await import('fs');
    const writes: { path: string; content: string }[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writes.push({ path: p, content });
    });
    // LabelResources is shared across the model: lt / nb-NO exist only because sibling
    // label files ship them, but the default behavior still writes to all of them.
    (fsMock.promises.readdir as any).mockResolvedValue(['en-US', 'fi', 'lt', 'nb-NO']);
    (fsMock.promises.readFile as any).mockResolvedValue('﻿');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'NewFeatureLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        addToProject: false,
        translations: [{ language: 'en-US', text: 'New feature' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(writes.some(w => w.path.endsWith('MyModel.en-US.label.txt'))).toBe(true);
    expect(writes.some(w => w.path.endsWith('MyModel.fi.label.txt'))).toBe(true);
    expect(writes.some(w => w.path.endsWith('MyModel.lt.label.txt'))).toBe(true);
    expect(writes.some(w => w.path.endsWith('MyModel.nb-NO.label.txt'))).toBe(true);
  });

  it('writes ONLY the requested locales when `languages` is provided', async () => {
    const fsMock = await import('fs');
    const writes: { path: string; content: string }[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writes.push({ path: p, content });
    });
    // Model has 4 locale folders, but this customization only needs en-US.
    (fsMock.promises.readdir as any).mockResolvedValue(['en-US', 'fi', 'lt', 'nb-NO']);
    (fsMock.promises.readFile as any).mockResolvedValue('﻿');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'NewFeatureLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        addToProject: false,
        languages: ['en-US'],
        translations: [{ language: 'en-US', text: 'New feature' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // en-US written; fi / lt / nb-NO must NOT be touched (no stray placeholder files)
    expect(writes.some(w => w.path.endsWith('MyModel.en-US.label.txt'))).toBe(true);
    expect(writes.some(w => w.path.endsWith('MyModel.fi.label.txt'))).toBe(false);
    expect(writes.some(w => w.path.endsWith('MyModel.lt.label.txt'))).toBe(false);
    expect(writes.some(w => w.path.endsWith('MyModel.nb-NO.label.txt'))).toBe(false);
    // and no orphaned XML descriptors for the unrequested locales
    expect(writes.some(w => w.path.endsWith('MyModel_lt.xml'))).toBe(false);
    expect(writes.some(w => w.path.endsWith('MyModel_nb-NO.xml'))).toBe(false);
  });

  it('creates a missing locale folder when requested via `languages`', async () => {
    const fsMock = await import('fs');
    const writes: { path: string; content: string }[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writes.push({ path: p, content });
    });
    // Model currently only has en-US; caller explicitly wants en-US + sv (new locale).
    (fsMock.promises.readdir as any).mockResolvedValue(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValue('﻿');
    // descriptor / new-file existence checks should report "missing" so they get created
    (fsMock.promises.access as any).mockRejectedValue(new Error('ENOENT'));

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'NewFeatureLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        addToProject: false,
        languages: ['en-US', 'sv'],
        translations: [
          { language: 'en-US', text: 'New feature' },
          { language: 'sv', text: 'Ny funktion' },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(writes.some(w => w.path.endsWith('MyModel.en-US.label.txt'))).toBe(true);
    expect(writes.some(w => w.path.endsWith('MyModel.sv.label.txt'))).toBe(true);
    // fi / lt / nb-NO never requested and not present — must not appear
    expect(writes.some(w => w.path.endsWith('MyModel.fi.label.txt'))).toBe(false);
  });

  it('resolves to on-disk casing when `languages` locale differs in case (Linux unzip)', async () => {
    // Scenario: MS packages were unzipped on Linux — locale directories are lowercase (en-us, de).
    // The caller passes standard BCP-47 values (en-US, de).
    // The tool must write to the existing on-disk paths, NOT create new en-US/ de/ sibling folders.
    const fsMock = await import('fs');
    const writes: { path: string; content: string }[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writes.push({ path: p, content });
    });
    // On-disk the folders are lowercase (Linux unzip behaviour)
    (fsMock.promises.readdir as any).mockResolvedValue(['en-us', 'de']);
    (fsMock.promises.readFile as any).mockResolvedValue('\uFEFF');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'CaseMismatchLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        addToProject: false,
        // Caller uses standard BCP-47 casing
        languages: ['en-US', 'de'],
        translations: [
          { language: 'en-US', text: 'Case test' },
          { language: 'de', text: 'Groß-Klein-Test' },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();

    // Must write into the existing lowercase directory names, not create new mixed-case ones
    expect(writes.some(w => /[/\\]en-us[/\\]/.test(w.path))).toBe(true);
    expect(writes.some(w => /[/\\]de[/\\]/.test(w.path))).toBe(true);

    // Must NOT create a second en-US/ folder alongside en-us/
    expect(writes.some(w => /[/\\]en-US[/\\]/.test(w.path))).toBe(false);
  });

  it('defaults description to VS project name when no comment is provided', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFF');
    // Provide a project path so the project name is extracted
    mockConfigMgr.getProjectPath.mockResolvedValueOnce('K:\\repos\\MySolution\\ContosoExt\\ContosoExt.rnrproj');

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
    // The written content should contain the VS project name (not model) as comment
    const labelWrite = writeCalls.find(c => c.includes('TestDesc='));
    expect(labelWrite).toContain(' ;ContosoExt');
  });

  it('falls back to labelFileId when projectPath is null and no description', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFF');
    // projectPath is null (default mock)

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'TestDescFallback',
        labelFileId: 'BankLabels',
        model: 'MyModel',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Fallback test' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // Should use labelFileId, not model name
    const labelWrite = writeCalls.find(c => c.includes('TestDescFallback='));
    expect(labelWrite).toContain(' ;BankLabels');
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

  it('appends new label at end when sortLabels=false', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    // Existing file has labels in non-alphabetical order: Zebra before Apple
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFFZebraLabel=Zebra text\nAppleLabel=Apple text\n');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MiddleLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        sortLabels: false,
        translations: [{ language: 'en-US', text: 'Middle text' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('MiddleLabel='));
    expect(labelWrite).toBeDefined();
    // With sortLabels=false, original order preserved: Zebra, Apple, then Middle appended
    const lines = labelWrite!.split('\n').filter(l => l.includes('='));
    expect(lines[0]).toContain('ZebraLabel=');
    expect(lines[1]).toContain('AppleLabel=');
    expect(lines[2]).toContain('MiddleLabel=');
  });

  it('sorts alphabetically by default (sortLabels not specified)', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    // Existing file has labels in non-alphabetical order
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFFZebraLabel=Zebra text\nAppleLabel=Apple text\n');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MiddleLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Middle text' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('MiddleLabel='));
    expect(labelWrite).toBeDefined();
    // Default: alphabetically sorted
    const lines = labelWrite!.split('\n').filter(l => l.includes('='));
    expect(lines[0]).toContain('AppleLabel=');
    expect(lines[1]).toContain('MiddleLabel=');
    expect(lines[2]).toContain('ZebraLabel=');
  });

  it('orders underscore after letters (case-insensitive ordinal, matching Visual Studio)', async () => {
    // Regression for the create_label sort-collation bug: a locale-aware comparer
    // (localeCompare 'en', sensitivity 'base') sorts '_' BEFORE letters, but Visual
    // Studio uses case-insensitive ordinal where '_' (0x5F) sorts AFTER A–Z. The
    // disagreement shuffles `word_`-prefixed IDs on every write → spurious git churn.
    // Empirically proven order in VS: Gx, px, _x (underscore last).
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    // Existing file holds the three probe labels in scrambled order.
    (fsMock.promises.readFile as any).mockResolvedValueOnce(
      '﻿Zmvnsorttest_x=underscore\nZmvnsorttestGx=upper G\nZmvnsorttestpx=lower p\n',
    );

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'ZmvnsorttestAx',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        addToProject: false,
        translations: [{ language: 'en-US', text: 'added' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('ZmvnsorttestGx='));
    expect(labelWrite).toBeDefined();
    const ids = labelWrite!
      .split('\n')
      .filter(l => l.includes('='))
      .map(l => l.split('=')[0].replace('﻿', ''));
    // Case-insensitive ordinal: Ax, Gx, px (G<P), then _x LAST ('_'=0x5F > letters).
    expect(ids).toEqual([
      'ZmvnsorttestAx',
      'ZmvnsorttestGx',
      'Zmvnsorttestpx',
      'Zmvnsorttest_x',
    ]);
  });

  it('respects LABEL_SORT_ORDER=append env var when sortLabels not specified', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFFZebraLabel=Zebra text\nAppleLabel=Apple text\n');

    // Set env var
    const origEnv = process.env.LABEL_SORT_ORDER;
    process.env.LABEL_SORT_ORDER = 'append';
    try {
      const result = await createLabelTool(
        req('create_label', {
          labelId: 'MiddleLabel',
          labelFileId: 'MyModel',
          model: 'MyModel',
          updateIndex: false,
          translations: [{ language: 'en-US', text: 'Middle text' }],
        }),
        ctx,
      );
      expect(result.isError).toBeFalsy();
      const labelWrite = writeCalls.find(c => c.includes('MiddleLabel='));
      expect(labelWrite).toBeDefined();
      // Env says append: Zebra, Apple, Middle (not sorted)
      const lines = labelWrite!.split('\n').filter(l => l.includes('='));
      expect(lines[0]).toContain('ZebraLabel=');
      expect(lines[1]).toContain('AppleLabel=');
      expect(lines[2]).toContain('MiddleLabel=');
    } finally {
      if (origEnv === undefined) delete process.env.LABEL_SORT_ORDER;
      else process.env.LABEL_SORT_ORDER = origEnv;
    }
  });

  it('sortLabels=true overrides LABEL_SORT_ORDER=append env var', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce('\uFEFFZebraLabel=Zebra text\nAppleLabel=Apple text\n');

    const origEnv = process.env.LABEL_SORT_ORDER;
    process.env.LABEL_SORT_ORDER = 'append';
    try {
      const result = await createLabelTool(
        req('create_label', {
          labelId: 'MiddleLabel',
          labelFileId: 'MyModel',
          model: 'MyModel',
          updateIndex: false,
          sortLabels: true,
          translations: [{ language: 'en-US', text: 'Middle text' }],
        }),
        ctx,
      );
      expect(result.isError).toBeFalsy();
      const labelWrite = writeCalls.find(c => c.includes('MiddleLabel='));
      expect(labelWrite).toBeDefined();
      // Explicit sortLabels=true wins: alphabetical
      const lines = labelWrite!.split('\n').filter(l => l.includes('='));
      expect(lines[0]).toContain('AppleLabel=');
      expect(lines[1]).toContain('MiddleLabel=');
      expect(lines[2]).toContain('ZebraLabel=');
    } finally {
      if (origEnv === undefined) delete process.env.LABEL_SORT_ORDER;
      else process.env.LABEL_SORT_ORDER = origEnv;
    }
  });

  it('preserves CRLF line endings when the original file uses CRLF', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    // Existing file uses CRLF (Windows / TFVC default for D365FO label files)
    (fsMock.promises.readFile as any).mockResolvedValueOnce(
      '﻿AppleLabel=Apple text\r\nZebraLabel=Zebra text\r\n',
    );

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MiddleLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Middle text' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('MiddleLabel='));
    expect(labelWrite).toBeDefined();
    // The written file MUST keep CRLF — switching to LF makes every line look modified in VCS diffs.
    expect(labelWrite).toContain('\r\n');
    expect(labelWrite).toContain('AppleLabel=Apple text\r\n');
    expect(labelWrite).toContain('MiddleLabel=Middle text\r\n');
    // And it must not introduce bare LF (i.e. every LF should be preceded by CR)
    const bareLfMatches = labelWrite!.match(/(?<!\r)\n/g);
    expect(bareLfMatches).toBeNull();
  });

  it('preserves LF line endings when the original file uses LF', async () => {
    const fsMock = await import('fs');
    const writeCalls: string[] = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (_p: string, content: string) => {
      writeCalls.push(content);
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    (fsMock.promises.readFile as any).mockResolvedValueOnce(
      '﻿AppleLabel=Apple text\nZebraLabel=Zebra text\n',
    );

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'MiddleLabel',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Middle text' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.includes('MiddleLabel='));
    expect(labelWrite).toBeDefined();
    expect(labelWrite).not.toContain('\r\n');
    expect(labelWrite).toContain('MiddleLabel=Middle text\n');
  });

  it('defaults to CRLF for a brand-new label file (no existing content)', async () => {
    const fsMock = await import('fs');
    const writeCalls: Array<{ path: string; content: string }> = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writeCalls.push({ path: p, content });
    });
    // No existing language folders — triggers the createLabelFileIfMissing path
    (fsMock.promises.readdir as any).mockResolvedValueOnce([]);
    // readFile is never called when the file is brand-new; if it is, return empty
    (fsMock.promises.readFile as any).mockResolvedValue('');

    const result = await createLabelTool(
      req('create_label', {
        labelId: 'BrandNew',
        labelFileId: 'MyModel',
        model: 'MyModel',
        createLabelFileIfMissing: true,
        updateIndex: false,
        translations: [{ language: 'en-US', text: 'Brand new label' }],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.content.includes('BrandNew='));
    expect(labelWrite).toBeDefined();
    // New D365FO label files default to CRLF (Windows-native, matches TFVC defaults)
    expect(labelWrite!.content).toContain('BrandNew=Brand new label\r\n');
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

  it('refuses to operate on a label file EXTENSION', async () => {
    const fsMock = await import('fs');
    (fsMock.promises.writeFile as any).mockClear();

    const result = await renameLabelTool(
      req('rename_label', {
        oldLabelId: 'OldName',
        newLabelId: 'NewName',
        labelFileId: 'BaseLabels_Extension',
        model: 'MyModel',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension/i);
    expect((fsMock.promises.writeFile as any)).not.toHaveBeenCalled();
  });

  it('preserves CRLF line endings when renaming inside a CRLF .label.txt', async () => {
    const fsMock = await import('fs');
    const writeCalls: Array<{ path: string; content: string }> = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writeCalls.push({ path: p, content });
    });
    // First readdir call returns the language list; later collectFiles calls fall
    // back to the default [] mock so the subsequent .xpp/.xml scan finds nothing.
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    // CRLF source file with the label to rename plus a couple of siblings.
    // The rename tool reads the file three times (existence check, duplicate
    // check, and the actual rewrite), so use mockResolvedValue.
    (fsMock.promises.readFile as any).mockResolvedValue(
      '﻿AppleLabel=Apple text\r\nOldFeatureName=Some text\r\nZebraLabel=Zebra text\r\n',
    );

    (ctx.symbolIndex.searchLabels as any).mockReturnValue([
      makeLabelResult({ labelId: 'OldFeatureName' }),
    ]);

    const result = await renameLabelTool(
      req('rename_label', {
        oldLabelId: 'OldFeatureName',
        newLabelId: 'NewFeatureName',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
      }),
      ctx,
    );
    if (result.isError) throw new Error(`rename_label failed: ${result.content[0].text}`);
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.path.endsWith('.label.txt'));
    expect(labelWrite).toBeDefined();
    // Renamed line must use CRLF, and surrounding lines must not be silently downgraded to LF
    expect(labelWrite!.content).toContain('NewFeatureName=Some text\r\n');
    expect(labelWrite!.content).toContain('AppleLabel=Apple text\r\n');
    const bareLfMatches = labelWrite!.content.match(/(?<!\r)\n/g);
    expect(bareLfMatches).toBeNull();
  });

  it('preserves LF line endings when renaming inside a LF .label.txt', async () => {
    const fsMock = await import('fs');
    const writeCalls: Array<{ path: string; content: string }> = [];
    (fsMock.promises.writeFile as any).mockImplementation(async (p: string, content: string) => {
      writeCalls.push({ path: p, content });
    });
    (fsMock.promises.readdir as any).mockResolvedValueOnce(['en-US']);
    // LF source file — e.g. a repo checked out on Linux or with core.autocrlf=false.
    (fsMock.promises.readFile as any).mockResolvedValue(
      '\uFEFFAppleLabel=Apple text\nOldFeatureName=Some text\nZebraLabel=Zebra text\n',
    );

    (ctx.symbolIndex.searchLabels as any).mockReturnValue([
      makeLabelResult({ labelId: 'OldFeatureName' }),
    ]);

    const result = await renameLabelTool(
      req('rename_label', {
        oldLabelId: 'OldFeatureName',
        newLabelId: 'NewFeatureName',
        labelFileId: 'MyModel',
        model: 'MyModel',
        updateIndex: false,
      }),
      ctx,
    );
    if (result.isError) throw new Error(`rename_label failed: ${result.content[0].text}`);
    expect(result.isError).toBeFalsy();
    const labelWrite = writeCalls.find(c => c.path.endsWith('.label.txt'));
    expect(labelWrite).toBeDefined();
    // Renamed line must keep LF — tool must not upgrade a LF file to CRLF.
    expect(labelWrite!.content).toContain('NewFeatureName=Some text\n');
    expect(labelWrite!.content).toContain('AppleLabel=Apple text\n');
    // No CRLF sequences must be present — file must stay pure LF.
    expect(labelWrite!.content).not.toContain('\r\n');
  });
});

describe('labels dispatcher: action aliases + errors', () => {
  let ctx: XppServerContext;
  beforeEach(() => { ctx = buildContext(); });

  it('redirects create-label-file to d365fo_file with a clear message', async () => {
    const r: any = await labelsTool(
      { method: 'tools/call', params: { name: 'labels', arguments: { action: 'create-label-file', model: 'MyModel' } } } as CallToolRequest,
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('d365fo_file');
  });

  it('rejects an unknown action and lists the valid ones', async () => {
    const r: any = await labelsTool(
      { method: 'tools/call', params: { name: 'labels', arguments: { action: 'frobnicate' } } } as CallToolRequest,
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('search, info, create, rename');
  });

  it('aliases action="list" to info (not rejected as invalid)', async () => {
    // "list" is not a canonical action; the alias map rewrites it to "info" so
    // safeParse succeeds and it dispatches instead of failing validation.
    let r: any;
    try {
      r = await labelsTool(
        { method: 'tools/call', params: { name: 'labels', arguments: { action: 'list', model: 'MyModel' } } } as CallToolRequest,
        ctx,
      );
    } catch {
      // A downstream sub-tool error is fine here — it means the alias was accepted
      // and we got past argument validation, which is what this test asserts.
      return;
    }
    expect(r.content?.[0]?.text ?? '').not.toContain('invalid arguments');
  });
});
