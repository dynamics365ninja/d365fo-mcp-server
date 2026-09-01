/**
 * A create that renames the object must say so in its RESPONSE.
 *
 * `normalizeObjectName` renames on nearly every extension create — that is its
 * job — but only the XML-template path disclosed it (`(prefixed from "…")`). The
 * bridge path, which owns every class, table and extension create, printed the
 * final name and nothing else, so a caller that passed `SalesFormLetter_CtsoExtension`
 * got back a ✅ for `SalesFormLetterCtso_Extension` with no statement that the two
 * are the same object. Run 81803f01 read the difference as a failed create and
 * created it a second time.
 *
 * The real modelClassifier runs here (only configManager and the bridge are
 * mocked), so the name asserted is the one the naming code actually produces.
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

const ENV_KEYS = ['EXTENSION_PREFIX', 'EXTENSION_SUFFIX', 'EXTENSION_NAMING_STYLE', 'EXTENSION_PREFIX_SOURCE'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXTENSION_PREFIX = 'Ctso';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  registerCustomModel('ContosoExt');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('create discloses the name it actually wrote', () => {
  it('names both spellings when the bridge path renames a class extension', async () => {
    const result = await handleCreateD365File(
      req('class-extension', 'SalesFormLetter_CtsoExtension', {
        sourceCode:
          '[ExtensionOf(classStr(SalesFormLetter))]\n' +
          'final class SalesFormLetterCtso_Extension\n{\n}',
      }),
      buildContext(),
    );

    const text = result.content[0].text as string;
    expect(result.isError).toBeFalsy();
    // The name the write used…
    expect(createObject).toHaveBeenCalledWith(
      expect.objectContaining({ objectName: 'SalesFormLetterCtso_Extension' }),
    );
    // …stated against the name the caller passed, so the two are one object.
    expect(text).toContain('SalesFormLetterCtso_Extension');
    expect(text).toContain('SalesFormLetter_CtsoExtension');
    expect(text).toMatch(/not `SalesFormLetter_CtsoExtension` as passed/);
    // And says which name the follow-up calls take.
    expect(text).toMatch(/later calls/i);
  });

  it('says nothing when the name came back unchanged', async () => {
    const result = await handleCreateD365File(
      req('class', 'CtsoDemoNoteService', { sourceCode: 'class CtsoDemoNoteService\n{\n}' }),
      buildContext(),
    );

    const text = result.content[0].text as string;
    expect(result.isError).toBeFalsy();
    expect(text).not.toMatch(/as passed/);
    expect(text).not.toContain('🔖');
  });
});

/**
 * The same rename, seen from inside the file it writes.
 *
 * An AOT object states its name three times — the file, the root <Name>, the X++
 * declaration — and the prefix rewrite only ever touched two of them. The
 * 2026-08-31 L2-event-handler-basic run got `ConDemoEvalL2…Test.xml` holding
 * `class ConDemoEvalL2…Test` and `<Name>EvalL2…Test</Name>`, reported "Created"
 * plus "Verified: on disk", and the next build died with the naming-consistency
 * error.
 */
describe('create keeps one identity across file name, <Name> and the declaration', () => {
  const AX_CLASS = (name: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
class ${name} extends SysTestCase
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
</AxClass>
`;

  it('prefixes the metadata <Name> as well as the X++ declaration', async () => {
    const result = await handleCreateD365File(
      req('class', 'EvalNoteTest', { xmlContent: AX_CLASS('EvalNoteTest') }),
      buildContext(),
    );

    expect(result.isError).toBeFalsy();
    const [path, written] = [...files.entries()].find(([p]) => p.endsWith('.xml')) ?? [];
    expect(path).toMatch(/CtsoEvalNoteTest\.xml$/);
    expect(written).toContain('<Name>CtsoEvalNoteTest</Name>');
    expect(written).toContain('class CtsoEvalNoteTest extends SysTestCase');
    expect(written).not.toContain('<Name>EvalNoteTest</Name>');
  });

  it('refuses xmlContent that names a different object instead of writing it', async () => {
    const result = await handleCreateD365File(
      req('class', 'CtsoNoteService', { xmlContent: AX_CLASS('SomethingElse') }),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/two different identities/);
    expect(text).toContain('SomethingElse');
    expect(text).toContain('CtsoNoteService');
    // Nothing was written — a file that cannot build is worse than no file.
    expect([...files.keys()].filter(k => k.endsWith('.xml'))).toEqual([]);
  });
});
