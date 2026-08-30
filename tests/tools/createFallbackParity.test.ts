/**
 * Fallback parity — when the bridge is down and the local XML template writes the
 * object instead, the response must not be the same ✅ a bridge create produces.
 *
 * Two defects, both found by the 2026-08 correctness audit:
 *
 *  #11 `generateAxTableXml` emits a hardcoded `<Indexes />`, `<Relations />` and the
 *      five standard field groups, so every index, relation and custom field group
 *      the caller passed is discarded — and the caller was told "✅ Successfully
 *      created", identical to the bridge path that honours all three.
 *
 *  #12 `generateAxTableExtensionXml` read only `field.fieldName` for index fields.
 *      `indexes: [{ name, fields: ["AccountNum"] }]` — the string form the bridge
 *      normalizer and add-index both accept — produced a literal
 *      `<DataField>undefined</DataField>`, which deserializes fine and leaves an
 *      index pointing at nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateD365File, XmlTemplateGenerator } from '../../src/tools/write/createD365File';
import { findDroppedTableCollections } from '../../src/tools/xml/createTablePropertyHonesty';
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
    getModelName: vi.fn(() => 'MyModel'),
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
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

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'Contoso';
});
afterEach(() => { delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS; });

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

/** Up, healthy-looking, and every write RPC throws — the audited outage shape. */
const deadBridge = () => ({
  isReady: true,
  metadataAvailable: true,
  createSmartTable: vi.fn(async () => { throw new Error('Bridge call timed out after 60000ms'); }),
  createObject: vi.fn(async () => { throw new Error('Bridge call timed out after 60000ms'); }),
  validateObject: vi.fn(async () => null),
  refreshProvider: vi.fn(async () => ({ refreshed: true, elapsedMs: 1 })),
} as any);

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

const TABLE_PROPERTIES = {
  label: 'Audit probe',
  tableGroup: 'Main',
  fields: [{ name: 'SettingId', edt: 'Name' }],
  fieldGroups: [{ name: 'ConCustomGroup', fields: ['SettingId'] }],
  indexes: [{ name: 'SettingIdx', fields: ['SettingId'], allowDuplicates: false }],
  relations: [{
    name: 'ConSettingRel',
    relatedTable: 'CustTable',
    constraints: [{ field: 'SettingId', relatedField: 'AccountNum' }],
  }],
};

describe('#11 XML fallback must name what it could not apply', () => {
  it('reports the dropped indexes and relations instead of a bare ✅, and stops naming what it now writes', async () => {
    const result = await handleCreateD365File(
      req({
        objectType: 'table',
        objectName: 'ConAuditFallbackTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: TABLE_PROPERTIES,
      }),
      buildContext(deadBridge()),
    );

    const text = result.content[0].text as string;
    const xml = [...files.values()].join('\n');

    // The write itself still happened, and the template really did drop the
    // relation — if either stops being true this test is measuring the wrong thing.
    expect(text).toMatch(/^✅ Created /);
    expect(text).not.toContain('via IMetadataProvider');
    expect(xml).toContain('<Relations />');
    expect(xml).not.toContain('ConSettingRel');

    expect(text).toContain('NOT APPLIED');
    expect(text).toContain('ConSettingRel');
    expect(text).toContain('add-relation');

    // Field groups and indexes are no longer among them: the template writes
    // both now, so the honesty check — which reads the XML that was ACTUALLY
    // written rather than a maintained capability list — falls silent about them
    // on its own. A report here would mean one was dropped again.
    //
    // The index matters beyond tidiness: `add-index`, the repair the report used
    // to offer, needs the C# bridge, so on the template path there was no way to
    // get an index at all.
    expect(xml).toContain('ConCustomGroup');
    expect(text).not.toContain('ConCustomGroup');
    expect(xml).toContain('<Name>SettingIdx</Name>');
    expect(xml).toContain('<AllowDuplicates>No</AllowDuplicates>');
    expect(text).not.toContain('SettingIdx');
  });

  it('says the bridge is the reason the template ran', async () => {
    const result = await handleCreateD365File(
      req({
        objectType: 'table',
        objectName: 'ConAuditFallbackTable2',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: TABLE_PROPERTIES,
      }),
      buildContext(deadBridge()),
    );

    const text = result.content[0].text as string;
    expect(text).toContain('bridge errored:');
    // The generic create is the last attempt, so its failure is the one reported.
    expect(text).toContain('createObject(table, ConAuditFallbackTable2)');
    expect(text).toContain('timed out');
    expect(text).toContain('NOT by IMetadataProvider');
  });

  it('stays silent when there was nothing to drop', async () => {
    const result = await handleCreateD365File(
      req({
        objectType: 'table',
        objectName: 'ConAuditPlainTable',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { label: 'Plain', tableGroup: 'Main', fields: [{ name: 'SettingId', edt: 'Name' }] },
      }),
      buildContext(deadBridge()),
    );

    expect(result.content[0].text as string).not.toContain('NOT APPLIED');
  });
});

