/**
 * modify-property OperationalDomain / SubscriberAccessLevel on an EXISTING table or
 * menu item.
 *
 * New objects get both from the create reconcile. Existing ones could not be
 * fixed: menu items had no property writer for either, and SubscriberAccessLevel
 * holds child elements. These tests cover the XML writer and the modify tool path,
 * which must never hand the two properties to the bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context';
import { bpAccessPropertyOf, isBpAccessObjectType, setBpAccessProperty } from '../../src/tools/xml/bpAccessPropertyModify';
import { parseSubscriberAccessLevel } from '../../src/utils/subscriberAccessLevel';

const TABLE = (props = '') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
  '\t<Name>ContosoClaimLine</Name>\n' +
  '\t<SourceCode>\n\t\t<Methods />\n\t</SourceCode>\n' +
  '\t<Label>@ContosoExt:ClaimLine</Label>\n' +
  props +
  '\t<TableGroup>Transaction</TableGroup>\n' +
  '\t<DeleteActions />\n' +
  '\t<FieldGroups />\n' +
  '\t<Fields>\n' +
  '\t\t<AxTableField xmlns="" i:type="AxTableFieldString">\n\t\t\t<Name>ClaimId</Name>\n\t\t</AxTableField>\n' +
  '\t</Fields>\n' +
  '\t<Indexes />\n' +
  '\t<Relations />\n' +
  '</AxTable>';

const MENU = (root: string, objectType: string, extra = '') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  `<${root} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">\n` +
  '\t<Name>ContosoClaimMatch</Name>\n' +
  '\t<Label>@ContosoExt:ClaimMatch</Label>\n' +
  '\t<Object>ContosoClaimMatchController</Object>\n' +
  `\t<ObjectType>${objectType}</ObjectType>\n` +
  extra +
  `</${root}>`;

const NO_ACCESS_MENU =
  '\t<SubscriberAccessLevel>\n' +
  '\t\t<Correct xmlns="">Deny</Correct>\n\t\t<Create xmlns="">Deny</Create>\n\t\t<Delete xmlns="">Deny</Delete>\n' +
  '\t\t<Invoke xmlns="">Deny</Invoke>\n\t\t<Read xmlns="">Deny</Read>\n\t\t<Update xmlns="">Deny</Update>\n' +
  '\t</SubscriberAccessLevel>\n';

const ok = (r: ReturnType<typeof setBpAccessProperty>) => {
  if (!r || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

describe('accepted values', () => {
  it('reads NoAccess, All, Read and an explicit list', () => {
    const all6 = (v: string) => ({ Correct: v, Create: v, Delete: v, Invoke: v, Read: v, Update: v });
    expect(parseSubscriberAccessLevel('NoAccess')).toEqual({ ok: true, level: all6('Deny') });
    expect(parseSubscriberAccessLevel('No Access')).toEqual({ ok: true, level: all6('Deny') });
    expect(parseSubscriberAccessLevel('All')).toEqual({ ok: true, level: all6('Allow') });
    expect(parseSubscriberAccessLevel('Read')).toEqual({ ok: true, level: { Read: 'Allow' } });
    expect(parseSubscriberAccessLevel('Read=Allow,Create=Deny')).toEqual({ ok: true, level: { Read: 'Allow', Create: 'Deny' } });
  });

  it('names the two properties and the object types it serves', () => {
    expect(bpAccessPropertyOf('operationalDomain')).toBe('OperationalDomain');
    expect(bpAccessPropertyOf('SubscriberAccessLevel')).toBe('SubscriberAccessLevel');
    expect(bpAccessPropertyOf('Label')).toBeUndefined();
    for (const t of ['table', 'menu-item-action', 'menu-item-display', 'menu-item-output']) {
      expect(isBpAccessObjectType(t)).toBe(true);
    }
    expect(isBpAccessObjectType('table-extension')).toBe(false);
    expect(isBpAccessObjectType('menu-item-display-extension')).toBe(false);
  });
});

describe('tables', () => {
  it('puts OperationalDomain after Label and replaces it on a second call', () => {
    const first = ok(setBpAccessProperty(TABLE(), 'OperationalDomain', 'company'));
    expect(first.xml).toContain('\t<Label>@ContosoExt:ClaimLine</Label>\n\t<OperationalDomain>Company</OperationalDomain>\n\t<TableGroup>');
    expect(first.bpNote).toBeUndefined();
    const second = ok(setBpAccessProperty(first.xml, 'OperationalDomain', 'Shared'));
    expect(second.xml.match(/<OperationalDomain>/g)).toHaveLength(1);
    expect(second.xml).toContain('<OperationalDomain>Shared</OperationalDomain>');
    expect(second.bpNote).toMatch(/expects OperationalDomain=Company/);
  });

  it('writes SubscriberAccessLevel children in canonical order after OperationalDomain, replacing an existing one', () => {
    const start = TABLE('\t<OperationalDomain>Local</OperationalDomain>\n\t<SubscriberAccessLevel>\n\t\t<Read>Allow</Read>\n\t</SubscriberAccessLevel>\n')
      .replace('<TableGroup>Transaction</TableGroup>', '<TableGroup>Transaction</TableGroup>\n\t<TableType>TempDB</TableType>');
    const r = ok(setBpAccessProperty(start, 'SubscriberAccessLevel', 'NoAccess'));
    expect(r.xml).toContain(
      '\t<OperationalDomain>Local</OperationalDomain>\n\t<SubscriberAccessLevel>\n' +
      '\t\t<Correct>Deny</Correct>\n\t\t<Create>Deny</Create>\n\t\t<Delete>Deny</Delete>\n' +
      '\t\t<Invoke>Deny</Invoke>\n\t\t<Read>Deny</Read>\n\t\t<Update>Deny</Update>\n' +
      '\t</SubscriberAccessLevel>\n\t<TableGroup>',
    );
    expect(r.xml.match(/<SubscriberAccessLevel>/g)).toHaveLength(1);
    expect(r.bpNote).toBeUndefined();
  });

  it('reports no change when the value is already there', () => {
    const r = ok(setBpAccessProperty(TABLE('\t<OperationalDomain>Company</OperationalDomain>\n'), 'OperationalDomain', 'Company'));
    expect(r.changed).toBe(false);
  });

  it('refuses an invalid value', () => {
    expect(setBpAccessProperty(TABLE(), 'OperationalDomain', 'Global')).toMatchObject({ ok: false });
    expect(setBpAccessProperty(TABLE(), 'SubscriberAccessLevel', 'Read=Maybe')).toMatchObject({ ok: false });
  });
});

describe('menu items', () => {
  it('Action on a class: NoAccess with xmlns="" children, alphabetically after ObjectType, no BP note', () => {
    const od = ok(setBpAccessProperty(MENU('AxMenuItemAction', 'Class'), 'OperationalDomain', 'Local'));
    const r = ok(setBpAccessProperty(od.xml, 'SubscriberAccessLevel', 'NoAccess'));
    expect(r.xml).toContain(
      '\t<ObjectType>Class</ObjectType>\n\t<OperationalDomain>Local</OperationalDomain>\n' + NO_ACCESS_MENU + '</AxMenuItemAction>',
    );
    expect(r.bpNote).toBeUndefined();
  });

  it('sets only the property it was asked for', () => {
    const r = ok(setBpAccessProperty(MENU('AxMenuItemDisplay', 'Form'), 'SubscriberAccessLevel', 'Read'));
    expect(r.xml).not.toContain('<OperationalDomain>');
    expect(r.xml).toContain('\t<SubscriberAccessLevel>\n\t\t<Read xmlns="">Allow</Read>\n\t</SubscriberAccessLevel>\n</AxMenuItemDisplay>');
  });

  it('replaces an existing access level instead of adding a second one, and keeps CRLF', () => {
    const crlf = MENU('AxMenuItemDisplay', 'Class', NO_ACCESS_MENU).replace(/\n/g, '\r\n');
    const r = ok(setBpAccessProperty(crlf, 'SubscriberAccessLevel', 'All'));
    expect(r.xml.match(/<SubscriberAccessLevel>/g)).toHaveLength(1);
    expect(r.xml).toContain('<Correct xmlns="">Allow</Correct>\r\n');
    expect(r.xml).not.toMatch(/[^\r]\n/);
    expect(r.bpNote).toBeUndefined();
  });

  it('notes when the value is not what xppbp expects', () => {
    const r = ok(setBpAccessProperty(MENU('AxMenuItemAction', 'Class'), 'SubscriberAccessLevel', 'Read'));
    expect(r.bpNote).toMatch(/expects SubscriberAccessLevel Correct=Deny/);
  });

  it('places OperationalDomain before an element that sorts after it', () => {
    const r = ok(setBpAccessProperty(MENU('AxMenuItemOutput', 'SSRSReport', '\t<ReportDesign>Report</ReportDesign>\n'), 'OperationalDomain', 'Shared'));
    expect(r.xml).toContain('<ObjectType>SSRSReport</ObjectType>\n\t<OperationalDomain>Shared</OperationalDomain>\n\t<ReportDesign>');
  });

  it('leaves other documents to the generic path', () => {
    expect(setBpAccessProperty('<AxClass><Name>X</Name></AxClass>', 'OperationalDomain', 'Local')).toBeUndefined();
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

const PKG = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt';
const textOf = (r: any) => (r.content as Array<{ text: string }>).map(c => c.text).join('\n');

describe('d365fo_file modify-property', () => {
  beforeEach(() => { files.clear(); mockBridgeSetProperty.mockClear(); });

  it('sets both properties on a table without calling the bridge', async () => {
    const filePath = `${PKG}\\AxTable\\ContosoClaimLine.xml`;
    files.set(filePath, TABLE());
    for (const [propertyPath, propertyValue] of [['OperationalDomain', 'Company'], ['SubscriberAccessLevel', 'Read']]) {
      const r = await modifyD365FileTool(
        req({ objectType: 'table', objectName: 'ContosoClaimLine', operation: 'modify-property', propertyPath, propertyValue, filePath }),
        buildContext(),
      );
      expect((r as any).isError, textOf(r)).toBeFalsy();
    }
    expect(mockBridgeSetProperty).not.toHaveBeenCalled();
    expect(files.get(filePath)).toMatch(
      /<Label>@ContosoExt:ClaimLine<\/Label>\r?\n\t<OperationalDomain>Company<\/OperationalDomain>\r?\n\t<SubscriberAccessLevel>\r?\n\t\t<Read>Allow<\/Read>\r?\n\t<\/SubscriberAccessLevel>\r?\n\t<TableGroup>/,
    );
  });

  for (const [objectType, root, ot, value] of [
    ['menu-item-action', 'AxMenuItemAction', 'Class', 'NoAccess'],
    ['menu-item-display', 'AxMenuItemDisplay', 'Form', 'Read'],
    ['menu-item-output', 'AxMenuItemOutput', 'SSRSReport', 'Read'],
  ] as const) {
    it(`sets both properties on a ${objectType}`, async () => {
      const filePath = `${PKG}\\${root}\\ContosoClaimMatch.xml`;
      files.set(filePath, MENU(root, ot));
      for (const [propertyPath, propertyValue] of [['OperationalDomain', 'Local'], ['SubscriberAccessLevel', value]]) {
        const r = await modifyD365FileTool(
          req({ objectType, objectName: 'ContosoClaimMatch', operation: 'modify-property', propertyPath, propertyValue, filePath }),
          buildContext(),
        );
        expect((r as any).isError, textOf(r)).toBeFalsy();
      }
      const xml = files.get(filePath)!;
      expect(mockBridgeSetProperty).not.toHaveBeenCalled();
      expect(xml).toMatch(/<OperationalDomain>Local<\/OperationalDomain>\r?\n\t<SubscriberAccessLevel>/);
      expect(xml).toMatch(/<Read xmlns="">(Allow|Deny)<\/Read>/);
      expect(xml.match(/<SubscriberAccessLevel>/g)).toHaveLength(1);
    });
  }

  it('fails without writing on an invalid value', async () => {
    const filePath = `${PKG}\\AxMenuItemAction\\ContosoClaimMatch.xml`;
    const before = MENU('AxMenuItemAction', 'Class');
    files.set(filePath, before);
    const r = await modifyD365FileTool(
      req({ objectType: 'menu-item-action', objectName: 'ContosoClaimMatch', operation: 'modify-property', propertyPath: 'OperationalDomain', propertyValue: 'Tenant', filePath }),
      buildContext(),
    );
    expect((r as any).isError).toBe(true);
    expect(textOf(r)).toMatch(/Company, Shared or Local/);
    expect(files.get(filePath)).toBe(before);
  });
});
