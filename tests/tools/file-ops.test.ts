/**
 * File Operation Tools Tests
 * Covers: create_d365fo_file, modify_d365fo_file,
 *         validate_object_naming, verify_d365fo_project
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateObjectNamingTool } from '../../src/tools/validateObjectNaming';
import { verifyD365ProjectTool } from '../../src/tools/verifyD365Project';
import { handleCreateD365File } from '../../src/tools/createD365File';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock filesystem — file tools write to disk
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.rnrproj')) {
      return `<Project><ItemGroup><Content Include="AxClass\\ExistingClass.xml" /></ItemGroup></Project>`;
    }
    if (p.endsWith('.xml')) {
      return `<?xml version="1.0"?><AxClass><Name>ExistingClass</Name></AxClass>`;
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
    getProjectPath: vi.fn(async () => 'K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj'),
    getSolutionPath: vi.fn(async () => null),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
    getCustomPackagesPath: vi.fn(async () => null),
    getMicrosoftPackagesPath: vi.fn(async () => null),
  })),
}));

vi.mock('../../src/utils/packageResolver', () => ({
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (modelName: string) => ({
      packageName: modelName,
      modelName,
      rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const createMockDb = () => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return { prepare: vi.fn(() => stmt), stmt };
};

const buildContext = (): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => ['MyModel']),
    db: createMockDb(),
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
});

// ─── validate_object_naming ──────────────────────────────────────────────────

describe('validate_object_naming', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    // No existing symbol = no name collision
    (ctx.symbolIndex.db as any).stmt.get.mockReturnValue(undefined);
    (ctx.symbolIndex.db as any).stmt.all.mockReturnValue([]);
  });

  it('passes a valid class name with no collisions', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'MY_InvoiceHelper', objectType: 'class' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/valid|pass|no error/i);
  });

  it('fails a name that exceeds the 81-character AOT limit', async () => {
    const longName = 'A'.repeat(82);
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: longName, objectType: 'class' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/exceed|maximum.*81|too long/i);
  });

  it('warns when name approaches the 81-character limit', async () => {
    const nearLimitName = 'A'.repeat(75);
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: nearLimitName, objectType: 'class' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/warn|approaching|75/i);
  });

  it('validates a table-extension name correctly', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTable.MY_Extension',
        objectType: 'table-extension',
        baseObjectName: 'CustTable',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('detects a name collision with existing symbol', async () => {
    (ctx.symbolIndex.db as any).stmt.get.mockReturnValue({
      name: 'CustTable', type: 'table', model: 'ApplicationSuite',
    });

    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTable', objectType: 'table' }),
      ctx,
    );
    expect(result.content[0].text).toMatch(/conflict|collision|already exists|taken/i);
  });

  it('returns error when objectType is missing', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'MyClass' }),
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it('returns error when proposedName is missing', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { objectType: 'class' }),
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it('validates all supported objectType values without throwing', async () => {
    const types = [
      'class', 'table', 'form', 'enum', 'edt', 'query', 'view',
      'table-extension', 'class-extension', 'form-extension',
      'menu-item', 'security-privilege', 'security-duty', 'security-role',
      'data-entity',
    ];
    for (const objectType of types) {
      const result = await validateObjectNamingTool(
        req('validate_object_naming', { proposedName: 'MY_TestObject', objectType }),
        ctx,
      );
      expect(result.isError).toBeFalsy();
    }
  });
});

// ─── verify_d365fo_project ───────────────────────────────────────────────────

describe('verify_d365fo_project', () => {
  it('reports objects found both on disk and in project file', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.access as any).mockResolvedValue(undefined);
    (fsMod.readFile as any).mockImplementation(async (p: string) => {
      if (p.endsWith('.rnrproj')) {
        return `<Project><ItemGroup>
          <Content Include="AxClass\\MyHelper.xml" />
        </ItemGroup></Project>`;
      }
      return `<?xml version="1.0"?><AxClass><Name>MyHelper</Name></AxClass>`;
    });

    const result = await verifyD365ProjectTool(
      req('verify_d365fo_project', {
        objects: [{ objectType: 'class', objectName: 'MyHelper' }],
        modelName: 'MyModel',
        packageName: 'MyPackage',
        projectPath: 'K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj',
      }),
      buildContext(),
    );
    expect((result as any).isError).toBeFalsy();
    expect(result.content[0].text).toContain('MyHelper');
  });

  it('reports missing objects with clear status', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.access as any).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    (fsMod.readFile as any).mockImplementation(async (p: string) => {
      if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await verifyD365ProjectTool(
      req('verify_d365fo_project', {
        objects: [{ objectType: 'class', objectName: 'MissingClass' }],
        modelName: 'MyModel',
        packageName: 'MyPackage',
        projectPath: 'K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj',
      }),
      buildContext(),
    );
    expect((result as any).isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/missing|not found|❌/i);
  });

  it('verifies multiple objects at once', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.access as any).mockResolvedValue(undefined);
    (fsMod.readFile as any).mockImplementation(async (p: string) => {
      if (p.endsWith('.rnrproj')) {
        return `<Project><ItemGroup>
          <Content Include="AxClass\\MyHelper.xml" />
          <Content Include="AxTable\\MyTable.xml" />
        </ItemGroup></Project>`;
      }
      return `<?xml version="1.0"?><AxClass><Name>Test</Name></AxClass>`;
    });

    const result = await verifyD365ProjectTool(
      req('verify_d365fo_project', {
        objects: [
          { objectType: 'class', objectName: 'MyHelper' },
          { objectType: 'table', objectName: 'MyTable' },
          { objectType: 'enum', objectName: 'MyEnum' },
        ],
        modelName: 'MyModel',
        packageName: 'MyPackage',
        projectPath: 'K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj',
      }),
      buildContext(),
    );
    expect((result as any).isError).toBeFalsy();
    expect(result.content[0].text).toContain('MyHelper');
    expect(result.content[0].text).toContain('MyTable');
    expect(result.content[0].text).toContain('MyEnum');
  });

  it('returns error when objects array is missing', async () => {
    const result = await verifyD365ProjectTool(req('verify_d365fo_project', {}), buildContext());
    expect((result as any).isError).toBe(true);
  });
});

// ─── create_d365fo_file ──────────────────────────────────────────────────────

describe('create_d365fo_file', () => {
  it('creates a class file and reports success', async () => {
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'class',
        objectName: 'MyNewClass',
        modelName: 'FmMcp',
        packageName: 'FmMcp',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
      }),
    );
    expect((result as any).isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/created|success|MyNewClass/i);
  });

  it('creates a table-extension file', async () => {
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table-extension',
        objectName: 'CustTable.MY_Extension',
        modelName: 'FmMcp',
        packageName: 'FmMcp',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
      }),
    );
    expect((result as any).isError).toBeFalsy();
  });

  it('creates a class from custom xmlContent (hybrid scenario)', async () => {
    const xml = `<?xml version="1.0"?><AxClass><Name>MyHybridClass</Name></AxClass>`;
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'class',
        objectName: 'MyHybridClass',
        modelName: 'FmMcp',
        packageName: 'FmMcp',
        packagePath: 'K:\\PackagesLocalDirectory',
        xmlContent: xml,
        addToProject: false,
      }),
    );
    expect((result as any).isError).toBeFalsy();
  });

  it('returns error when objectType is missing', async () => {
    await expect(
      handleCreateD365File(req('create_d365fo_file', { objectName: 'Foo', modelName: 'MyModel' })),
    ).rejects.toThrow();
  });

  it('returns error when objectName is missing', async () => {
    await expect(
      handleCreateD365File(req('create_d365fo_file', { objectType: 'class', modelName: 'MyModel' })),
    ).rejects.toThrow();
  });
});

// ─── modify_d365fo_file ──────────────────────────────────────────────────────

describe('modify_d365fo_file', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('adds a method to an existing class file', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxClass><Name>ExistingClass</Name><SourceCode><Declaration><![CDATA[public class ExistingClass {}]]></Declaration><Methods /></SourceCode></AxClass>`,
    );
    (fsMod.writeFile as any).mockResolvedValueOnce(undefined);

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'class',
        objectName: 'ExistingClass',
        operation: 'add-method',
        methodName: 'run',
        methodCode: 'ttsbegin;\nttscommit;',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\ExistingClass.xml',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when required args are missing', async () => {
    const result = await modifyD365FileTool(req('modify_d365fo_file', {}), ctx);
    expect(result.isError).toBe(true);
  });

  it('returns error when file cannot be read', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'class',
        objectName: 'Missing',
        operation: 'add-method',
        methodName: 'run',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\Missing.xml',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot read|error|file/i);
  });
});
