/**
 * Regression tests — add-field on an AxDataEntityViewExtension.
 *
 * The bridge owns this op (IMetaDataEntityViewExtensionProvider.Update); these tests
 * cover the TS half: the parameter contract, and the same-session direct-XML fallback
 * that runs when the bridge's fixed metadata roots cannot see an extension created
 * earlier in the same session.
 *
 * Three defects the fallback has to keep closed — all of them SILENT, all of them
 * answering "✅ added" while writing nothing usable:
 *
 *  1. Insertion point. An AxDataEntityViewExtension carries <FieldGroupExtensions>
 *     BEFORE <Fields>, and every <AxTableFieldGroupExtension> inside it has a nested
 *     <Fields> of its own. A plain content.replace('</Fields>', …) therefore closes the
 *     field GROUP, and the mapped field lands in a collection nothing reads it from.
 *     Verified against the shipped
 *     ApplicationSuite\Foundation\AxDataEntityViewExtension\CurrencyEntity.Extension.xml,
 *     which is exactly this shape.
 *
 *  2. Sub-element order. Shipped mapped fields put the presentation properties
 *     (Label, CountryRegionCodes, …) BEFORE the DataField/DataSource binding pair. The
 *     metadata deserializer drops children it meets out of order, so a Label written
 *     after DataSource is silently lost.
 *
 *  3. Idempotency scope. Testing a bare <Name>…</Name> against the whole file also
 *     matches the extension's own name, every field-group name and every
 *     AxPropertyModification — a false hit answers "already present" and writes nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddField, mockBridgeRefreshProvider } = vi.hoisted(() => ({
  mockBridgeAddField: vi.fn(),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddField: mockBridgeAddField,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

/**
 * Shape copied from the shipped CurrencyEntity.Extension.xml: a field-group extension
 * with its OWN nested <Fields>, sitting before the top-level <Fields>. This is the
 * fixture that catches defect #1 — the first </Fields> in the file is the wrong one.
 */
const ENTITY_EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityViewExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustCustomerV3Entity.ConExtension</Name>
\t<DataSources />
\t<FieldGroupExtensions>
\t\t<AxTableFieldGroupExtension>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>ConLoyaltyTier</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroupExtension>
\t</FieldGroupExtensions>
\t<FieldGroups />
\t<FieldModifications />
\t<Fields>
\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>ConLoyaltyTier</Name>
\t\t\t<DataField>ConLoyaltyTier</DataField>
\t\t\t<DataSource>CustTable</DataSource>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<Mappings />
\t<PropertyModifications />
\t<Relations />
</AxDataEntityViewExtension>`;

/** The same extension straight after create: every collection still self-closed. */
const ENTITY_EXTENSION_EMPTY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityViewExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustCustomerV3Entity.ConExtension</Name>
\t<DataSources />
\t<FieldGroupExtensions />
\t<FieldGroups />
\t<FieldModifications />
\t<Fields />
\t<Mappings />
\t<PropertyModifications />
\t<Relations />
</AxDataEntityViewExtension>`;

