/**
 * Cluster #35, create half — d365fo_file(action="create", objectType="table") must
 * never DISCARD an optional property in silence.
 *
 * Corpus evidence:
 *   eval/corpus/runs/2026-07-22T16__L2-config-key-gated-table__0e1e367.json
 *     "d365fo_file(action=create, objectType=table) silently DROPS
 *      properties.configurationKey: the same property IS honoured by
 *      objectType=menu-item-display … the table create path emitted no
 *      ConfigurationKey element and no dropped-parameter warning"
 *   evidence_refs:
 *     K:/AosService/PackagesLocalDirectory/Contoso/Contoso/AxTable/ConDemoGatedSetting.xml
 *     K:/AosService/PackagesLocalDirectory/Contoso/Contoso/AxMenuItemDisplay/ConDemoGatedSettingMI.xml
 *
 * Root cause, reproduced here without the VM: the create routes through the bridge's
 * CreateSmartTable, whose C# SetAxTableProperty() switch has no `configurationkey`
 * case — the key falls into `default:`, whose return value CreateSmartTable ignored.
 * The mock bridge below writes exactly the document the real (pre-fix) bridge wrote:
 * every known property, and nothing for the unknown ones.
 *
 * The contract asserted: every scalar property the caller passes either lands in the
 * XML or is named in the response as dropped. No third option.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/createD365File';
import {
  reconcileTableCreateProperties,
  renderTableCreateHonestyReport,
} from '../../src/tools/createTablePropertyHonesty';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── In-memory filesystem ────────────────────────────────────────────────────
// The reconcile step re-reads what the writer actually produced, so the mock has
// to behave like a disk, not like a stub that always answers the same string.

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
    getModelName: vi.fn(() => 'MyModel'),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

const TABLE_PATH = 'K:\\PackagesLocalDirectory\\Contoso\\Contoso\\AxTable\\ConDemoGatedSetting.xml';

/** The AxTable the real CreateSmartTable wrote on the VM — no <ConfigurationKey>. */
const smartTableXmlAsWrittenByTheBridge = (name: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ${name} extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>Gated setting</Label>
\t<TableGroup>Main</TableGroup>
\t<TitleField1>SettingId</TitleField1>
\t<CacheLookup>Found</CacheLookup>
\t<ClusteredIndex>SettingIdx</ClusteredIndex>
\t<PrimaryIndex>SettingIdx</PrimaryIndex>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields />
\t<Indexes />
\t<Relations />
</AxTable>`;

/** A bridge that behaves exactly like the pre-fix C# SetAxTableProperty switch. */
const legacyBridge = () => {
  const createSmartTable = vi.fn(async (params: any) => {
    files.set(TABLE_PATH, smartTableXmlAsWrittenByTheBridge(params.objectName));
    return {
      success: true,
      filePath: TABLE_PATH,
      api: 'IMetaTableProvider.Create (Smart)',
      bpDefaults: { cacheLookup: 'Found', titleField1: 'SettingId', primaryIndex: 'SettingIdx' },
    };
  });
  return {
    createSmartTable,
    bridge: {
      isReady: true,
      metadataAvailable: true,
      createSmartTable,
      createObject: vi.fn(async () => { throw new Error('generic create must not be used'); }),
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

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
});

// ─── The corpus defect, end to end ───────────────────────────────────────────

describe('#35 create table: properties.configurationKey must not vanish', () => {
  it('writes <ConfigurationKey> even when the metadata writer drops it', async () => {
    const { bridge } = legacyBridge();
    const result = await handleCreateD365File(
      req({
        objectType: 'table',
        objectName: 'ConDemoGatedSetting',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          label: 'Gated setting',
          tableGroup: 'Main',
          configurationKey: 'ConDemoModuleKey',
        },
      }),
      buildContext(bridge),
    );

    expect((result as any).isError).toBeFalsy();

    // The whole point of the case: the config key is IN the table on disk.
    const onDisk = files.get(TABLE_PATH)!;
    expect(onDisk).toContain('<ConfigurationKey>ConDemoModuleKey</ConfigurationKey>');

    // AxTable is order-sensitive: ConfigurationKey precedes Label/TableGroup or the
    // deserializer drops it without a word (see axTablePropertyOrder).
    expect(onDisk.indexOf('<ConfigurationKey>')).toBeLessThan(onDisk.indexOf('<Label>'));
    expect(onDisk.indexOf('<ConfigurationKey>')).toBeLessThan(onDisk.indexOf('<TableGroup>'));

    // And the caller is told, rather than being handed a bare ✅.
    expect(result.content[0].text).toMatch(/ConfigurationKey/);
  });

  it('reports a property that cannot be written at all instead of answering a bare ✅', async () => {
    const { bridge } = legacyBridge();
    const result = await handleCreateD365File(
      req({
        objectType: 'table',
        objectName: 'ConDemoGatedSetting',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: { label: 'Gated setting', configKey: 'ConDemoModuleKey' },
      }),
      buildContext(bridge),
    );

    expect((result as any).isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/DROPPED/);
    expect(result.content[0].text).toMatch(/configKey/);
    // Never invent an element for a name the metamodel does not have.
    expect(files.get(TABLE_PATH)!).not.toContain('ConfigKey>');
  });

  it('stays silent when the writer honoured everything', async () => {
    const { bridge } = legacyBridge();
    const result = await handleCreateD365File(
      req({
        objectType: 'table',
        objectName: 'ConDemoGatedSetting',
        modelName: 'Contoso',
        packageName: 'Contoso',
        packagePath: 'K:\\PackagesLocalDirectory',
        addToProject: false,
        properties: {
          label: 'Gated setting',
          tableGroup: 'Main',
          cacheLookup: 'Found',
          fields: [{ name: 'SettingId', type: 'String' }],
        },
      }),
      buildContext(bridge),
    );

    expect(result.content[0].text).not.toMatch(/DROPPED/);
    expect(result.content[0].text).not.toMatch(/Written after the create/);
  });
});

// ─── The reconciler itself ───────────────────────────────────────────────────

describe('reconcileTableCreateProperties', () => {
  const base = smartTableXmlAsWrittenByTheBridge('ConDemoGatedSetting');

  it('patches every string property the writer skipped, in canonical order', () => {
    const r = reconcileTableCreateProperties(base, {
      configurationKey: 'ConDemoModuleKey',
      formRef: 'ConDemoGatedSettingForm',
      developerDocumentation: '@ConDemo:Doc',
    });
    expect(r.unhonoured).toEqual([]);
    expect(r.patched.map(p => p.element).sort()).toEqual([
      'ConfigurationKey', 'DeveloperDocumentation', 'FormRef',
    ]);
    // ConfigurationKey → DeveloperDocumentation → FormRef → Label
    const order = ['ConfigurationKey', 'DeveloperDocumentation', 'FormRef', 'Label']
      .map(e => r.xml.indexOf(`<${e}>`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(i => i >= 0)).toBe(true);
  });

  it('leaves a property the writer already wrote exactly as it is', () => {
    const r = reconcileTableCreateProperties(base, { label: 'Something else' });
    expect(r.patched).toEqual([]);
    expect(r.unhonoured).toEqual([]);
    expect(r.xml).toBe(base);
  });

  it('does not write a value that IS the serializer default', () => {
    // The AxTable serializer omits these; emitting them would show up as a
    // golden-metadata diff against every shipped table.
    const r = reconcileTableCreateProperties(base, {
      saveDataPerCompany: true,
      supportInheritance: false,
      tableType: 'Regular',
    });
    expect(r.patched).toEqual([]);
    expect(r.unhonoured).toEqual([]);
  });

  it('writes a NON-default NoYes property with the XML spelling, not true/false', () => {
    const r = reconcileTableCreateProperties(base, { saveDataPerCompany: false });
    expect(r.xml).toContain('<SaveDataPerCompany>No</SaveDataPerCompany>');
    expect(r.xml).not.toContain('>false<');
  });

  it('refuses an illegal enum value and names the legal ones', () => {
    const r = reconcileTableCreateProperties(base, { tableType: 'Nonsense' });
    expect(r.patched).toEqual([]);
    expect(r.unhonoured[0].detail).toMatch(/not a valid TableType/);
    expect(r.unhonoured[0].detail).toMatch(/TempDB/);
    expect(r.xml).not.toContain('Nonsense');
  });

  it('rejects a table-level name that only exists on an index (finding #13)', () => {
    const r = reconcileTableCreateProperties(base, { alternateKey: 'SettingIdx' });
    expect(r.patched).toEqual([]);
    expect(r.unhonoured[0].detail).toMatch(/INDEX property/);
    expect(r.xml).not.toContain('<AlternateKey>');
  });

  it('ignores the collections, which travel as their own bridge parameters', () => {
    const r = reconcileTableCreateProperties(base, {
      fields: [{ name: 'A' }], indexes: [], relations: [], methods: [], fieldGroups: [],
    });
    expect(r.patched).toEqual([]);
    expect(r.unhonoured).toEqual([]);
  });

  it('does nothing to a document that is not an AxTable', () => {
    const enumXml = '<AxEnum><Name>ConDemoEnum</Name></AxEnum>';
    const r = reconcileTableCreateProperties(enumXml, { configurationKey: 'K' });
    expect(r.xml).toBe(enumXml);
    expect(r.patched).toEqual([]);
  });

  it('renders nothing when there is nothing to say', () => {
    expect(renderTableCreateHonestyReport({ xml: base, patched: [], unhonoured: [] })).toBe('');
  });
});
