/**
 * d365fo_file(action="create") with X++ source whose '{' is never closed must
 * fail and write nothing — also when the bridge is available.
 *
 * The bridge create path parses `sourceCode` inside a try whose catch logs
 * "Bridge create failed, falling back to XML" and carries on with the XML
 * template. For a class or table the template parses the source again and
 * fails too, but the table-extension template ignores `sourceCode`, so the
 * extension was written WITHOUT its methods and reported as created. The parse
 * error (XppSplitError) is now re-thrown from that catch.
 *
 * Harness copied from createTableParamSilentDrop.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
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
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (p: string) => {
    if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/') return;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1024 })),
  readdir: vi.fn(async () => []),
  rename: vi.fn(async (from: string, to: string) => {
    const content = files.get(from);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    files.set(to, content);
    files.delete(from);
  }),
  rm: vi.fn(async (p: string) => { files.delete(p); }),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'Contoso'),
    getWriteAnchorModel: vi.fn(() => 'Contoso'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'Contoso'),
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
  // A `function`, not an arrow: the handler constructs it with `new`.
  PackageResolver: vi.fn().mockImplementation(function () {
    return {
      resolve: vi.fn(async (modelName: string) => ({
        packageName: modelName, modelName, rootPath: 'K:\\PackagesLocalDirectory',
      })),
      resolveWithPackage: vi.fn((m: string, p: string) => ({
        packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
      })),
    };
  }),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  isAsGivenNamingMode: vi.fn(() => false),
  isNoPrefixMode: vi.fn(() => false),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  getExtensionNamingStyle: vi.fn(() => 'prefix'),
  getExtensionClassNamingStyle: vi.fn(() => 'prefix'),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

/** A ready bridge; any create call it receives is recorded. */
const readyBridge = () => {
  const create = vi.fn(async () => ({ success: true, filePath: 'K:\\never-written.xml' }));
  return {
    create,
    bridge: {
      isReady: true,
      metadataAvailable: true,
      createObject: create,
      createSmartTable: create,
      validateObject: vi.fn(async () => null),
      refreshProvider: vi.fn(async () => ({ success: true })),
    } as any,
  };
};

const buildContext = (bridge?: unknown) => ({
  bridge,
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => ['Contoso']),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  },
} as any);

const UNCLOSED = `public void contosoFirst()
{
    if (this.RecId)
    {
}

public void contosoSecond()
{
}`;

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
});
afterEach(() => { vi.clearAllMocks(); });

describe('create with an unclosed { in sourceCode', () => {
  it.each([
    ['table-extension', 'CustTable.ContosoExtension', UNCLOSED],
    ['table', 'ContosoSetting', `public class ContosoSetting extends common\n{\n}\n\n${UNCLOSED}`],
    ['class', 'ContosoHelper', `class ContosoHelper\n{\n}\n\n${UNCLOSED}`],
  ])('%s: fails with the line number and writes nothing', async (objectType, objectName, sourceCode) => {
    const { bridge, create } = readyBridge();
    const result = await handleCreateD365File(
      req({ objectType, objectName, modelName: 'Contoso', sourceCode, addToProject: false }),
      buildContext(bridge),
    );
    const text = result.content.map(c => c.text).join('\n');
    expect(result.isError, text).toBe(true);
    expect(text).toMatch(/never closed \(line \d+/);
    expect(create).not.toHaveBeenCalled();
    expect([...files.keys()].filter(p => p.endsWith('.xml'))).toEqual([]);
  });
});