const { fixture, mockWriteFile } = vi.hoisted(() => ({
  fixture: { xml: '' },
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return fixture.xml;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  // The direct-XML writes go through writeFileAtomic: a temp sibling written with
  // writeFile, then renamed over the target (rm cleans the temp up on failure).
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    // Writes are measured against the anchor, not the active model (see getWriteAnchorModel).
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
    resolve: vi.fn(async (m: string) => ({
      packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
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
  // Empty, like resolveObjectPrefix above: these cases are about the mapped-field
  // binding and XML shape, so leaving names unprefixed keeps the fixtures
  // readable. Extension member prefixing has its own tests
  // (tests/tools/extensionMemberPrefix).
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const EXT_FILE_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxDataEntityViewExtension\\CustCustomerV3Entity.ConExtension.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const addFieldReq = (params: Record<string, unknown> = {}) =>
  req({
    objectType: 'data-entity-extension',
    objectName: 'CustCustomerV3Entity.ConExtension',
    operation: 'add-field',
    filePath: EXT_FILE_PATH,
    // Flat, not nested in `params`: these tests drive modifyD365FileTool directly,
    // and it is the d365fo_file dispatcher (one layer up) that merges `params` down
    // into this shape before calling it.
    fieldName: 'ConCreditRating',
    dataField: 'ConCreditRating',
    dataSource: 'CustTable',
    ...params,
  });

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare: vi.fn(() => stmt) },
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

/** The XML content of the writeFile call that landed the mapped field. */
const capturedXml = (): string | undefined => {
  const call = mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes('ConCreditRating'),
  );
  return call?.[1] as string | undefined;
};

describe('add-field on a data-entity-extension — parameter contract', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    fixture.xml = ENTITY_EXTENSION_XML;
    mockBridgeAddField.mockReset();
    mockWriteFile.mockClear();
  });

  it('routes to the bridge with the mapped-field binding, not the EDT path', async () => {
    mockBridgeAddField.mockResolvedValue({ success: true, message: '✅ Field added via IMetaDataEntityViewExtensionProvider.Update' });

    const result = await modifyD365FileTool(addFieldReq(), ctx);

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddField).toHaveBeenCalledTimes(1);
    const call = mockBridgeAddField.mock.calls[0];
    // …, fieldName, baseType, edt, mandatory, label, mapped
    expect(call[2]).toBe('ConCreditRating');
    expect(call[4]).toBeUndefined();                      // no EDT — a mapped field has none
    expect(call[7]).toMatchObject({ dataField: 'ConCreditRating', dataSource: 'CustTable' });
    // The bridge succeeded, so the file must not be touched by the fallback.
    expect(capturedXml()).toBeUndefined();
  });

  it('refuses a half-bound mapped field instead of writing it', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'data-entity-extension',
        objectName: 'CustCustomerV3Entity.ConExtension',
        operation: 'add-field',
        filePath: EXT_FILE_PATH,
        fieldName: 'ConCreditRating', dataField: 'ConCreditRating',
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toMatch(/BOTH dataField and dataSource/i);
    expect(mockBridgeAddField).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects dataField/dataSource on a table, where they mean nothing', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table',
        objectName: 'ConDemoTicket',
        operation: 'add-field',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConDemoTicket.xml',
        fieldName: 'ConCreditRating', dataField: 'ConCreditRating', dataSource: 'CustTable',
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toMatch(/do not apply to objectType="table"/i);
    expect(mockBridgeAddField).not.toHaveBeenCalled();
  });
});

