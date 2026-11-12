/**
 * modify-property ReferenceField on an EXISTING EDT (#1161).
 *
 * The related field of an EDT is a child of <TableReferences>, not a scalar
 * property, so the bridge's setter refused it ("Unknown AxEdt property
 * 'ReferenceField'"). These tests cover the XML writer and the modify tool path,
 * which must never hand ReferenceField to the bridge, and prove the reader
 * (edtRelationResolver) sees what was written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context';
import {
  isEdtReferenceFieldProperty, parseEdtReferenceFieldValue, setEdtTableReference,
} from '../../src/tools/xml/edtTableReferenceEdit';
import { edtRelationFromXml } from '../../src/tools/xml/edtRelationResolver';
import { claimedMarkerFor } from '../../src/tools/write/preserveMetadataElements';

const EDT = (opts: { props?: string; refs?: string; type?: string; tail?: string } = {}) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""\n' +
  `\ti:type="${opts.type ?? 'AxEdtString'}">\n` +
  '\t<Name>ContosoRentId</Name>\n' +
  (opts.props ?? '\t<Extends>Num</Extends>\n\t<Label>@ContosoExt:RentId</Label>\n') +
  '\t<ArrayElements />\n' +
  '\t<Relations />\n' +
  (opts.refs ?? '\t<TableReferences />\n') +
  (opts.tail ?? '\t<StringSize>20</StringSize>\n') +
  '</AxEdt>';

const FILLED = (table: string, field: string) =>
  '\t<TableReferences>\n' +
  '\t\t<AxEdtTableReference>\n' +
  `\t\t\t<RelatedField>${field}</RelatedField>\n` +
  `\t\t\t<Table>${table}</Table>\n` +
  '\t\t</AxEdtTableReference>\n' +
  '\t</TableReferences>\n';

const ok = (r: ReturnType<typeof setEdtTableReference>) => {
  if (!r || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};
const refused = (r: ReturnType<typeof setEdtTableReference>) => {
  if (!r || r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.error;
};

describe('ReferenceField value', () => {
  it('names the property in any case, and nothing else', () => {
    expect(isEdtReferenceFieldProperty('ReferenceField')).toBe(true);
    expect(isEdtReferenceFieldProperty(' referencefield ')).toBe(true);
    expect(isEdtReferenceFieldProperty('ReferenceTable')).toBe(false);
  });

  it('reads a bare field and Table.Field', () => {
    expect(parseEdtReferenceFieldValue('RentId')).toEqual({ ok: true, relatedField: 'RentId' });
    expect(parseEdtReferenceFieldValue(' ContosoRentTable.RentId ')).toEqual({ ok: true, table: 'ContosoRentTable', relatedField: 'RentId' });
  });

  it.each(['', '   ', 'A.B.C', 'Rent Id', '<RentId>', '.RentId', 'ContosoRentTable.', 42])('refuses %j', v => {
    expect(parseEdtReferenceFieldValue(v).ok).toBe(false);
  });
});

describe('setEdtTableReference', () => {
  it('fills an empty <TableReferences /> from Table.Field and writes <ReferenceTable> in order', () => {
    const r = ok(setEdtTableReference(EDT(), 'ContosoRentTable.RentId'));
    expect(r.changed).toBe(true);
    expect(r.wroteReferenceTable).toBe(true);
    expect(r.xml).toBe(EDT({
      props: '\t<Extends>Num</Extends>\n\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n',
      refs: FILLED('ContosoRentTable', 'RentId'),
    }));
    expect(edtRelationFromXml(r.xml)).toEqual({ table: 'ContosoRentTable', relatedField: 'RentId' });
  });

  it('places <ReferenceTable> in front of a property that sorts after it', () => {
    const r = ok(setEdtTableReference(
      EDT({ props: '\t<Label>@ContosoExt:RentId</Label>\n\t<Style>Combo</Style>\n' }), 'ContosoRentTable.RentId'));
    expect(r.xml).toContain(
      '\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n\t<Style>Combo</Style>\n\t<ArrayElements />');
  });

  it('takes the table from <ReferenceTable> for a bare field and leaves that element alone', () => {
    const before = EDT({ props: '\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n' });
    const r = ok(setEdtTableReference(before, 'RentId'));
    expect(r.wroteReferenceTable).toBe(false);
    expect(r.xml).toBe(EDT({
      props: '\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n',
      refs: FILLED('ContosoRentTable', 'RentId'),
    }));
  });

  it('fills the open empty form as well', () => {
    const r = ok(setEdtTableReference(EDT({ refs: '\t<TableReferences>\n\t</TableReferences>\n' }), 'CustTable.AccountNum'));
    expect(r.xml).toContain(FILLED('CustTable', 'AccountNum'));
    expect(r.xml.match(/<TableReferences>/g)).toHaveLength(1);
  });

  it('adds <TableReferences> after <Relations /> when the file has none', () => {
    const r = ok(setEdtTableReference(EDT({ refs: '' }), 'CustTable.AccountNum'));
    expect(r.xml).toContain('\t<Relations />\n' + FILLED('CustTable', 'AccountNum') + '\t<StringSize>20</StringSize>\n');
  });

  it('replaces an existing reference in place instead of adding a second', () => {
    const before = EDT({
      props: '\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n',
      refs: FILLED('ContosoRentTable', 'RentId'),
    });
    const r = ok(setEdtTableReference(before, 'CustTable.AccountNum'));
    expect(r.xml).toBe(EDT({
      props: '\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>CustTable</ReferenceTable>\n',
      refs: FILLED('CustTable', 'AccountNum'),
    }));
    expect(r.xml.match(/<AxEdtTableReference>/g)).toHaveLength(1);
    expect(edtRelationFromXml(r.xml)).toEqual({ table: 'CustTable', relatedField: 'AccountNum' });
  });

  it('changes only the field of an existing reference for a bare field, table from the reference', () => {
    // No <ReferenceTable> property: the reference the EDT already has names the table.
    const r = ok(setEdtTableReference(EDT({ refs: FILLED('ContosoRentTable', 'RentId') }), 'AgreementId'));
    expect(r.xml).toBe(EDT({ refs: FILLED('ContosoRentTable', 'AgreementId') }));
    expect(r.wroteReferenceTable).toBe(false);
  });

  it('reports no change when the reference is already there', () => {
    const before = EDT({
      props: '\t<ReferenceTable>CustTable</ReferenceTable>\n',
      refs: FILLED('CustTable', 'AccountNum'),
    });
    const r = ok(setEdtTableReference(before, 'CustTable.AccountNum'));
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(before);
  });

  it('keeps CRLF line endings and a space-indented file as they are', () => {
    const crlf = EDT().replace(/\n/g, '\r\n');
    const r = ok(setEdtTableReference(crlf, 'ContosoRentTable.RentId'));
    expect(r.xml).not.toMatch(/[^\r]\n/);
    expect(r.xml).toContain('\t<TableReferences>\r\n\t\t<AxEdtTableReference>\r\n\t\t\t<RelatedField>RentId</RelatedField>\r\n');

    const spaces = EDT().replace(/\t/g, '  ');
    expect(ok(setEdtTableReference(spaces, 'ContosoRentTable.RentId')).xml)
      .toContain('  <TableReferences>\n    <AxEdtTableReference>\n      <RelatedField>RentId</RelatedField>\n');
  });

  it.each(['AxEdtInt', 'AxEdtInt64'])('works on %s, with nothing after <TableReferences />', type => {
    const r = ok(setEdtTableReference(EDT({ type, tail: '' }), 'ContosoRentTable.RecId'));
    expect(r.xml).toContain(FILLED('ContosoRentTable', 'RecId') + '</AxEdt>');
    expect(edtRelationFromXml(r.xml)).toEqual({ table: 'ContosoRentTable', relatedField: 'RecId' });
  });

  it('refuses a bare field when the EDT names no table, and asks for it', () => {
    const error = refused(setEdtTableReference(EDT(), 'RentId'));
    expect(error).toMatch(/no ReferenceTable/);
    expect(error).toContain('<Table>.RentId');
  });

  const LEGACY = (table: string, field: string) =>
    `\t<Relations>\n\t\t<AxEdtRelation>\n\t\t\t<RelatedField>${field}</RelatedField>\n\t\t\t<Table>${table}</Table>\n\t\t</AxEdtRelation>\n\t</Relations>\n`;
  /** Both filled with the same values, as many shipped EDTs are. */
  const BOTH = (table: string, field: string) =>
    EDT({ props: `\t<ReferenceTable>${table}</ReferenceTable>\n`, refs: FILLED(table, field) })
      .replace('\t<Relations />\n', LEGACY(table, field));

  it('keeps a single legacy relation in agreement with the table reference', () => {
    const r = ok(setEdtTableReference(BOTH('CustTable', 'AccountNum'), 'ContosoRentTable.RentId'));
    expect(r.xml).toBe(BOTH('ContosoRentTable', 'RentId'));
    expect(r.syncedLegacyRelation).toBe(true);
    expect(r.xml.match(/<AxEdtRelation>/g)).toHaveLength(1);
    expect(edtRelationFromXml(r.xml)).toEqual({ table: 'ContosoRentTable', relatedField: 'RentId' });

    // Already in agreement: nothing to do, nothing claimed.
    const same = ok(setEdtTableReference(BOTH('CustTable', 'AccountNum'), 'AccountNum'));
    expect(same.changed).toBe(false);
    expect(same.syncedLegacyRelation).toBe(false);
  });

  it('updates a legacy relation that has no table reference beside it, and never creates one', () => {
    const r = ok(setEdtTableReference(EDT().replace('\t<Relations />\n', LEGACY('CustTable', 'AccountNum')), 'VendTable.AccountNum'));
    expect(r.xml).toContain(LEGACY('VendTable', 'AccountNum') + FILLED('VendTable', 'AccountNum'));
    expect(ok(setEdtTableReference(EDT(), 'CustTable.AccountNum')).xml).toContain('\t<Relations />\n');
    // A bare field takes the table from the legacy relation when nothing else names one.
    const bare = ok(setEdtTableReference(EDT().replace('\t<Relations />\n', LEGACY('CustTable', 'AccountNum')), 'PartyId'));
    expect(bare.xml).toContain(LEGACY('CustTable', 'PartyId') + FILLED('CustTable', 'PartyId'));
  });

  it('adds the related field to a reference that names only a table', () => {
    const tableOnly = EDT({ refs: '\t<TableReferences>\n\t\t<AxEdtTableReference>\n\t\t\t<Table>CustTable</Table>\n\t\t</AxEdtTableReference>\n\t</TableReferences>\n' });
    expect(ok(setEdtTableReference(tableOnly, 'AccountNum')).xml).toBe(EDT({ refs: FILLED('CustTable', 'AccountNum') }));
  });

  it('refuses an EDT with several legacy relations or several references', () => {
    const legacy = EDT().replace('\t<Relations />\n', LEGACY('CustTable', 'AccountNum').replace(
      '\t</Relations>\n',
      '\t\t<AxEdtRelation>\n\t\t\t<RelatedField>AccountNum</RelatedField>\n\t\t\t<Table>VendTable</Table>\n\t\t</AxEdtRelation>\n\t</Relations>\n'));
    expect(refused(setEdtTableReference(legacy, 'CustTable.AccountNum'))).toMatch(/2 legacy relations/);

    const two = EDT({ refs: FILLED('CustTable', 'AccountNum').replace(
      '\t</TableReferences>\n',
      '\t\t<AxEdtTableReference>\n\t\t\t<RelatedField>AccountNum</RelatedField>\n\t\t\t<Table>VendTable</Table>\n\t\t</AxEdtTableReference>\n\t</TableReferences>\n') });
    expect(refused(setEdtTableReference(two, 'CustTable.AccountNum'))).toMatch(/2 table references/);
  });

  it('refuses an invalid value and leaves other documents to the generic path', () => {
    expect(refused(setEdtTableReference(EDT(), 'Cust Table.AccountNum'))).toMatch(/Invalid ReferenceField/);
    expect(setEdtTableReference('<AxEdtExtension><Name>CustAccount.ContosoExt</Name></AxEdtExtension>', 'CustTable.AccountNum')).toBeUndefined();
    expect(setEdtTableReference('<AxTable><Name>ContosoRentTable</Name></AxTable>', 'CustTable.AccountNum')).toBeUndefined();
  });
});