describe('findDroppedTableCollections', () => {
  const withIndex = `<AxTable><Name>T</Name><Indexes><AxTableIndex><Name>SettingIdx</Name></AxTableIndex></Indexes></AxTable>`;

  it('counts a collection as honoured when its members are in the document', () => {
    expect(findDroppedTableCollections(withIndex, { indexes: [{ name: 'SettingIdx' }] })).toEqual([]);
  });

  it('reports only the members that are missing', () => {
    const dropped = findDroppedTableCollections(withIndex, {
      indexes: [{ name: 'SettingIdx' }, { name: 'OtherIdx' }],
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].missing).toEqual(['OtherIdx']);
  });

  it('does not mistake the standard field groups for the caller\'s custom one', () => {
    const xml = `<AxTable><FieldGroups><AxTableFieldGroup><Name>AutoReport</Name></AxTableFieldGroup></FieldGroups></AxTable>`;
    const dropped = findDroppedTableCollections(xml, { fieldGroups: [{ name: 'ConCustomGroup' }] });
    expect(dropped[0].missing).toEqual(['ConCustomGroup']);
  });
});

describe('#12 table-extension index fields in string form', () => {
  it('writes the field name, not the literal "undefined"', () => {
    const xml = XmlTemplateGenerator.generateAxTableExtensionXml('CustTable.ConExtension', {
      indexes: [{ name: 'ConAccountIdx', fields: ['AccountNum', 'ConSettingId'], allowDuplicates: false }],
    });

    expect(xml).not.toContain('undefined');
    expect(xml).toContain('<DataField>AccountNum</DataField>');
    expect(xml).toContain('<DataField>ConSettingId</DataField>');
  });

  it('still accepts the documented object form', () => {
    const xml = XmlTemplateGenerator.generateAxTableExtensionXml('CustTable.ConExtension', {
      indexes: [{ name: 'ConAccountIdx', fields: [{ fieldName: 'AccountNum', direction: 'Descending' }] }],
    });

    expect(xml).toContain('<DataField>AccountNum</DataField>');
    expect(xml).toContain('<Direction>Descending</Direction>');
  });

  it('drops an index field it cannot name rather than writing a broken one', () => {
    const xml = XmlTemplateGenerator.generateAxTableExtensionXml('CustTable.ConExtension', {
      indexes: [{ name: 'ConAccountIdx', fields: [{ nonsense: 'AccountNum' }] }],
    });

    expect(xml).not.toContain('undefined');
    expect(xml).toContain('<Fields />');
  });

  it('accepts { field, relatedField } relation constraints', () => {
    const xml = XmlTemplateGenerator.generateAxTableExtensionXml('CustTable.ConExtension', {
      relations: [{
        name: 'ConRel',
        relatedTable: 'VendTable',
        constraints: [{ field: 'AccountNum', relatedField: 'AccountNum' }],
      }],
    });

    expect(xml).not.toContain('undefined');
    expect(xml).toContain('<RelatedField>AccountNum</RelatedField>');
  });
});