describe('add-field on a same-session data-entity-extension (direct-XML fallback)', () => {
  let ctx: XppServerContext;

  // The bridge failure the fallback exists for: DiskProvider roots are fixed at
  // startup, so an extension created this session is simply not there.
  const RESOLUTION_FAILURE = {
    success: false,
    message: "Data entity view extension 'CustCustomerV3Entity.ConExtension' not found",
  };

  beforeEach(() => {
    ctx = buildContext();
    fixture.xml = ENTITY_EXTENSION_XML;
    mockBridgeAddField.mockReset();
    mockBridgeAddField.mockResolvedValue(RESOLUTION_FAILURE);
    mockWriteFile.mockClear();
  });

  it('writes into the TOP-LEVEL <Fields>, never the field group’s nested one', async () => {
    const result = await modifyD365FileTool(addFieldReq(), ctx);
    expect(result.isError).toBeFalsy();

    const xml = capturedXml();
    expect(xml).toBeTruthy();

    // The field group must be left exactly as it was: one AxTableFieldGroupField,
    // no AxDataEntityViewField anywhere inside it.
    const group = /<FieldGroupExtensions>[\s\S]*?<\/FieldGroupExtensions>/.exec(xml!)?.[0] ?? '';
    expect(group).not.toMatch(/AxDataEntityViewField/);
    expect(group).not.toMatch(/ConCreditRating/);

    // …and the new element sits in the top-level <Fields>, alongside the existing one.
    const fields = /<FieldModifications \/>\s*<Fields>[\s\S]*?<\/Fields>/.exec(xml!)?.[0] ?? '';
    expect(fields).toMatch(/<Name>ConLoyaltyTier<\/Name>/);
    expect(fields).toMatch(/<Name>ConCreditRating<\/Name>/);
  });

  it('emits the shipped sub-element order — Label BEFORE the binding pair', async () => {
    await modifyD365FileTool(addFieldReq({ fieldLabel: '@SYS12345' }), ctx);

    const xml = capturedXml();
    expect(xml).toMatch(
      /<AxDataEntityViewField xmlns=""\s*\r?\n?\s*i:type="AxDataEntityViewMappedField">\s*<Name>ConCreditRating<\/Name>\s*<Label>@SYS12345<\/Label>\s*<DataField>ConCreditRating<\/DataField>\s*<DataSource>CustTable<\/DataSource>\s*<\/AxDataEntityViewField>/,
    );
  });

  it('expands a self-closed <Fields /> on a freshly created extension', async () => {
    fixture.xml = ENTITY_EXTENSION_EMPTY_XML;

    await modifyD365FileTool(addFieldReq(), ctx);

    const xml = capturedXml();
    expect(xml).toMatch(/<Fields>\s*<AxDataEntityViewField[\s\S]*<\/AxDataEntityViewField>\s*<\/Fields>/);
    // The other self-closed collections stay self-closed.
    expect(xml).toMatch(/<Mappings \/>/);
    expect(xml).toMatch(/<DataSources \/>/);
  });

  it('registers the field in a base-entity field group when asked', async () => {
    await modifyD365FileTool(addFieldReq({ fieldGroupName: 'AutoReport' }), ctx);

    const xml = capturedXml();
    const group = /<FieldGroupExtensions>[\s\S]*?<\/FieldGroupExtensions>/.exec(xml!)?.[0] ?? '';
    // Appended to the EXISTING AutoReport group, not a duplicate group.
    expect(group.match(/<Name>AutoReport<\/Name>/g)?.length).toBe(1);
    expect(group).toMatch(/<DataField>ConLoyaltyTier<\/DataField>/);
    expect(group).toMatch(/<DataField>ConCreditRating<\/DataField>/);
    // Still a field-group REFERENCE, never a mapped-field element.
    expect(group).not.toMatch(/AxDataEntityViewField/);
  });

  it('creates the <FieldGroupExtensions> entry when the group is not there yet', async () => {
    fixture.xml = ENTITY_EXTENSION_EMPTY_XML;

    await modifyD365FileTool(addFieldReq({ fieldGroupName: 'AutoReport' }), ctx);

    const xml = capturedXml();
    expect(xml).toMatch(
      /<FieldGroupExtensions>\s*<AxTableFieldGroupExtension>\s*<Name>AutoReport<\/Name>\s*<Fields>\s*<AxTableFieldGroupField>\s*<DataField>ConCreditRating<\/DataField>\s*<\/AxTableFieldGroupField>\s*<\/Fields>\s*<\/AxTableFieldGroupExtension>\s*<\/FieldGroupExtensions>/,
    );
  });

  it('is idempotent on a field that is already mapped', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'data-entity-extension',
        objectName: 'CustCustomerV3Entity.ConExtension',
        operation: 'add-field',
        filePath: EXT_FILE_PATH,
        fieldName: 'ConLoyaltyTier', dataField: 'ConLoyaltyTier', dataSource: 'CustTable',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).toMatch(/already present/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does NOT mistake the extension’s own name for an existing field', async () => {
    // The idempotency probe used to test <Name>…</Name> against the whole file, so a
    // field named after the extension — or after a field group — answered "already
    // present" and wrote nothing.
    const result = await modifyD365FileTool(
      req({
        objectType: 'data-entity-extension',
        objectName: 'CustCustomerV3Entity.ConExtension',
        operation: 'add-field',
        filePath: EXT_FILE_PATH,
        fieldName: 'AutoReport', dataField: 'AutoReport', dataSource: 'CustTable',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).not.toMatch(/already present/i);
    const call = mockWriteFile.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('<Name>AutoReport</Name>'),
    );
    expect(call).toBeTruthy();
  });
});
