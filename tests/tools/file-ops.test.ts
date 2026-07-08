/**
 * File Operation Tools Tests
 * Covers: create_d365fo_file, modify_d365fo_file,
 *         validate_object_naming, verify_d365fo_project
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateObjectNamingTool } from '../../src/tools/validateObjectNaming';
import { getExtensionNamingStyle } from '../../src/utils/modelClassifier';
import { verifyD365ProjectTool } from '../../src/tools/verifyD365Project';
import { handleCreateD365File } from '../../src/tools/createD365File';
import { modifyD365FileTool, countTopLevelMethodBodies, splitTopLevelMethodBodies, isUnresolvedObjectError, extractMethodNameFromSource } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeReplaceAllFields } = vi.hoisted(() => ({
  mockBridgeReplaceAllFields: vi.fn(async () => ({
    success: true,
    message: '✅ Fields replaced',
    fieldsAdded: 1,
  })),
}));

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
  // Drive/root paths exist; individual files do not (prevents false "file already exists" errors).
  access: vi.fn(async (p: string) => {
    if (/^[A-Za-z]:[\\\/]?$/.test(p) || p === '/') return; // drive root or fs root
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1024 })),
  readdir: vi.fn(async () => []),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeReplaceAllFields: mockBridgeReplaceAllFields,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

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
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
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
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  getExtensionNamingStyle: vi.fn(() => 'prefix'),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
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

  it('passes a name with prefix-separator underscore (Prefix_Name pattern)', async () => {
    // MY_ auto-detected as prefix from first two chars → MY_InvoiceHelper is valid
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'MY_InvoiceHelper', objectType: 'class' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/valid|pass|no error/i);
  });

  it('passes MY_VendPaymTermsMaintain as security-privilege with explicit modelPrefix', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'MY_VendPaymTermsMaintain',
        objectType: 'security-privilege',
        modelPrefix: 'MY',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // Name must pass — no ERRORS block (underscore is allowed as prefix separator)
    expect(result.content[0].text).not.toMatch(/ERRORS \(\d/i);
    expect(result.content[0].text).toMatch(/valid|pass|no error/i);
  });

  it('rejects underscore at mid-name position (not a prefix separator)', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'MYVendPaymTerms_Helper',
        objectType: 'class',
        modelPrefix: 'MY',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/underscore/i);
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

// ─── validate_object_naming — EXTENSION_NAMING_STYLE=model-name ───────────────
// Under the model-name style the extension token is the MODEL NAME (VS default),
// not the prefix infix. The validator must accept Base_ModelName_Extension /
// Base.ModelName and must NOT demand the prefix infix or a "…Extension" element token.
describe('validate_object_naming — model-name style', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    (ctx.symbolIndex.db as any).stmt.get.mockReturnValue(undefined);
    (ctx.symbolIndex.db as any).stmt.all.mockReturnValue([]);
    vi.mocked(getExtensionNamingStyle).mockReturnValue('model-name');
  });

  afterEach(() => {
    vi.mocked(getExtensionNamingStyle).mockReturnValue('prefix');
  });

  it('accepts a model-name class extension without errors', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTable_ContosoRobotics_Extension',
        objectType: 'class-extension',
        baseObjectName: 'CustTable',
        modelName: 'ContosoRobotics',
        modelPrefix: 'CR',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // The model-name token is correct → no prefix-infix warning, no errors.
    expect(result.content[0].text).not.toMatch(/ERRORS \(\d/);
    expect(result.content[0].text).not.toMatch(/does not include model prefix/);
    expect(result.content[0].text).toMatch(/Extension Style: model-name/);
  });

  it('warns when a class extension uses the prefix infix instead of the model name', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTableCR_Extension',
        objectType: 'class-extension',
        baseObjectName: 'CustTable',
        modelName: 'ContosoRobotics',
        modelPrefix: 'CR',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/does not embed the model name "ContosoRobotics"/);
    expect(result.content[0].text).toMatch(/CustTable_ContosoRobotics_Extension/);
  });

  it('accepts a model-name element extension (Base.ModelName, no "Extension" word)', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTable.ContosoRobotics',
        objectType: 'table-extension',
        baseObjectName: 'CustTable',
        modelName: 'ContosoRobotics',
        modelPrefix: 'CR',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/ERRORS \(\d/);
    // Must NOT demand a "…Extension" suffix under model-name style.
    expect(result.content[0].text).not.toMatch(/must end with 'Extension'/);
  });

  it('warns when an element extension uses the prefix token instead of the model name', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTable.CRExtension',
        objectType: 'table-extension',
        baseObjectName: 'CustTable',
        modelName: 'ContosoRobotics',
        modelPrefix: 'CR',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/should be the model name "ContosoRobotics"/);
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
        modelName: 'Contoso',
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
        modelName: 'Contoso',
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
        modelName: 'Contoso',
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

  it('verify-all mode: missing objects derives them from the project or asks for one', async () => {
    const result = await verifyD365ProjectTool(req('verify_d365fo_project', {}), buildContext());
    const text = result.content[0].text as string;
    // Objects are now optional: it either verifies every object referenced in a
    // resolvable project, or returns clear guidance — never a raw schema parse error.
    expect(text).toMatch(/Verification Results|no `objects`|no recognizable object/i);
  });
});

// ─── create_d365fo_file ──────────────────────────────────────────────────────

describe('create_d365fo_file', () => {
  beforeEach(async () => {
    // Reset access mock: verify_d365fo_project tests override it; restore the
    // default that makes drive roots accessible but individual files absent.
    const fsMod = await import('fs/promises');
    (fsMod.access as any).mockImplementation(async (p: string) => {
      if (/^[A-Za-z]:[\\\/]?$/.test(p) || p === '/') return;
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    (fsMod.readFile as any).mockImplementation(async (p: string) => {
      if (p.endsWith('.rnrproj')) {
        return `<Project><ItemGroup><Content Include="AxClass\\ExistingClass.xml" /></ItemGroup></Project>`;
      }
      if (p.endsWith('.xml')) {
        return `<?xml version="1.0"?><AxClass><Name>ExistingClass</Name></AxClass>`;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('creates a class file and reports success', async () => {
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'class',
        objectName: 'MyNewClass',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
      }),
    );
    // fs is fully mocked — writes succeed on all platforms.
    expect((result as any).isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/created|success|MyNewClass/i);
  });

  it('creates a table-extension file', async () => {
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table-extension',
        objectName: 'CustTable.MY_Extension',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
      }),
    );
    // fs is fully mocked — writes succeed on all platforms.
    expect((result as any).isError).toBeFalsy();
  });

  it('table-extension create passes properties.fields to the bridge (normalized to WriteFieldParam keys)', async () => {
    // Regression: the bridge create path only forwarded fields for objectType==='table',
    // so a table-extension's properties.fields were dropped and the file got an empty
    // <Fields />. Fields must be forwarded AND normalized to the bridge's WriteFieldParam
    // keys — which are `type`/`edt` (JsonPropertyName), NOT fieldType/extendedDataType.
    // Emitting the wrong keys produced a bare AxTableFieldString with no EDT (eval L2).
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTableExtension\\CustTable.MyExt.xml',
      api: 'IMetaTableExtensionProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table-extension',
        objectName: 'CustTable.MyExt',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          fields: [
            { name: 'LookAheadMonths', edt: 'BudgetNumberOfPeriods', type: 'Integer' },
            { name: 'LookBackMonths', edt: 'BudgetNumberOfPeriods', type: 'Integer' },
          ],
        },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
    const sentParams = createObject.mock.calls[0][0];
    expect(sentParams.objectType).toBe('table-extension');
    expect(sentParams.fields).toEqual([
      { name: 'LookAheadMonths', type: 'Integer', edt: 'BudgetNumberOfPeriods' },
      { name: 'LookBackMonths', type: 'Integer', edt: 'BudgetNumberOfPeriods' },
    ]);
  });

  it('table create resolves a field\'s base type from its EDT when only `edt` is given', async () => {
    // Regression (eval scenario 1 — Equipment Rental): d365fo_file(create, objectType="table")
    // never resolved a field's base type from its EDT — only generateSmartTable/generate_object
    // did. C# CreateTableField() defaults any field whose `type` is unset to AxTableFieldString,
    // so a Real-based EDT (e.g. a daily-rate EDT extending AmountCur) or a Date-based EDT
    // silently became a string field. Reproduced live: a table field `{ name: "DailyRate", edt:
    // "AC_RentDailyRate" }` (EDT extends AmountCur, a Real EDT) was written as
    // i:type="AxTableFieldString" — no build error, just silently wrong, until later X++ against
    // the field (e.g. Qty * DailyRate) fails to compile.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          fields: [
            { name: 'DailyRate', edt: 'ContosoRentDailyRate' }, // no explicit type — must be resolved
          ],
        },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
    const sentParams = createObject.mock.calls[0][0];
    // No index/bridge EDT info available in this unit test — falls back to the name heuristic,
    // which recognizes "...Rate" as Real. The point under test is that `type` is populated
    // AT ALL from the edt, not left undefined (which the bridge treats as "String").
    expect(sentParams.fields[0].type).toBe('Real');
    expect(sentParams.fields[0].edt).toBe('ContosoRentDailyRate');
  });

  it('table create resolves BOTH type and enumType for a field whose EDT is itself Enum-backed', async () => {
    // Regression (eval scenario 2 — sales credit review + audit): the field-type resolution
    // added for the test above handles Real/Date/Int64 EDTs, but an EDT whose OWN base type is
    // Enum (e.g. the standard "Posted" EDT, which extends the "NoYes" enum) only got as far as
    // `type: 'Enum'` — nothing populated `enumType`, so the bridge could not emit a valid
    // AxTableFieldEnum and silently fell back to AxTableFieldString. Reproduced live: a table
    // field `{ name: "Posted", edt: "Posted" }` (no explicit enumType) was written as
    // i:type="AxTableFieldString" with ExtendedDataType=Posted — no build error, just silently
    // the wrong storage kind.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };
    // Distinguish the two DIFFERENT queries this path issues against the same fake db:
    // isEnumName() probes the `symbols` table (is "Posted" itself an enum name? no — it's
    // an EDT), while resolveEdtBaseType()/resolveEdtEnumType() probe `edt_metadata` (what
    // does the "Posted" EDT extend? the "NoYes" enum). A mock that didn't discriminate by
    // SQL text would make isEnumName() false-positive on the edt_metadata row and short
    // -circuit before the code under test ever runs.
    (ctx.symbolIndex.db as any).prepare = vi.fn((sql: string) => ({
      get: (arg: string) => {
        if (/FROM symbols/.test(sql)) return undefined; // isEnumName: "Posted" is not itself an enum
        if (String(arg).toLowerCase() === 'posted') {
          return { extends: null, enum_type: 'NoYes', string_size: null };
        }
        return undefined;
      },
    }));

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          fields: [
            { name: 'Posted', edt: 'Posted' }, // no explicit type/enumType — must be resolved
          ],
        },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
    const sentParams = createObject.mock.calls[0][0];
    expect(sentParams.fields[0].type).toBe('Enum');
    expect(sentParams.fields[0].enumType).toBe('NoYes');
  });

  it('table create routes through the bridge\'s BP-smart createSmartTable path, not the generic createObject/CreateTable RPC', async () => {
    // Regression (eval corpus: L1-table-basic, L3-form-detailstransaction, L4-ssrs-report-basic —
    // 2026-07-06/07 runs, golden_diff missing CacheLookup/ClusteredIndex/PrimaryIndex/
    // ReplacementKey/TitleField1/TitleField2 and all 5 standard FieldGroups). d365fo_file(action=
    // "create", objectType="table") went straight to the bridge's generic createObject RPC, which
    // dispatches to C# CreateTable() — a bare writer that only emits exactly what the caller
    // passed. The bridge ALSO exposes createSmartTable (C# CreateSmartTable()), which auto-derives
    // CacheLookup/TitleField1/TitleField2/PrimaryIndex/ClusteredIndex/ReplacementKey and the 5
    // standard FieldGroups — but only generate_object(mode="scaffold"/"generate", objectType=
    // "table") used it. The plain create verb — the one a generic "create a table" instruction
    // naturally maps to — never did, silently producing a BP-defaults-free skeleton. Fixed by
    // trying createSmartTable first for objectType==='table' and only falling back to the generic
    // path if it's unavailable/fails.
    const createSmartTable = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create (Smart)',
      bpDefaults: {
        cacheLookup: 'Found',
        titleField1: 'Subject',
        titleField2: 'NoteId',
        primaryIndex: 'NoteIdx',
        clusteredIndex: 'NoteIdx',
      },
    }));
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = {
      isReady: true,
      metadataAvailable: true,
      createSmartTable,
      createObject,
      validateObject: vi.fn(async () => null),
    };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          tableGroup: 'Main',
          label: 'My table',
          fields: [{ name: 'NoteId', type: 'String', mandatory: true }],
          indexes: [{ name: 'NoteIdx', fields: ['NoteId'], unique: true }],
        },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createSmartTable).toHaveBeenCalledTimes(1);
    expect(createObject).not.toHaveBeenCalled();

    const sentParams = createSmartTable.mock.calls[0][0];
    expect(sentParams.objectName).toBe('MyTable');
    expect(sentParams.tableGroup).toBe('Main');
    expect(sentParams.label).toBe('My table');
    expect(sentParams.fields).toEqual([{ name: 'NoteId', type: 'String', mandatory: true }]);
    // tableGroup/tableType/label must NOT be duplicated into extraProperties.
    expect(sentParams.extraProperties).toBeUndefined();

    expect(result.content[0].text).toMatch(/Smart/);
    expect(result.content[0].text).toMatch(/BP defaults/);
  });

  it('table create falls back to the generic createObject/CreateTable RPC when the bridge has no createSmartTable support', async () => {
    // Same defect as above, opposite side: an older/degraded bridge that only exposes the
    // generic createObject RPC (no createSmartTable) must still succeed via the pre-existing
    // fallback path — the smart-table routing must never be a hard requirement.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create',
    }));
    const ctx = buildContext();
    // No createSmartTable on this bridge mock at all.
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { fields: [{ name: 'NoteId', type: 'String' }] },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
  });

  it('table create resolves a "...DateTime"-named EDT to UtcDateTime, not String', async () => {
    // Regression (eval scenario 2): heuristicEdtBaseType('TransDateTime') used to return
    // undefined (see edt-resolution.test.ts for the root cause), so with no index entry
    // for the EDT either, a field `{ name: "PostedAt", edt: "TransDateTime" }` fell all the
    // way through to the bridge's AxTableFieldString default instead of AxTableFieldUtcDateTime.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };
    // No index entry for TransDateTime — forces the heuristic fallback.
    (ctx.symbolIndex.db as any).stmt.get.mockReturnValue(undefined);

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          fields: [
            { name: 'PostedAt', edt: 'TransDateTime' },
          ],
        },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    const sentParams = createObject.mock.calls[0][0];
    expect(sentParams.fields[0].type).toBe('UtcDateTime');
  });

  it('table create normalizes properties.indexes (indexName/indexFields -> name/fields)', async () => {
    // Regression (eval scenario 1 — Equipment Rental): the only index shape documented
    // anywhere in the tool (modify operation="add-index") is { indexName, indexFields:
    // [{fieldName}] } — and modifyD365File.ts correctly translates those keys before calling
    // the bridge. But d365fo_file(create, objectType="table", properties.indexes=[...]) forwarded
    // properties.indexes UNTRANSLATED. WriteIndexParam has no indexName/indexFields properties,
    // so System.Text.Json silently drops both — create still reports success, but the written
    // index has an empty Name and empty Fields, which xppc rejects at build time ("the name of
    // the '1st' index is not valid"). Reproduced live against a real table create.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml',
      api: 'IMetaTableProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          fields: [{ name: 'MyId', edt: 'RefRecId', type: 'Int64' }],
          indexes: [{ indexName: 'MyIdIdx', alternateKey: true, indexFields: [{ fieldName: 'MyId' }] }],
        },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
    const sentParams = createObject.mock.calls[0][0];
    expect(sentParams.indexes).toEqual([{ name: 'MyIdIdx', fields: ['MyId'], alternateKey: true }]);
  });

  it('enum-extension create forwards properties.enumValues to the bridge as `values`', async () => {
    // Regression (eval scenario 1 — Equipment Rental): only objectType==='enum' populated
    // bridgeParams.values, so an enum-extension's properties.enumValues never reached the
    // bridge. C# CreateEnumExtension(name, modelName, values, properties) happily accepts a
    // values list, but was always invoked with null — the write reported success while
    // <EnumValues /> came back empty on disk. Reproduced live: adding a "Rent" value to the
    // standard NumberSeqModule enum via objectType="enum-extension" wrote an empty
    // <EnumValues /> despite enumValues:[{name:"Rent"}] being passed.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxEnumExtension\\NumberSeqModule.MyExt.xml',
      api: 'IMetaEnumExtensionProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'enum-extension',
        objectName: 'NumberSeqModule',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { enumValues: [{ name: 'Rent', label: '@Contoso:RentModule' }] },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
    const sentParams = createObject.mock.calls[0][0];
    expect(sentParams.values).toEqual([{ name: 'Rent', label: '@Contoso:RentModule' }]);
  });

  it('edt create translates properties.edtType to the bridge\'s BaseType key', async () => {
    // Regression (eval scenario 1 — Equipment Rental): C# CreateEdt() picks the concrete
    // AxEdt subclass via `properties.TryGetValue("BaseType", ...)` — a literal, case-sensitive
    // dictionary lookup. The tool's documented/schema property name is `edtType` (see
    // suggest_edt / prepare / d365fo_file docs), so it never matched and every bridge-created
    // EDT silently defaulted to AxEdtString no matter what type was requested. Verified live:
    // edtType:"Real" + extends:"AmountCur" wrote i:type="AxEdtString" to disk.
    const createObject = vi.fn(async () => ({
      success: true,
      filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxEdt\\MyDailyRate.xml',
      api: 'IMetaEdtProvider.Create',
    }));
    const ctx = buildContext();
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, createObject, validateObject: vi.fn(async () => null) };

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'edt',
        objectName: 'DailyRate',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { label: '@Contoso:DailyRate', extends: 'AmountCur', edtType: 'Real' },
      }),
      ctx,
    );

    expect((result as any).isError).toBeFalsy();
    expect(createObject).toHaveBeenCalledTimes(1);
    const sentParams = createObject.mock.calls[0][0];
    expect(sentParams.properties.BaseType).toBe('Real');
    expect(sentParams.properties.edtType).toBeUndefined();
    expect(sentParams.properties.Extends ?? sentParams.properties.extends).toBe('AmountCur');
  });

  it('blocks form-extension create when xmlContent uses the malformed control shape', async () => {
    // Guard: the deserializer-rejecting shape an AI tends to hand-write
    // (AxFormControlExtension / ParentControlName / FormControlExtension-wrapping / AxFormIntControl)
    // must be caught at write time with the correct template — not silently written.
    const malformed =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
      `\t<Name>BudgetControlConfiguration.MyExt</Name>\n` +
      `\t<Controls>\n` +
      `\t\t<AxFormControlExtension>\n` +
      `\t\t\t<Name>X</Name>\n` +
      `\t\t\t<ParentControlName>Tab</ParentControlName>\n` +
      `\t\t\t<FormControlExtension>\n` +
      `\t\t\t\t<AxFormIntControl><Name>X</Name></AxFormIntControl>\n` +
      `\t\t\t</FormControlExtension>\n` +
      `\t\t</AxFormControlExtension>\n` +
      `\t</Controls>\n` +
      `</AxFormExtension>`;

    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'form-extension',
        objectName: 'BudgetControlConfiguration.MyExt',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        overwrite: true,
        xmlContent: malformed,
      }),
    );

    expect((result as any).isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/AxFormExtensionControl xmlns=""/);   // correct wrapper shown
    expect(text).toMatch(/AxFormIntegerControl/);              // correct integer element shown
    expect(text).toMatch(/<Parent>/);                          // correct parent element shown
  });

  it('auto-converts bare extension name to dot-notation (Case C fix)', async () => {
    // Bug: objectType="table-extension", objectName="PurchTable" (no dot) used to
    // fall into NORMAL CASE of applyObjectPrefix and produce "ContosoPurchTable".
    // Fix: Case C should append ".Extension" so applyObjectPrefix handles it correctly.
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'table-extension',
        objectName: 'PurchTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
      }),
    );
    // fs is fully mocked — writes succeed on all platforms.
    // We inspect the path embedded in the message: it must use dot-notation
    // (PurchTable.<something>Extension.xml) and NOT a flat prefix (MyModelPurchTable.xml).
    const text: string = result.content[0].text;
    expect(text).toMatch(/PurchTable[.][^/\\]*[Ee]xtension/);
    expect(text).not.toMatch(/MyModelPurchTable|[A-Za-z]+PurchTable\.xml/);
  });

  it('supports security-duty-extension: dot-notation naming + AxSecurityDutyExtension folder + XML', async () => {
    // Gap found live (2026-07-01 usage-examples eval, scenario 2): d365fo_file had no
    // security-duty-extension/security-role-extension objectType even though
    // AxSecurityDutyExtension/AxSecurityRoleExtension are real, common Microsoft AOT
    // types (e.g. ApplicationCommon\AxSecurityDutyExtension\BatchJobMaintain...xml) used
    // to add a privilege to an EXISTING duty without overlaying it. Verifies the bare
    // base name ("SalesOrderProgressInquire") follows the same dot-notation path as
    // menu-extension/table-extension, lands in the AxSecurityDutyExtension folder, and
    // the written XML references the given privilege.
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'security-duty-extension',
        objectName: 'SalesOrderProgressInquire',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { privileges: ['ContosoSalesPostingAuditLogView'] },
      }),
    );
    const text: string = result.content[0].text;
    expect((result as any).isError).not.toBe(true);
    expect(text).toMatch(/AxSecurityDutyExtension/);
    expect(text).toMatch(/SalesOrderProgressInquire[.][^/\\]*[Ee]xtension/);
    expect(text).not.toMatch(/[A-Za-z]+SalesOrderProgressInquire\.xml/);
  });

  it('supports security-role-extension: dot-notation naming + AxSecurityRoleExtension folder + XML', async () => {
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'security-role-extension',
        objectName: 'SystemUser',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { duties: ['ContosoAuditInquireDuty'] },
      }),
    );
    const text: string = result.content[0].text;
    expect((result as any).isError).not.toBe(true);
    expect(text).toMatch(/AxSecurityRoleExtension/);
    expect(text).toMatch(/SystemUser[.][^/\\]*[Ee]xtension/);
    expect(text).not.toMatch(/[A-Za-z]+SystemUser\.xml/);
  });

  it('auto-converts bare class-extension name to _Extension form (Case D fix)', async () => {
    // Bug: objectType="class-extension", objectName="SalesFormLetter" (no "_Extension"
    // suffix) used to have no dot and not end in "_Extension", so it fell into
    // applyObjectPrefix's NORMAL CASE and was treated as a brand-new object — wrongly
    // producing "<Prefix>SalesFormLetter" (e.g. "CrSalesFormLetter"). class-extension
    // was the only extension type missing the bare-name normalisation that the
    // dot-notation types got in Case C.
    // Fix: Case D appends "_Extension" so applyObjectPrefix routes it through the
    // extension-class branch.
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'class-extension',
        objectName: 'SalesFormLetter',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
      }),
    );
    // applyObjectPrefix is mocked to identity here, so the message path reflects the
    // effectiveObjectName transformation only: it must be "SalesFormLetter_Extension.xml"
    // and NOT the bare "SalesFormLetter.xml" (which would prove Case D did not fire and
    // the name would later be mangled by the real applyObjectPrefix NORMAL CASE).
    const text: string = result.content[0].text;
    expect(text).toMatch(/SalesFormLetter_Extension\.xml/);
    expect(text).not.toMatch(/[\\/]SalesFormLetter\.xml/);
  });

  it('Case D × model-name style: bare class-extension name produces Base_ModelName_Extension', async () => {
    // Verify that Case D (append _Extension) + Case B (strip model-name infix) +
    // applyObjectPrefix (model-name branch) all compose correctly when
    // EXTENSION_NAMING_STYLE=model-name.
    // Input:  objectType="class-extension", objectName="SalesFormLetter" (bare, no suffix)
    // Expected output file: SalesFormLetter_ContosoRobotics_Extension.xml
    //   1. Case D: "SalesFormLetter" → "SalesFormLetter_Extension"
    //   2. applyObjectPrefix (model-name branch): injects model name →
    //      "SalesFormLetter_ContosoRobotics_Extension"
    // applyObjectPrefix is mocked to identity, so we can only confirm Case D fired
    // (name ends with _Extension and is not the bare name). The configManager mock
    // returns 'MyModel' as model name, so we verify the _Extension suffix is present.
    vi.mocked(getExtensionNamingStyle).mockReturnValue('model-name');
    try {
      const result = await handleCreateD365File(
        req('create_d365fo_file', {
          objectType: 'class-extension',
          objectName: 'SalesFormLetter',
          modelName: 'ContosoRobotics',
          packageName: 'ContosoRobotics',
          packagePath: 'K:\\PackagesLocalDirectory',
          addToProject: false,
        }),
      );
      const text: string = result.content[0].text;
      // Case D must have fired: _Extension suffix present
      expect(text).toMatch(/SalesFormLetter_Extension\.xml/);
      // Must NOT fall into the NORMAL CASE (prefix-prepend on bare name)
      expect(text).not.toMatch(/[\\/]SalesFormLetter\.xml/);
    } finally {
      vi.mocked(getExtensionNamingStyle).mockReturnValue('prefix');
    }
  });

  it('creates a class from custom xmlContent (hybrid scenario)', async () => {
    const xml = `<?xml version="1.0"?><AxClass><Name>MyHybridClass</Name></AxClass>`;
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'class',
        objectName: 'MyHybridClass',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        xmlContent: xml,
        addToProject: false,
      }),
    );
    // fs is fully mocked — writes succeed on all platforms.
    expect((result as any).isError).toBeFalsy();
  });

  it('rejects HTML-entity-escaped xmlContent instead of silently writing garbage', async () => {
    const escaped = `&lt;?xml version="1.0"?&gt;&lt;AxClass&gt;&lt;Name&gt;MyHybridClass&lt;/Name&gt;&lt;/AxClass&gt;`;
    const result = await handleCreateD365File(
      req('create_d365fo_file', {
        objectType: 'class',
        objectName: 'MyHybridClass',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        xmlContent: escaped,
        addToProject: false,
      }),
    );
    expect((result as any).isError).toBeTruthy();
    expect((result as any).content[0].text).toMatch(/HTML-entity-escaped/);
  });

  it('returns error when objectType is missing', async () => {
    await expect(
      handleCreateD365File(req('create_d365fo_file', { objectName: 'Foo', modelName: 'Contoso' })),
    ).rejects.toThrow();
  });

  it('returns error when objectName is missing', async () => {
    await expect(
      handleCreateD365File(req('create_d365fo_file', { objectType: 'class', modelName: 'Contoso' })),
    ).rejects.toThrow();
  });
});

// ─── modify_d365fo_file ──────────────────────────────────────────────────────

describe('modify_d365fo_file', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns bridge-required error when bridge is not available', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxClass><Name>ExistingClass</Name><SourceCode><Declaration><![CDATA[public class ExistingClass {}]]></Declaration><Methods /></SourceCode></AxClass>`,
    );

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
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bridge is not available/i);
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

  it('replace-code returns bridge-required error without bridge', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxClass><Name>MyClass</Name><SourceCode>` +
      `<Declaration><![CDATA[public class MyClass {}]]></Declaration>` +
      `<Methods><Method><Name>run</Name><Source><![CDATA[public void run()\n{\n    return false;\n}]]></Source></Method></Methods>` +
      `</SourceCode></AxClass>`,
    );

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'class',
        objectName: 'MyClass',
        operation: 'replace-code',
        methodName: 'run',
        oldCode: 'return false;',
        newCode: 'return true;',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\MyClass.xml',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bridge is not available/i);
  });

  it('add-index maps indexFields objects to a flat field-name string[] for the bridge', async () => {
    // Regression: indexFields is documented as [{ fieldName, direction? }], but the
    // bridge's addIndex expects string[]. Passing the objects straight through made
    // the C# side fail to deserialize [{fieldName:…}] into List<string>, surfacing as
    // a null bridge result misreported as "could not resolve table".
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = {
      isReady: true,
      metadataAvailable: true,
      addIndex,
      // bridgeValidateAfterWrite is fire-and-forget; provide a no-op surface.
      validateObject: vi.fn(async () => null),
    };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
        indexAllowDuplicates: false,
        indexAlternateKey: true,
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addIndex).toHaveBeenCalledTimes(1);
    const [tableName, indexName, fields, allowDuplicates, alternateKey] = addIndex.mock.calls[0];
    expect(tableName).toBe('ContosoRentEquipmentTable');
    expect(indexName).toBe('EquipmentIdx');
    // The critical assertion: a flat array of strings, not [{ fieldName }] objects.
    expect(fields).toEqual(['ContosoRentEquipmentId']);
    expect(allowDuplicates).toBe(false);
    expect(alternateKey).toBe(true);
  });

  it('add-relation maps relationConstraints {fieldName,relatedFieldName} to {field,relatedField}', async () => {
    // Regression: relationConstraints is documented as [{ fieldName, relatedFieldName }] but the
    // C# WriteRelationConstraint deserializes { field, relatedField }. Without remapping, C# sees
    // null keys and silently writes a relation with empty constraints (no error, corruption at
    // compile time).
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addRelation = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = {
      isReady: true,
      metadataAvailable: true,
      addRelation,
      validateObject: vi.fn(async () => null),
    };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-relation',
        relationName: 'ContosoRentCategory',
        relatedTable: 'ContosoRentCategoryTable',
        relationConstraints: [{ fieldName: 'CategoryId', relatedFieldName: 'CategoryId' }],
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addRelation).toHaveBeenCalledTimes(1);
    const [, , , constraints] = addRelation.mock.calls[0];
    expect(constraints).toEqual([{ field: 'CategoryId', relatedField: 'CategoryId' }]);
  });

  it('surfaces the real bridge error (not a generic "could not resolve") on a non-resolution failure', async () => {
    // Regression for the masking bug: adapter catch used to swallow the C# error and
    // return null, which the tool reported as "could not resolve table". Now the real
    // message must come through.
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => {
      throw new Error("Bridge error [BadRequest]: index 'EquipmentIdx' already exists");
    });
    const refreshProvider = vi.fn(async () => ({ refreshed: true, elapsedMs: 1 }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addIndex, refreshProvider };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already exists/i);
    // A non-resolution failure must NOT trigger the refresh+retry, and must NOT be
    // dressed up as "could not resolve".
    expect(result.content[0].text).not.toMatch(/could not resolve/i);
    expect(addIndex).toHaveBeenCalledTimes(1);
    expect(refreshProvider).not.toHaveBeenCalled();
  });

  it('refresh-retries once on an object-resolution failure, then surfaces guidance + bridge message', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValue(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => {
      throw new Error("Bridge error [NotFound]: Table 'ContosoRentEquipmentTable' not found");
    });
    const refreshProvider = vi.fn(async () => ({ refreshed: true, elapsedMs: 1 }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addIndex, refreshProvider };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    // Resolution failure: retried exactly once (2 attempts), refresh attempted.
    expect(addIndex).toHaveBeenCalledTimes(2);
    expect(refreshProvider).toHaveBeenCalledTimes(1);
    // Keeps the actionable same-session guidance AND shows what the bridge reported.
    expect(result.content[0].text).toMatch(/could not resolve/i);
    expect(result.content[0].text).toMatch(/Bridge reported:/);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it('derives objectName from filePath when objectName is omitted', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addIndex, refreshProvider: vi.fn() };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        // objectName intentionally omitted — must be derived from filePath basename
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addIndex).toHaveBeenCalledTimes(1);
    expect(addIndex.mock.calls[0][0]).toBe('ContosoRentEquipmentTable');
  });

  it('errors clearly when both objectName and filePath are omitted', async () => {
    const result = await modifyD365FileTool(
      req('modify_d365fo_file', { objectType: 'table', operation: 'add-index', indexName: 'X', indexFields: [{ fieldName: 'Y' }] }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/objectName|filePath/);
  });

  it('add-method accepts multiple methods (no single-method rejection)', async () => {
    const twoMethods =
      `public int lastLineNum()\n{\n    return 0;\n}\n\n` +
      `public AmountCur calcLineAmount()\n{\n    return this.Qty * this.Price;\n}`;
    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentAgreementLine',
        operation: 'add-method',
        methodName: 'lastLineNum',
        sourceCode: twoMethods,
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentAgreementLine.xml',
      }),
      ctx,
    );
    // Multiple methods are now split and added one at a time — the old single-method
    // guard no longer fires (this env has no bridge, so it fails later at the bridge).
    expect(result.content[0].text).not.toMatch(/exactly ONE method|method bodies were detected/i);
  });

  it('splitTopLevelMethodBodies splits multiple methods, preserving each body and doc comments', () => {
    const src =
      `/// <summary>first</summary>\npublic int lastLineNum()\n{\n    if (x) { y(); }\n    return 0;\n}\n\n` +
      `public AmountCur calcLineAmount()\n{\n    return this.Qty * this.Price;\n}`;
    const parts = splitTopLevelMethodBodies(src);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('lastLineNum');
    expect(parts[0]).toContain('first');           // leading doc comment retained
    expect(parts[0]).toContain('if (x) { y(); }');  // nested block kept with method 1
    expect(parts[1]).toContain('calcLineAmount');
    expect(parts[1]).not.toContain('lastLineNum');
    // A single method round-trips unchanged.
    expect(splitTopLevelMethodBodies(`public void run()\n{\n    a();\n}`)).toHaveLength(1);
  });

  it('countTopLevelMethodBodies counts methods, ignoring nested blocks/comments/strings', () => {
    const oneWithNesting =
      `public void run()\n{\n    if (this.x) { this.y(); }\n    while (a) { b(); }\n    str s = "a) { fake";\n}`;
    expect(countTopLevelMethodBodies(oneWithNesting)).toBe(1);
    // A CoC skeleton wraps the method in a class, so the method body is at depth 1,
    // not top-level → counts 0. That's intended: class-wrapped methods are validly
    // scoped, so the guard (reject > 1) never fires on them — it targets only BARE
    // multi-method payloads, which are what land outside the class scope.
    const cocSkeleton =
      `[ExtensionOf(classStr(NumberSeqApplicationModule))]\nfinal class Foo_Extension\n{\n    public void loadModule()\n    {\n        next loadModule();\n    }\n}`;
    expect(countTopLevelMethodBodies(cocSkeleton)).toBe(0);
    const two =
      `public int a()\n{\n    return 0;\n}\npublic int b()\n{\n    return 1;\n}`;
    expect(countTopLevelMethodBodies(two)).toBe(2);
  });

  it('resolves an unprefixed objectName via the model prefix (RentEquipmentTable → ContosoRentEquipmentTable)', async () => {
    const fsMod = await import('fs/promises');
    const mc = await import('../../src/utils/modelClassifier');
    const origResolve = vi.mocked(mc.resolveObjectPrefix).getMockImplementation();
    const origApply = vi.mocked(mc.applyObjectPrefix).getMockImplementation();
    vi.mocked(mc.resolveObjectPrefix).mockReturnValue('Contoso');
    vi.mocked(mc.applyObjectPrefix).mockImplementation((n: string) =>
      n.toLowerCase().startsWith('contoso') ? n : `Contoso${n}`);
    // Only the PREFIXED file exists on disk; the bare name does not.
    (fsMod.access as any).mockImplementation(async (p: string) => {
      if (/ContosoRentEquipmentTable\.xml$/i.test(p)) return;
      if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/') return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fsMod.readFile as any).mockResolvedValue(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addIndex, refreshProvider: vi.fn() };

    try {
      const result = await modifyD365FileTool(
        req('modify_d365fo_file', {
          objectType: 'table',
          objectName: 'RentEquipmentTable', // no Contoso prefix — must be auto-resolved
          operation: 'add-index',
          indexName: 'ContosoRentEquipmentIdx',
          indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
          modelName: 'Contoso',
        }),
        ctx,
      );
      expect(result.isError).toBeFalsy();
      // The bridge gets the prefixed name, derived from the resolved file basename.
      expect(addIndex.mock.calls[0][0]).toBe('ContosoRentEquipmentTable');
    } finally {
      if (origResolve) vi.mocked(mc.resolveObjectPrefix).mockImplementation(origResolve);
      if (origApply) vi.mocked(mc.applyObjectPrefix).mockImplementation(origApply);
    }
  });

  it('isUnresolvedObjectError distinguishes object resolution from content/member misses', () => {
    // Genuine object-resolution failures (retry-worthy)
    expect(isUnresolvedObjectError("Table 'ContosoRentEquipmentTable' not found")).toBe(true);
    expect(isUnresolvedObjectError("Form 'ContosoX' not found")).toBe(true);
    expect(isUnresolvedObjectError("Cannot determine model for existing object 'ContosoRentModule'")).toBe(true);
    expect(isUnresolvedObjectError('could not resolve table')).toBe(true);
    // Content / member misses (NOT object resolution — must not trigger retry/guidance)
    expect(isUnresolvedObjectError('Error in replaceCode: oldCode not found in ContosoRentEquipmentTable.classDeclaration')).toBe(false);
    expect(isUnresolvedObjectError("Index 'EquipmentIdx' not found on table 'ContosoRentEquipmentTable'")).toBe(false);
    expect(isUnresolvedObjectError('index already exists')).toBe(false);
    expect(isUnresolvedObjectError(undefined)).toBe(false);
  });

  it('extractMethodNameFromSource reads the name from the signature', () => {
    expect(extractMethodNameFromSource('public static ContosoRentParameters find(boolean _f = false)\n{\n}')).toBe('find');
    expect(extractMethodNameFromSource('/// <summary>x</summary>\npublic void run()\n{\n}')).toBe('run');
    expect(extractMethodNameFromSource('[ExtensionOf(classStr(Foo))]\nfinal class B\n{\n  public void loadModule() {}\n}')).toBe('loadModule');
    expect(extractMethodNameFromSource(undefined)).toBeNull();
  });

  it('add-method derives methodName from the source signature and decodes XML entities', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentParameters</Name></AxTable>`,
    );
    const addMethod = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addMethod, refreshProvider: vi.fn(), validateObject: vi.fn(async () => null) };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentParameters',
        operation: 'add-method',
        // methodName omitted on purpose; entity-escaped doc comment
        methodCode: '/// &lt;summary&gt;Finds the params.&lt;/summary&gt;\npublic static ContosoRentParameters find(boolean _forUpdate = false)\n{\n    ContosoRentParameters p;\n    return p;\n}',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentParameters.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addMethod).toHaveBeenCalledTimes(1);
    const [, , methodName, source] = addMethod.mock.calls[0];
    expect(methodName).toBe('find');                 // derived from signature
    expect(source).toContain('/// <summary>');       // entities decoded
    expect(source).not.toContain('&lt;');
  });

  it('add-method skips class/extension declaration block and adds the real methods', async () => {
    // Regression #4: agent passes classDeclaration + multiple method bodies in one sourceCode.
    // The class declaration block has no method signature ("final class Foo_Extension {}") so
    // extractMethodNameFromSource returns null for it. Previously this threw; now it is silently
    // skipped and only the actual methods are added.
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxClass><Name>ContosoRentAgreementTable_Extension</Name></AxClass>`,
    );
    const addMethod = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addMethod, refreshProvider: vi.fn(), validateObject: vi.fn(async () => null) };

    const classDecl = `[ExtensionOf(tableStr(ContosoRentAgreementTable))]\nfinal class ContosoRentAgreementTable_Extension\n{\n}`;
    const method1  = `public void validateStatus()\n{\n    // TODO\n}`;
    const method2  = `public void computeTotals()\n{\n    // TODO\n}`;

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentAgreementTable_Extension',
        operation: 'add-method',
        sourceCode: `${classDecl}\n\n${method1}\n\n${method2}`,
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\ContosoRentAgreementTable_Extension.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    // Class declaration block is skipped; only the 2 real methods are added.
    expect(addMethod).toHaveBeenCalledTimes(2);
    const names = addMethod.mock.calls.map((c: any[]) => c[2]);
    expect(names).toContain('validateStatus');
    expect(names).toContain('computeTotals');
  });

  it('replace-code returns bridge-required error when oldCode is not found (no bridge)', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxClass><Name>MyClass</Name><SourceCode>` +
      `<Declaration><![CDATA[public class MyClass {}]]></Declaration>` +
      `<Methods><Method><Name>run</Name><Source><![CDATA[public void run()\n{\n    ttsbegin;\n    ttscommit;\n}]]></Source></Method></Methods>` +
      `</SourceCode></AxClass>`,
    );

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'class',
        objectName: 'MyClass',
        operation: 'replace-code',
        methodName: 'run',
        oldCode: 'return false;',
        newCode: 'return true;',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\MyClass.xml',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bridge is not available/i);
  });

  it('add-index maps indexFields objects to a flat field-name string[] for the bridge', async () => {
    // Regression: indexFields is documented as [{fieldName, direction?}] but the bridge
    // expects a flat string[]. Without mapping, C# receives [{fieldName:…}] deserialized
    // as List<string> with null entries — silently creates an index with no fields.
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = {
      isReady: true,
      metadataAvailable: true,
      addIndex,
      validateObject: vi.fn(async () => null),
    };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
        indexAllowDuplicates: false,
        indexAlternateKey: true,
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addIndex).toHaveBeenCalledTimes(1);
    const [tableName, indexName, fields, allowDuplicates, alternateKey] = addIndex.mock.calls[0];
    expect(tableName).toBe('ContosoRentEquipmentTable');
    expect(indexName).toBe('EquipmentIdx');
    // The critical assertion: a flat array of strings, not [{ fieldName }] objects.
    expect(fields).toEqual(['ContosoRentEquipmentId']);
    expect(allowDuplicates).toBe(false);
    expect(alternateKey).toBe(true);
  });

  it('add-relation maps relationConstraints {fieldName,relatedFieldName} to {field,relatedField}', async () => {
    // Regression: relationConstraints is documented as [{fieldName, relatedFieldName}] but the
    // C# WriteRelationConstraint deserializes {field, relatedField}. Without remapping, C# sees
    // null keys and silently writes a relation with empty constraints.
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addRelation = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = {
      isReady: true,
      metadataAvailable: true,
      addRelation,
      validateObject: vi.fn(async () => null),
    };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentEquipmentTable',
        operation: 'add-relation',
        relationName: 'ContosoRentCategory',
        relatedTable: 'ContosoRentCategoryTable',
        relationConstraints: [{ fieldName: 'CategoryId', relatedFieldName: 'CategoryId' }],
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addRelation).toHaveBeenCalledTimes(1);
    const [, , , constraints] = addRelation.mock.calls[0];
    expect(constraints).toEqual([{ field: 'CategoryId', relatedField: 'CategoryId' }]);
  });

  it('derives objectName from filePath when objectName is omitted', async () => {
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValueOnce(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentEquipmentTable</Name></AxTable>`,
    );

    const addIndex = vi.fn(async () => ({ success: true, api: 'IMetaTableProvider.Update' }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addIndex, validateObject: vi.fn(async () => null) };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        // objectName intentionally omitted — must be derived from filePath basename
        operation: 'add-index',
        indexName: 'EquipmentIdx',
        indexFields: [{ fieldName: 'ContosoRentEquipmentId' }],
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentEquipmentTable.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(addIndex).toHaveBeenCalledTimes(1);
    expect(addIndex.mock.calls[0][0]).toBe('ContosoRentEquipmentTable');
  });

  it('errors clearly when both objectName and filePath are omitted', async () => {
    const result = await modifyD365FileTool(
      req('modify_d365fo_file', { objectType: 'table', operation: 'add-index', indexName: 'X', indexFields: [{ fieldName: 'Y' }] }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/objectName|filePath/);
  });

  it('add-menu-item-to-menu falls back to XML when bridge fails (new menu not in bridge model)', async () => {
    // Regression: bridge throws NullRef for menus created this session because they
    // aren't in its startup-fixed metadata roots. The XML fallback must succeed.
    const fsMod = await import('fs/promises');
    const menuXml =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">\n` +
      `\t<Name>ContosoRentMenu</Name>\n` +
      `\t<Label>@TODO:LabelId</Label>\n` +
      `\t<Elements />\n` +
      `</AxMenu>`;
    // readFile is called twice: once to check for JSON metadata, once in the XML fallback.
    (fsMod.readFile as any).mockResolvedValue(menuXml);

    const addMenuItemToMenu = vi.fn(async () => {
      throw new Error('Object reference not set to an instance of an object');
    });
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addMenuItemToMenu, refreshProvider: vi.fn() };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'menu',
        objectName: 'ContosoRentMenu',
        operation: 'add-menu-item-to-menu',
        menuItemToAdd: 'ContosoRentEquipmentTable',
        menuItemToAddType: 'display',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxMenu\\ContosoRentMenu.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    // Bridge was attempted first (and failed), XML fallback wrote the file.
    expect(addMenuItemToMenu).toHaveBeenCalledTimes(1);
    const written = (fsMod.writeFile as any).mock.calls.find((c: any[]) =>
      c[0].includes('ContosoRentMenu.xml'),
    );
    expect(written).toBeDefined();
    const writtenContent: string = written[1];
    expect(writtenContent).toContain('AxMenuFunctionItem');
    expect(writtenContent).toContain('<MenuItemName>ContosoRentEquipmentTable</MenuItemName>');
    expect(writtenContent).toContain('<MenuItemType>Display</MenuItemType>');
  });

  it('add-control on a form-extension falls back to XML when the bridge fails (extension never resolves as a form)', async () => {
    // Root cause: the C# bridge's AddControl reads _provider.Forms.Read(name), which
    // can never resolve a form EXTENSION ("Base.Suffix") — it always reports
    // 'Form "<ext>" not found'. The XML fallback must write the control element.
    const fsMod = await import('fs/promises');
    const extXml =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
      `\t<Name>ContosoRentConfiguration.MyExt</Name>\n` +
      `\t<ControlModifications />\n` +
      `\t<Controls />\n` +
      `\t<DataSourceModifications />\n` +
      `\t<PropertyModifications />\n` +
      `</AxFormExtension>`;
    (fsMod.readFile as any).mockResolvedValue(extXml);

    const addControl = vi.fn(async () => {
      throw new Error("Form 'ContosoRentConfiguration.MyExt' not found");
    });
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addControl, refreshProvider: vi.fn() };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form-extension',
        objectName: 'ContosoRentConfiguration.MyExt',
        operation: 'add-control',
        controlName: 'ContosoPaymentReference',
        parentControl: 'DetailsPropertiesFastTabPage',
        controlType: 'String',
        controlDataSource: 'ContosoRentRule',
        controlDataField: 'ContosoPaymentReference',
        controlLabel: '@ContosoLabels:PaymentReference',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxFormExtension\\ContosoRentConfiguration.MyExt.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    // Bridge was attempted first (and failed), XML fallback wrote the file.
    expect(addControl).toHaveBeenCalledTimes(1);
    const written = (fsMod.writeFile as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('ContosoRentConfiguration.MyExt.xml'),
    );
    expect(written).toBeDefined();
    const writtenContent: string = written[1];
    // Must match the SDK-serialized shape: <AxFormExtensionControl xmlns=""> wrapping
    // an empty-namespace <FormControl i:type="…"> with a <Parent> reference.
    expect(writtenContent).toContain('<AxFormExtensionControl xmlns="">');
    expect(writtenContent).toContain('<FormControl xmlns="" i:type="AxFormStringControl">');
    expect(writtenContent).toContain('<Type>String</Type>');
    expect(writtenContent).toContain('<Parent>DetailsPropertiesFastTabPage</Parent>');
    expect(writtenContent).toContain('ContosoPaymentReference');
    expect(writtenContent).toContain('<DataSource>ContosoRentRule</DataSource>');
    // Must NOT use the malformed AxFormControlExtension/ParentControlName shape.
    expect(writtenContent).not.toContain('<AxFormControlExtension>');
    expect(writtenContent).not.toContain('ParentControlName');
  });

  it('add-control maps controlType to the matching AxForm*Control element (Integer → AxFormIntegerControl)', async () => {
    const fsMod = await import('fs/promises');
    const extXml =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
      `\t<Name>SomeForm.MyExt</Name>\n` +
      `\t<Controls />\n` +
      `</AxFormExtension>`;
    (fsMod.readFile as any).mockResolvedValue(extXml);

    const addControl = vi.fn(async () => ({ success: false }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addControl, refreshProvider: vi.fn() };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form-extension',
        objectName: 'SomeForm.MyExt',
        operation: 'add-control',
        controlName: 'MyCount',
        parentControl: 'TabGeneral',
        controlType: 'Integer',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxFormExtension\\SomeForm.MyExt.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const written = (fsMod.writeFile as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('SomeForm.MyExt.xml'),
    );
    expect(written).toBeDefined();
    expect(written[1]).toContain('<FormControl xmlns="" i:type="AxFormIntegerControl">');
    expect(written[1]).toContain('<Type>Integer</Type>');
  });

  it('add-control infers a non-String controlType from controlDataField when the caller omits controlType', async () => {
    // Regression (eval scenario 1 — Equipment Rental): the tool never exposes a
    // `controlType` input at all (not in the Zod schema), so every real caller omits
    // it — modifyD365File.ts used to hard-default to the literal string "String"
    // unconditionally, so EVERY control (Real/Date/Enum/...) was created as a plain
    // string edit control regardless of the bound field's actual type. Combined with
    // a separate C# bridge bug (AxFormControl{Type} vs the real AxForm{Type}Control
    // naming), add-control was reported completely non-functional across multiple
    // eval runs. This asserts the TS side now infers a real type via the field-name
    // heuristic (heuristicEdtBaseType) instead of always guessing "String" — using
    // the exact field name ("DailyRate") from the reproducing scenario.
    const fsMod = await import('fs/promises');
    const extXml =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
      `\t<Name>RentAgreementForm.MyExt</Name>\n` +
      `\t<Controls />\n` +
      `</AxFormExtension>`;
    (fsMod.readFile as any).mockResolvedValue(extXml);

    const addControl = vi.fn(async () => ({ success: false }));
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, addControl, refreshProvider: vi.fn() };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form-extension',
        objectName: 'RentAgreementForm.MyExt',
        operation: 'add-control',
        controlName: 'Line_DailyRate',
        parentControl: 'LinesGrid',
        // No controlType — the tool must infer one from controlDataField.
        controlDataSource: 'AC_RentAgreementLine',
        controlDataField: 'DailyRate',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxFormExtension\\RentAgreementForm.MyExt.xml',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    // The bridge attempt itself must also have received the inferred type, not "String".
    expect(addControl.mock.calls[0][3]).toBe('Real');
    const written = (fsMod.writeFile as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('RentAgreementForm.MyExt.xml'),
    );
    expect(written).toBeDefined();
    expect(written[1]).toContain('<FormControl xmlns="" i:type="AxFormRealControl">');
    expect(written[1]).toContain('<Type>Real</Type>');
  });

  it('replace-code "oldCode not found" error includes a tip to use get_object_info or add-method', async () => {
    const fsMod = await import('fs/promises');
    // File exists but the oldCode snippet isn't in it (bridge also won't find it).
    (fsMod.readFile as any).mockResolvedValue(
      `<?xml version="1.0"?><AxTable><Name>ContosoRentAgreementLine</Name></AxTable>`,
    );

    const replaceCode = vi.fn(async () => {
      throw new Error('oldCode not found in ContosoRentAgreementLine.initValue');
    });
    (ctx as any).bridge = { isReady: true, metadataAvailable: true, replaceCode, refreshProvider: vi.fn() };

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'ContosoRentAgreementLine',
        operation: 'replace-code',
        methodName: 'initValue',
        oldCode: 'super();',
        newCode: 'super();\nthis.Qty = 1;',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoRentAgreementLine.xml',
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    // Must surface the original error AND the add-method/get_object_info tip.
    expect(result.content[0].text).toMatch(/oldCode not found/i);
    expect(result.content[0].text).toMatch(/get_object_info|add-method/i);
  });
});

// ─── replace-all-fields EDT base type resolution ──────────────────────────────

describe('replace-all-fields EDT base type resolution', () => {
  const TABLE_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml';

  const buildBridgeContext = (dbGetImpl?: () => any): XppServerContext => {
    const stmt = {
      all: vi.fn(() => []),
      get: dbGetImpl ? vi.fn(dbGetImpl) : vi.fn(() => undefined),
      run: vi.fn(),
    };
    return {
      symbolIndex: {
        searchSymbols: vi.fn(() => []),
        getSymbolByName: vi.fn(() => undefined),
        getCustomModels: vi.fn(() => ['MyModel']),
        db: { prepare: vi.fn(() => stmt), stmt },
        getReadDb: vi.fn(function (this: any) { return this.db; }),
      } as any,
      parser: {} as any,
      cache: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        generateSearchKey: vi.fn((q: string) => `k:${q}`),
      } as any,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      bridge: { isReady: true, metadataAvailable: true } as any,
    };
  };

  beforeEach(async () => {
    mockBridgeReplaceAllFields.mockClear();
    // Override readFile for table XML (module-level mock returns class XML by default)
    const fsMod = await import('fs/promises');
    (fsMod.readFile as any).mockResolvedValue(
      `<?xml version="1.0" encoding="utf-8"?><AxTable><Name>MyTable</Name><Fields /></AxTable>`,
    );
  });

  it('resolves EDT base type and passes it to bridgeReplaceAllFields when type is omitted', async () => {
    let callCount = 0;
    const ctx = buildBridgeContext(() => {
      callCount++;
      if (callCount === 1) return { extends: 'Real', enum_type: null }; // AmountCur row
      return undefined; // Real is a primitive — not in edt_metadata
    });

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        operation: 'replace-all-fields',
        filePath: TABLE_FILE_PATH,
        fields: [{ name: 'Amount', edt: 'AmountCur' }],
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeReplaceAllFields).toHaveBeenCalledTimes(1);
    const passedFields = mockBridgeReplaceAllFields.mock.calls[0][2] as any[];
    expect(passedFields[0]).toMatchObject({ name: 'Amount', edt: 'AmountCur', type: 'Real' });
  });

  it('leaves type unchanged when caller already provides it', async () => {
    const ctx = buildBridgeContext();

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        operation: 'replace-all-fields',
        filePath: TABLE_FILE_PATH,
        fields: [{ name: 'Amount', edt: 'AmountCur', type: 'Real' }],
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const passedFields = mockBridgeReplaceAllFields.mock.calls[0][2] as any[];
    expect(passedFields[0]).toMatchObject({ name: 'Amount', edt: 'AmountCur', type: 'Real' });
  });

  it('resolves Enum type via enum_type flag in edt_metadata', async () => {
    const ctx = buildBridgeContext(() => ({ extends: null, enum_type: 'MyStatusEnum' }));

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        operation: 'replace-all-fields',
        filePath: TABLE_FILE_PATH,
        fields: [{ name: 'Status', edt: 'MyStatusEnum' }],
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const passedFields = mockBridgeReplaceAllFields.mock.calls[0][2] as any[];
    expect(passedFields[0]).toMatchObject({ name: 'Status', edt: 'MyStatusEnum', type: 'Enum' });
  });

  it('falls back to edt name when EDT is not in symbol index', async () => {
    const ctx = buildBridgeContext(() => undefined);

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'table',
        objectName: 'MyTable',
        operation: 'replace-all-fields',
        filePath: TABLE_FILE_PATH,
        fields: [{ name: 'Qty', edt: 'InventQty' }],
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const passedFields = mockBridgeReplaceAllFields.mock.calls[0][2] as any[];
    expect(passedFields[0]).toMatchObject({ name: 'Qty', edt: 'InventQty', type: 'InventQty' });
  });
});