describe('claim check', () => {
  it('looks for the <RelatedField> of the reference, not a <ReferenceField> element', () => {
    const marker = claimedMarkerFor('modify-property', { objectType: 'edt', propertyPath: 'ReferenceField', propertyValue: 'CustTable.AccountNum' })!;
    expect(marker.pattern.test(EDT({ refs: FILLED('CustTable', 'AccountNum') }))).toBe(true);
    expect(marker.pattern.test(EDT())).toBe(false);
  });
});

// ── Through the modify tool ─────────────────────────────────────────────────

const { files, mockBridgeSetProperty } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mockBridgeSetProperty: vi.fn(async () => ({ success: true, message: 'set by bridge' })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async orig => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeSetProperty: mockBridgeSetProperty,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

vi.mock('fs/promises', () => {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    readFile: vi.fn(async (p: string) => {
      if (files.has(p)) return files.get(p)!;
      if (p.endsWith('.rnrproj')) return '<Project><ItemGroup></ItemGroup></Project>';
      throw enoent();
    }),
    writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    rename: vi.fn(async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); }),
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, mtimeMs: 0, size: 1 })),
    readdir: vi.fn(async () => []),
    copyFile: vi.fn(async () => {}),
    rm: vi.fn(async (p: string) => { files.delete(p); }),
  };
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
    resolve: vi.fn(async (m: string) => ({ packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({ packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', async orig => ({
  ...(await orig<typeof import('../../src/utils/modelClassifier')>()),
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const { modifyD365FileTool } = await import('../../src/tools/write/modifyD365File');

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['ContosoExt']),
      db: { prepare: vi.fn(() => stmt) },
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    } as any,
    parser: {} as any,
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => {}), generateSearchKey: vi.fn((q: string) => `k:${q}`) } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

const filePath = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxEdt\\ContosoRentId.xml';
const textOf = (r: any) => (r.content as Array<{ text: string }>).map(c => c.text).join('\n');
const modify = (propertyPath: string, propertyValue: string) => modifyD365FileTool(
  req({ objectType: 'edt', objectName: 'ContosoRentId', operation: 'modify-property', propertyPath, propertyValue, filePath }),
  buildContext(),
);

describe('d365fo_file modify-property ReferenceField on an EDT', () => {
  beforeEach(() => { files.clear(); mockBridgeSetProperty.mockClear(); });

  it('writes table and field in one call without calling the bridge', async () => {
    files.set(filePath, EDT());
    const r = await modify('ReferenceField', 'ContosoRentTable.RentId');
    expect((r as any).isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain('ContosoRentTable.RentId');
    expect(textOf(r)).not.toContain('Verification');
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();

    const xml = files.get(filePath)!;
    expect(xml).toMatch(/<ReferenceTable>ContosoRentTable<\/ReferenceTable>\r?\n\t<ArrayElements \/>/);
    expect(xml.match(/<AxEdtTableReference>/g)).toHaveLength(1);
    expect(edtRelationFromXml(xml)).toEqual({ table: 'ContosoRentTable', relatedField: 'RentId' });
  });

  it('takes the table from an earlier ReferenceTable and replaces the reference on a second call', async () => {
    files.set(filePath, EDT({ props: '\t<Label>@ContosoExt:RentId</Label>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n' }));
    for (const field of ['RentId', 'AgreementId']) {
      const r = await modify('ReferenceField', field);
      expect((r as any).isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).not.toContain('Verification');
    }
    const xml = files.get(filePath)!;
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();
    expect(xml.match(/<AxEdtTableReference>/g)).toHaveLength(1);
    expect(edtRelationFromXml(xml)).toEqual({ table: 'ContosoRentTable', relatedField: 'AgreementId' });
  });

  it('fails without writing when no table is known', async () => {
    const before = EDT();
    files.set(filePath, before);
    const r = await modify('ReferenceField', 'RentId');
    expect((r as any).isError).toBe(true);
    expect(textOf(r)).toMatch(/no ReferenceTable/);
    expect(textOf(r)).toContain('Nothing was written');
    expect(files.get(filePath)).toBe(before);
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();
  });

  it('says so when it also updated the legacy relation', async () => {
    files.set(filePath, EDT({ refs: FILLED('CustTable', 'AccountNum') }).replace(
      '\t<Relations />\n',
      '\t<Relations>\n\t\t<AxEdtRelation>\n\t\t\t<RelatedField>AccountNum</RelatedField>\n\t\t\t<Table>CustTable</Table>\n\t\t</AxEdtRelation>\n\t</Relations>\n'));
    const r = await modify('ReferenceField', 'ContosoRentTable.RentId');
    expect((r as any).isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/legacy relation .* was updated/);
    expect(textOf(r)).not.toContain('Verification');
    const xml = files.get(filePath)!;
    expect(xml).toMatch(/<AxEdtRelation>\r?\n\t\t\t<RelatedField>RentId<\/RelatedField>\r?\n\t\t\t<Table>ContosoRentTable<\/Table>/);
    expect(edtRelationFromXml(xml)).toEqual({ table: 'ContosoRentTable', relatedField: 'RentId' });
  });

  it('still hands ReferenceTable to the bridge', async () => {
    files.set(filePath, EDT());
    await modify('ReferenceTable', 'ContosoRentTable');
    expect(mockBridgeSetProperty).toHaveBeenCalledTimes(1);
  });
});
