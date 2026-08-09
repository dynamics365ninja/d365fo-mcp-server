/**
 * Which writer an enum create lands on, and whether both writers read the same
 * payload (#879).
 *
 * Routing: `enumModeForbidsExplicitValues` sends an enum to the TypeScript XML
 * generator whenever the resolved mode is UseEnumValue=No and the payload carries
 * numbers — which includes the plain positional case ([None=0, A=1, B=2] with
 * `useEnumValue` unset), not just the two headline cases the comment used to
 * describe. The bridge cannot write that shape: it takes UseEnumValue from the
 * scalar property but still serialises a <Value> per numbered entry, minus the
 * zeros .NET omits as a type default.
 *
 * The alias: `values` is a legacy spelling of `enumValues` that only the BRIDGE
 * path ever read. Routing on it while the generator reads `enumValues` meant a
 * payload could be routed away from the bridge and then land on a writer that
 * could not see its values at all — a clean ✅ for an enum with none.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (modelName: string) => ({
      packageName: modelName, modelName, rootPath: 'K:\\PackagesLocalDirectory',
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

const createObject = vi.fn(async () => ({
  success: true,
  filePath: 'K:\\PackagesLocalDirectory\\Contoso\\Contoso\\AxEnum\\ConDemoTier.xml',
  api: 'IMetadataProvider',
}));

/** A healthy bridge that would happily take the create if routing let it. */
const liveBridge = () => ({
  isReady: true,
  metadataAvailable: true,
  createObject,
  validateObject: vi.fn(async () => null),
  refreshProvider: vi.fn(async () => ({ refreshed: true, elapsedMs: 1 })),
} as any);

const buildContext = () => ({
  bridge: liveBridge(),
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => ['Contoso']),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  },
} as any);

const req = (properties: Record<string, unknown>, objectName = 'ConDemoTier'): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'create_d365fo_file',
    arguments: {
      objectType: 'enum',
      objectName,
      modelName: 'Contoso',
      packageName: 'Contoso',
      packagePath: 'K:\\PackagesLocalDirectory',
      addToProject: false,
      properties,
    },
  },
});

const POSITIONAL = [
  { name: 'None', value: 0 },
  { name: 'Silver', value: 1 },
  { name: 'Gold', value: 2 },
];

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'Contoso';
});

describe('enum create — which writer runs', () => {
  it('routes a plain positional payload (useEnumValue unset) to the XML generator', async () => {
    // The predicate is broader than "extensible or useEnumValue:false": the resolved
    // mode for [None=0, Silver=1, Gold=2] is UseEnumValue=No, and the bridge would
    // write <Value>1</Value><Value>2</Value> with the 0 dropped.
    const result = await handleCreateD365File(req({ enumValues: POSITIONAL }), buildContext());

    expect(createObject).not.toHaveBeenCalled();
    const xml = [...files.values()].join('\n');
    expect(result.content[0].text).toContain('Successfully created');
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).not.toContain('<Value>');
    for (const v of POSITIONAL) expect(xml).toContain(`<Name>${v.name}</Name>`);
  });

  it('writes every value when the payload spells the list `values` instead of `enumValues`', async () => {
    // The alias used to be read by the routing predicate and by the bridge, but not
    // by the generator — so this payload was routed to the generator and came out as
    // an empty <EnumValues />, reported as a clean success.
    const result = await handleCreateD365File(
      req({ values: POSITIONAL }, 'ConDemoTierAlias'),
      buildContext(),
    );

    expect(createObject).not.toHaveBeenCalled();
    const xml = [...files.values()].join('\n');
    expect(result.content[0].text).toContain('Successfully created');
    expect(xml).not.toContain('<EnumValues />');
    for (const v of POSITIONAL) expect(xml).toContain(`<Name>${v.name}</Name>`);
  });

  it('leaves an unnumbered enum on the bridge', async () => {
    // Nothing to suppress, so the exception does not apply and the normal
    // bridge-first path stands.
    await handleCreateD365File(
      req({ enumValues: [{ name: 'None' }, { name: 'Silver' }] }, 'ConDemoTierPlain'),
      buildContext(),
    );

    expect(createObject).toHaveBeenCalledTimes(1);
  });

  it('passes the aliased list to the bridge as well, when the bridge is the writer', async () => {
    await handleCreateD365File(
      req({ values: [{ name: 'None' }, { name: 'Silver' }] }, 'ConDemoTierPlainAlias'),
      buildContext(),
    );

    expect(createObject).toHaveBeenCalledTimes(1);
    const params = createObject.mock.calls[0][0] as any;
    expect(params.values).toHaveLength(2);
  });
});
