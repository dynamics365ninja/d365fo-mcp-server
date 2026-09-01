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
  // writeFileAtomic writes a temp sibling and renames it over the target, so a
  // mock without these two makes every write throw and the tool report failure.
  // The rename has to MOVE the entry: a no-op leaves the content parked under
  // the temp path and the assertions below read an empty target.
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
  it('routes a plain positional payload (useEnumValue unset) to the XML generator, numbers intact', async () => {
    // The predicate is broader than "extensible or useEnumValue:false": the resolved
    // mode for [None=0, Silver=1, Gold=2] is UseEnumValue=No, and the bridge would
    // emit no <UseEnumValue> at all.
    //
    // This used to assert `not.toContain('<Value>')` — it pinned the defect the
    // runtime oracle found on 2026-08-31. A member with no <Value> is 0, so that
    // shape gave None=Silver=Gold=0, built clean, and lost the ladder at run time.
    const result = await handleCreateD365File(req({ enumValues: POSITIONAL }), buildContext());

    expect(createObject).not.toHaveBeenCalled();
    const xml = [...files.values()].join('\n');
    expect(result.content[0].text).toMatch(/^✅ Created /);
    // The XML template ran, not the bridge — every bridge create path says so
    // in its headline. (The headline used to read 'Successfully created D365FO
    // <type> file:'; that phrase went when the create response was trimmed.)
    expect(result.content[0].text).not.toContain('via IMetadataProvider');
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    // The 0 is omitted (the serialiser's default, and how every shipped enum
    // writes it); every other member spells its number out.
    expect(xml).not.toContain('<Value>0</Value>');
    expect(xml).toContain('<Value>1</Value>');
    expect(xml).toContain('<Value>2</Value>');
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
    expect(result.content[0].text).toMatch(/^✅ Created /);
    // The XML template ran, not the bridge — every bridge create path says so
    // in its headline. (The headline used to read 'Successfully created D365FO
    // <type> file:'; that phrase went when the create response was trimmed.)
    expect(result.content[0].text).not.toContain('via IMetadataProvider');
    expect(xml).not.toContain('<EnumValues />');
    for (const v of POSITIONAL) expect(xml).toContain(`<Name>${v.name}</Name>`);
  });

  it('numbers an UNNUMBERED list by position and writes those numbers', async () => {
    // The shape that used to stay on the bridge, and the one it cannot survive:
    // with no `useEnumValue` scalar the bridge emits no <UseEnumValue> at all,
    // xppc reads the absent element as Yes, and every member without an explicit
    // <Value> is 0 — "Duplicate value '0' detected", on the full build only.
    //
    // Passing no numbers means "number them in order", not "leave them all at 0":
    // the position is what the caller stated, and the file has to say it, because
    // the XML's own default for a member with no <Value> is 0.
    const result = await handleCreateD365File(
      req({ enumValues: [{ name: 'None' }, { name: 'Silver' }, { name: 'Gold' }] }, 'ConDemoTierPlain'),
      buildContext(),
    );

    expect(createObject).not.toHaveBeenCalled();
    const xml = [...files.values()].join('\n');
    expect(result.content[0].text).toMatch(/^✅ Created /);
    // The XML template ran, not the bridge — every bridge create path says so
    // in its headline. (The headline used to read 'Successfully created D365FO
    // <type> file:'; that phrase went when the create response was trimmed.)
    expect(result.content[0].text).not.toContain('via IMetadataProvider');
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).toContain('<Value>1</Value>');
    expect(xml).toContain('<Value>2</Value>');
    for (const n of ['None', 'Silver', 'Gold']) expect(xml).toContain(`<Name>${n}</Name>`);
  });

  it('keeps the numbers on an EXTENSIBLE enum, with UseEnumValue=No', async () => {
    // Verified on the VM (fm-mcp, xppc 2026-09-01) rather than argued: an
    // extensible enum carrying UseEnumValue=No and explicit, non-positional
    // <Value> elements compiles clean, while the same enum with UseEnumValue=Yes
    // fails with "UseEnumValue property must be set to 'No' when the IsExtensible
    // property is 'True'". 645 of the 688 shipped extensible enums have the first
    // shape. The old rule refused this payload outright.
    const result = await handleCreateD365File(
      req({ isExtensible: true, enumValues: [{ name: 'None' }, { name: 'Second', value: 2 }, { name: 'First', value: 1 }] }, 'ConDemoTierExtValues'),
      buildContext(),
    );

    expect(result.content[0].text).toMatch(/^✅ Created /);
    const xml = [...files.values()].join('\n');
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).toContain('<IsExtensible>true</IsExtensible>');
    expect(xml).toContain('<Value>2</Value>');
    expect(xml).toContain('<Value>1</Value>');
  });

  it('refuses the one combination xppc rejects: isExtensible + useEnumValue:true', async () => {
    const result = await handleCreateD365File(
      req({ isExtensible: true, useEnumValue: true, enumValues: POSITIONAL }, 'ConDemoTierExtYes'),
      buildContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toMatch(/UseEnumValue property must be set to 'No'/);
  });

  it('writes every value of an unnumbered list spelled `values`', async () => {
    const result = await handleCreateD365File(
      req({ values: [{ name: 'None' }, { name: 'Silver' }] }, 'ConDemoTierPlainAlias'),
      buildContext(),
    );

    expect(createObject).not.toHaveBeenCalled();
    const xml = [...files.values()].join('\n');
    expect(result.content[0].text).toMatch(/^✅ Created /);
    // The XML template ran, not the bridge — every bridge create path says so
    // in its headline. (The headline used to read 'Successfully created D365FO
    // <type> file:'; that phrase went when the create response was trimmed.)
    expect(result.content[0].text).not.toContain('via IMetadataProvider');
    expect(xml).not.toContain('<EnumValues />');
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    for (const n of ['None', 'Silver']) expect(xml).toContain(`<Name>${n}</Name>`);
  });

  it('leaves an enum with NO values on the bridge — the one shape it cannot get wrong', async () => {
    await handleCreateD365File(req({ label: '@SYS1' }, 'ConDemoTierEmpty'), buildContext());

    expect(createObject).toHaveBeenCalledTimes(1);
  });
});

/** IsExtensible=Yes and ranking the values are mutually exclusive, and only the build says so. */
describe('enum create — extensibility vs ordering', () => {
  it('warns that an extensible enum can only be compared for equality', async () => {
    const result = await handleCreateD365File(
      req({ isExtensible: true, enumValues: POSITIONAL }, 'ConDemoTierExt'),
      buildContext(),
    );

    const text = result.content[0].text as string;
    expect(text).toMatch(/^✅ Created /);
    expect(text).not.toContain('via IMetadataProvider');
    expect(text).toContain('IsExtensible=true');
    expect(text).toMatch(/non-equality comparison/i);
    // Names the way out while it is still cheap — before any code references it.
    expect(text).toContain('isExtensible=false');
  });

  it('says nothing for a non-extensible enum', async () => {
    const result = await handleCreateD365File(
      req({ enumValues: POSITIONAL }, 'ConDemoTierQuiet'),
      buildContext(),
    );
    expect(result.content[0].text).not.toMatch(/non-equality comparison/i);
  });
});
