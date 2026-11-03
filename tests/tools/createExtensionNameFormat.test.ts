/**
 * d365fo_file(action="create") under the extension name formats.
 *
 * The extended object's type reaches create through the call: the
 * [ExtensionOf(<kind>Str(…))] in sourceCode, or properties.baseObjectType. It
 * selects the class format; a case no format defines is answered with the ask-back
 * and nothing is written. The same arguments give the same name on the local
 * companion (write-only: empty in-memory index) and on a full / shared server
 * (populated index): the formats never consult the index.
 *
 * Mocks as in createRenameDisclosure.test.ts: only configManager, the file system
 * and the bridge; the naming code is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
import { registerCustomModel } from '../../src/utils/modelClassifier';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (files.has(p)) return files.get(p)!;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup /></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async (p: string, content: string) => { files.set(p, content); }),
  copyFile: vi.fn(async () => {}),
  // writeFileAtomic writes a temp sibling and renames it over the target, so the
  // rename has to MOVE the entry — a no-op leaves the bytes under the temp path.
  rename: vi.fn(async (from: string, to: string) => {
    const content = files.get(from);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    files.set(to, content);
    files.delete(from);
  }),
  rm: vi.fn(async (p: string) => { files.delete(p); }),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (p: string) => {
    if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/') return;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1024 })),
  readdir: vi.fn(async () => []),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'ContosoExt'),
    getWriteAnchorModel: vi.fn(() => 'ContosoExt'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'ContosoExt'),
    getProjectPath: vi.fn(async () => null),
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
      packageName: modelName, modelName, rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

const createObject = vi.fn(async (request: { objectName: string }) => ({
  success: true,
  filePath: `K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxClass\\${request.objectName}.xml`,
  api: 'IMetadataProvider',
  message: 'IMetadataProvider.Create',
}));

const buildContext = () => ({
  bridge: {
    isReady: true,
    metadataAvailable: true,
    createObject,
    validateObject: vi.fn(async () => null),
    refreshProvider: vi.fn(async () => ({ refreshed: true, elapsedMs: 1 })),
  },
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => ['ContosoExt']),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  },
} as any);

const req = (objectType: string, objectName: string, rest: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'create_d365fo_file',
    arguments: {
      objectType,
      objectName,
      modelName: 'ContosoExt',
      packageName: 'ContosoExt',
      packagePath: 'K:\\PackagesLocalDirectory',
      addToProject: false,
      ...rest,
    },
  },
});

const FORMAT_ENV = {
  EXTENSION_PREFIX: 'Ctso',
  EXTENSION_PREFIX_SOURCE: 'config',
  EXTENSION_ELEMENT_NAME_FORMAT: '{0}.CTSO',
  EXTENSION_CLASS_NAME_FORMAT: 'CTSO_{0}Cls',
  EXTENSION_CLASS_NAME_FORMAT_TABLE: 'CTSO_{0}Dbt',
  EXTENSION_CLASS_NAME_FORMAT_FORM: 'CTSO_{0}Frm',
};
const originalEnv = { ...process.env };

/** A shared-server index: knows the bases, so every index-backed guess could fire. */
const sharedServerContext = () => {
  const ctx = buildContext();
  const known: Record<string, string> = { inventtable: 'table', custtable: 'table', salesformletter: 'class' };
  const hit = (params: unknown[]) => {
    const p = params.find(x => typeof x === 'string' && known[x.replace(/"/g, '').toLowerCase()]) as string | undefined;
    return p ? { name: p.replace(/"/g, ''), type: known[p.replace(/"/g, '').toLowerCase()], model: 'ApplicationSuite', extends_class: null, file_path: null } : undefined;
  };
  ctx.symbolIndex.db = {
    prepare: vi.fn(() => ({
      all: vi.fn((...params: unknown[]) => (hit(params) ? [hit(params)] : [])),
      get: vi.fn((...params: unknown[]) => hit(params)),
      run: vi.fn(),
    })),
  };
  return ctx;
};

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  for (const k of Object.keys(process.env)) if (k.startsWith('EXTENSION_')) delete process.env[k];
  Object.assign(process.env, FORMAT_ENV);
  registerCustomModel('ContosoExt');
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const writtenName = () => (createObject.mock.calls.at(-1)?.[0] as { objectName: string } | undefined)?.objectName;

const CASES: Array<{ label: string; objectType: string; objectName: string; rest: Record<string, unknown>; expected: string }> = [
  {
    label: 'class extension of a table, from [ExtensionOf(tableStr)]',
    objectType: 'class-extension', objectName: 'InventTable',
    rest: { sourceCode: '[ExtensionOf(tableStr(InventTable))]\nfinal class InventTable_Extension\n{\n}' },
    expected: 'CTSO_InventTableDbt_Extension',
  },
  {
    label: 'class extension of a form, from [ExtensionOf(formStr)]',
    objectType: 'class-extension', objectName: 'InventTable_Extension',
    rest: { sourceCode: '[ExtensionOf(formStr(InventTable))]\nfinal class InventTable_Extension\n{\n}' },
    expected: 'CTSO_InventTableFrm_Extension',
  },
  {
    label: 'class extension of a class, from [ExtensionOf(classStr)]',
    objectType: 'class-extension', objectName: 'SalesFormLetter',
    rest: { sourceCode: '[ExtensionOf(classStr(SalesFormLetter))]\nfinal class SalesFormLetter_Extension\n{\n}' },
    expected: 'CTSO_SalesFormLetterCls_Extension',
  },
  {
    label: 'class extension of a table, from properties.baseObjectType (no source)',
    objectType: 'class-extension', objectName: 'CustTable',
    rest: { properties: { baseObjectType: 'table' } },
    expected: 'CTSO_CustTableDbt_Extension',
  },
  {
    label: 'an already formatted name, no type stated',
    objectType: 'class-extension', objectName: 'CTSO_CustTableFrm_Extension',
    rest: {},
    expected: 'CTSO_CustTableFrm_Extension',
  },
];

describe('create names extension classes by the format of the base type', () => {
  for (const c of CASES) {
    for (const [mode, ctx] of [['write-only companion (empty index)', buildContext], ['shared / full server (index)', sharedServerContext]] as const) {
      it(`${c.label} — ${mode}`, async () => {
        const result = await handleCreateD365File(req(c.objectType, c.objectName, c.rest), ctx());
        expect(result.isError, result.content[0].text).toBeFalsy();
        expect(writtenName()).toBe(c.expected);
      });
    }
  }

  it('the template written without source names the matching intrinsic', async () => {
    // No bridge: the XML template path writes the skeleton itself.
    const ctx = buildContext();
    (ctx as any).bridge = undefined;
    const result = await handleCreateD365File(req('class-extension', 'CustTable', { properties: { baseObjectType: 'table' } }), ctx);
    expect(result.isError, result.content[0].text).toBeFalsy();
    const xml = [...files.entries()].find(([p]) => p.endsWith('CTSO_CustTableDbt_Extension.xml'))?.[1] ?? '';
    expect(xml).toContain('[ExtensionOf(tableStr(CustTable))]');
    expect(xml).toContain('<Name>CTSO_CustTableDbt_Extension</Name>');
  });
});

describe('create asks back for a case no format defines', () => {
  it('a form data source extension: no write, the question instead', async () => {
    const result = await handleCreateD365File(
      req('class-extension', 'CustTable', {
        sourceCode: '[ExtensionOf(formDataSourceStr(CustTable, CustTable))]\nfinal class CustTable_Extension\n{\n}',
      }),
      buildContext(),
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('no naming convention for an extension class of a form-datasource');
    expect(text).toContain('ask the user for the name and call again with an explicit `name`');
    expect(createObject).not.toHaveBeenCalled();
  });

  it('no base type at all: asks', async () => {
    const result = await handleCreateD365File(req('class-extension', 'CustTable'), buildContext());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('an extension class whose base type was not given');
    expect(createObject).not.toHaveBeenCalled();
  });

  it('the second call, with the user\'s full name, writes it as given', async () => {
    const result = await handleCreateD365File(
      req('class-extension', 'CTSO_CustTable_CustTableDSCls_Extension', {
        sourceCode: '[ExtensionOf(formDataSourceStr(CustTable, CustTable))]\nfinal class CTSO_CustTable_CustTableDSCls_Extension\n{\n}',
      }),
      buildContext(),
    );
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(writtenName()).toBe('CTSO_CustTable_CustTableDSCls_Extension');
  });

  it('UNDEFINED=class-format: the class format names it', async () => {
    process.env.EXTENSION_NAME_FORMAT_UNDEFINED = 'class-format';
    const result = await handleCreateD365File(
      req('class-extension', 'CustTable', {
        sourceCode: '[ExtensionOf(formDataSourceStr(CustTable, CustTable))]\nfinal class CustTable_Extension\n{\n}',
      }),
      buildContext(),
    );
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(writtenName()).toBe('CTSO_CustTableCls_Extension');
  });
});

describe('create of element extensions', () => {
  it('table-extension InventTable → InventTable.CTSO, in both modes', async () => {
    for (const ctx of [buildContext, sharedServerContext]) {
      const result = await handleCreateD365File(req('table-extension', 'InventTable'), ctx());
      expect(result.isError, result.content[0].text).toBeFalsy();
      expect(writtenName()).toBe('InventTable.CTSO');
    }
  });
});

describe('create under naming.prefixSource=as-given with formats', () => {
  beforeEach(() => { process.env.EXTENSION_PREFIX_SOURCE = 'as-given'; });

  it('refuses a name the format would change, naming the expected one', async () => {
    const result = await handleCreateD365File(req('table-extension', 'InventTable.Contoso'), buildContext());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('it expects "InventTable.CTSO"');
    expect(createObject).not.toHaveBeenCalled();
  });

  it('writes the formatted name as given', async () => {
    const result = await handleCreateD365File(
      req('class-extension', 'CTSO_InventTableDbt_Extension', {
        sourceCode: '[ExtensionOf(tableStr(InventTable))]\nfinal class CTSO_InventTableDbt_Extension\n{\n}',
      }),
      buildContext(),
    );
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(writtenName()).toBe('CTSO_InventTableDbt_Extension');
  });
});
