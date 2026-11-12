/**
 * modify-property on a menu item or a menu for a property the file does not have yet.
 *
 * The bridge has a case for a handful of menu item properties and none for a menu,
 * and the generic XML fallback only replaces an element that is there already. So
 * Parameters, EnumParameter, EnumTypeParameter, ImageLocation and the rest failed
 * with "Unknown AxMenuItem property" on every item that did not carry them. These
 * tests cover the XML writer and the modify tool path behind a refusing bridge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context';
import { menuPropertiesOf, upsertMenuProperty } from '../../src/tools/xml/menuPropertyUpsert';

const ITEM = (root: string, extra = '') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  `<${root} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">\n` +
  '\t<Name>ContosoClaimMatch</Name>\n' +
  '\t<Label>@ContosoExt:ClaimMatch</Label>\n' +
  '\t<Object>ContosoClaimMatch</Object>\n' +
  '\t<ObjectType>Class</ObjectType>\n' +
  extra +
  `</${root}>`;

/** The top level of the shipped menu the menu tests are cut from, items renamed. */
const MENU = (props = '\t<Label>@ContosoExt:Main</Label>\n\t<SetCompany>Yes</SetCompany>\n') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">\n' +
  '\t<Name>ContosoMain</Name>\n' +
  props +
  '\t<Elements>\n' +
  '\t\t<AxMenuElement xmlns=""\n\t\t\ti:type="AxMenuElementSubMenu">\n' +
  '\t\t\t<Name>Setup</Name>\n' +
  '\t\t\t<Label>@ContosoExt:Setup</Label>\n' +
  '\t\t\t<Elements>\n' +
  '\t\t\t\t<AxMenuElement xmlns=""\n\t\t\t\t\ti:type="AxMenuElementMenuItem">\n' +
  '\t\t\t\t\t<Name>ContosoParameters</Name>\n' +
  '\t\t\t\t\t<MenuItemName>ContosoParameters</MenuItemName>\n' +
  '\t\t\t\t</AxMenuElement>\n' +
  '\t\t\t</Elements>\n' +
  '\t\t</AxMenuElement>\n' +
  '\t</Elements>\n' +
  '</AxMenu>';

const topLevel = (xml: string) => [...xml.matchAll(/^\t<(\w+)[\s/>]/gm)].map(m => m[1]);

const ok = (r: ReturnType<typeof upsertMenuProperty>) => {
  if (!r || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

describe('upsertMenuProperty on a menu item', () => {
  for (const root of ['AxMenuItemDisplay', 'AxMenuItemAction', 'AxMenuItemOutput']) {
    it(`${root}: inserts absent properties alphabetically among the siblings after Name`, () => {
      let xml = ok(upsertMenuProperty(ITEM(root), 'Parameters', 'Posted')).xml;
      xml = ok(upsertMenuProperty(xml, 'EnumTypeParameter', 'NoYes')).xml;
      xml = ok(upsertMenuProperty(xml, 'EnumParameter', 'Yes')).xml;
      xml = ok(upsertMenuProperty(xml, 'ImageLocation', 'EmbeddedResource')).xml;
      expect(topLevel(xml)).toEqual([
        'Name', 'EnumParameter', 'EnumTypeParameter', 'ImageLocation', 'Label', 'Object', 'ObjectType', 'Parameters',
      ]);
      expect(xml).toContain(`\t<Parameters>Posted</Parameters>\n</${root}>`);
      expect(xml).toContain('\t<Name>ContosoClaimMatch</Name>\n\t<EnumParameter>Yes</EnumParameter>\n');
    });
  }

  it('replaces an element that is there, and reports no change for the same value', () => {
    const start = ITEM('AxMenuItemDisplay', '\t<Parameters>Open</Parameters>\n');
    const r = ok(upsertMenuProperty(start, 'Parameters', 'Posted'));
    expect(r).toMatchObject({ changed: true, root: 'AxMenuItemDisplay', written: "Parameters='Posted'" });
    expect(r.xml.match(/<Parameters>/g)).toHaveLength(1);
    expect(r.xml).toContain('\t<Parameters>Posted</Parameters>\n</AxMenuItemDisplay>');
    expect(ok(upsertMenuProperty(r.xml, 'Parameters', 'Posted'))).toMatchObject({ changed: false, xml: r.xml });
  });

  it('replaces a self-closed element', () => {
    const r = ok(upsertMenuProperty(ITEM('AxMenuItemAction', '\t<Parameters />\n'), 'Parameters', 'Posted'));
    expect(r.xml).toContain('\t<ObjectType>Class</ObjectType>\n\t<Parameters>Posted</Parameters>\n</AxMenuItemAction>');
  });

  it('matches the name in any case and writes the canonical one', () => {
    const r = ok(upsertMenuProperty(ITEM('AxMenuItemAction'), 'enumtypeparameter', 'NoYes'));
    expect(r.xml).toContain('\t<EnumTypeParameter>NoYes</EnumTypeParameter>\n\t<Label>');
    expect(r.written).toBe("EnumTypeParameter='NoYes'");
  });

  it('escapes the value', () => {
    const r = ok(upsertMenuProperty(ITEM('AxMenuItemDisplay'), 'Parameters', 'a<b & c'));
    expect(r.xml).toContain('<Parameters>a&lt;b &amp; c</Parameters>');
  });

  it('removes the element on an empty value, and is a no-op when it is not there', () => {
    const start = ITEM('AxMenuItemDisplay', '\t<Parameters>Open</Parameters>\n');
    const r = ok(upsertMenuProperty(start, 'Parameters', ''));
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(ITEM('AxMenuItemDisplay'));
    expect(ok(upsertMenuProperty(r.xml, 'Parameters', ''))).toMatchObject({ changed: false, xml: r.xml });
  });

  it('refuses a name that is not a menu item property, with the known ones', () => {
    const r = upsertMenuProperty(ITEM('AxMenuItemDisplay'), 'SetCompany', 'Yes');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/'SetCompany' is not an AxMenuItemDisplay property/);
    expect((r as { error: string }).error).toContain('EnumTypeParameter');
    expect((r as { error: string }).error).toContain('Parameters');
  });

  it('keeps CRLF', () => {
    const crlf = ITEM('AxMenuItemOutput').replace(/\n/g, '\r\n');
    const r = ok(upsertMenuProperty(crlf, 'Parameters', 'Posted'));
    expect(r.xml).toContain('<ObjectType>Class</ObjectType>\r\n\t<Parameters>Posted</Parameters>\r\n</AxMenuItemOutput>');
    expect(r.xml).not.toMatch(/[^\r]\n/);
  });

  it('follows a space indent', () => {
    const spaces = ITEM('AxMenuItemDisplay').replace(/\t/g, '  ');
    const r = ok(upsertMenuProperty(spaces, 'HelpText', '@ContosoExt:ClaimMatchHelp'));
    expect(r.xml).toContain('  <Name>ContosoClaimMatch</Name>\n  <HelpText>@ContosoExt:ClaimMatchHelp</HelpText>\n  <Label>');
  });

  it('leaves to the caller what is not its own', () => {
    // The bridge names the legal values of these two when it refuses one.
    expect(upsertMenuProperty(ITEM('AxMenuItemDisplay'), 'ObjectType', 'Form')).toBeUndefined();
    expect(upsertMenuProperty(ITEM('AxMenuItemDisplay'), 'OpenMode', 'Sideways')).toBeUndefined();
    // A nested path, another document, an extension.
    expect(upsertMenuProperty(ITEM('AxMenuItemDisplay'), 'Design.Caption', 'x')).toBeUndefined();
    expect(upsertMenuProperty('<AxClass><Name>X</Name></AxClass>', 'Parameters', 'x')).toBeUndefined();
    expect(upsertMenuProperty(ITEM('AxMenuItemDisplayExtension'), 'Parameters', 'x')).toBeUndefined();
    // A name outside the list that the file carries stays with the generic replacement.
    expect(upsertMenuProperty(ITEM('AxMenuItemDisplay', '\t<Tags>Claims</Tags>\n'), 'Tags', 'x')).toBeUndefined();
  });

  it('adds the metamodel properties of a menu item, and not the ones it does not have', () => {
    // ExtendedDataSecurity is carried by standard menu items; DisabledImage is a
    // metamodel property of AxMenuItem (both used to be refused).
    for (const p of ['NormalResource', 'DisabledResource', 'FeatureClass', 'IsObsolete', 'CountryConfigurationKey', 'Visibility', 'StateMachine', 'ExtendedDataSecurity', 'DisabledImage']) {
      expect(ok(upsertMenuProperty(ITEM('AxMenuItemDisplay'), p.toLowerCase(), 'x')).xml).toContain(`\t<${p}>x</${p}>\n`);
    }
    for (const p of ['SetCompany', 'ShortCut', 'MenuItemName']) {
      expect(upsertMenuProperty(ITEM('AxMenuItemDisplay'), p, 'x')).toMatchObject({ ok: false });
    }
    const xml = ok(upsertMenuProperty(ITEM('AxMenuItemAction', '\t<StateMachineDataSource>Claim</StateMachineDataSource>\n'), 'StateMachine', 'ContosoClaimState')).xml;
    expect(xml).toContain('\t<ObjectType>Class</ObjectType>\n\t<StateMachine>ContosoClaimState</StateMachine>\n\t<StateMachineDataSource>');
  });

  it('does not list the two properties bpAccessPropertyModify owns', () => {
    expect(menuPropertiesOf('AxMenuItemAction')).not.toContain('OperationalDomain');
    expect(menuPropertiesOf('AxMenuItemAction')).not.toContain('SubscriberAccessLevel');
  });

  it('finds the root past leading comments, including dashes inside them', () => {
    const xml = ITEM('AxMenuItemDisplay').replace('\n<AxMenuItemDisplay', '\n<!-- a -- b --->\n<!--c-->\n<AxMenuItemDisplay');
    expect(ok(upsertMenuProperty(xml, 'Parameters', 'Posted')).xml).toContain('\t<Parameters>Posted</Parameters>\n');
  });

  it('does not backtrack exponentially on a run of empty comments (CodeQL js/redos)', () => {
    // The old `(?:\s*<!--[\s\S]*?-->)*` took ~48 s on 28 repetitions of this input.
    const start = Date.now();
    expect(upsertMenuProperty('<!--' + '--><!--'.repeat(5000), 'Parameters', 'x')).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('upsertMenuProperty on a menu', () => {
  it('inserts an absent property alphabetically, ahead of Elements', () => {
    let xml = ok(upsertMenuProperty(MENU(), 'FeatureClass', 'ContosoClaimsFeature')).xml;
    expect(topLevel(xml)).toEqual(['Name', 'FeatureClass', 'Label', 'SetCompany', 'Elements']);
    xml = ok(upsertMenuProperty(xml, 'CountryRegionCodes', 'MX')).xml;
    expect(topLevel(xml)).toEqual(['Name', 'CountryRegionCodes', 'FeatureClass', 'Label', 'SetCompany', 'Elements']);
    expect(xml).toContain('\t<SetCompany>Yes</SetCompany>\n\t<Elements>');
  });

  it('knows the metamodel properties of a menu, including the ones standard menus carry beyond the first five', () => {
    expect([...menuPropertiesOf('AxMenu')]).toEqual([
      'ConfigurationKey', 'CountryRegionCodes', 'DisabledImage', 'DisabledImageLocation', 'FeatureClass',
      'ImageLocation', 'IsObsolete', 'Label', 'MenuItemName', 'MenuItemType', 'NormalImage', 'Parameters',
      'SetCompany', 'ShortCut', 'Visibility',
    ]);
    // Standard menus carry these three at the top level (DMF, FinTagRuleCopy, …); they used to be refused.
    let xml = ok(upsertMenuProperty(MENU(), 'NormalImage', 'Copy')).xml;
    xml = ok(upsertMenuProperty(xml, 'IsObsolete', 'Yes')).xml;
    expect(topLevel(xml)).toEqual(['Name', 'IsObsolete', 'Label', 'NormalImage', 'SetCompany', 'Elements']);
    for (const p of ['HelpText', 'EnumParameter']) {
      expect(upsertMenuProperty(MENU(), p, 'x')).toMatchObject({ ok: false });
    }
  });

  it('adds SetCompany to a menu that only has a label', () => {
    const r = ok(upsertMenuProperty(MENU('\t<Label>@ContosoExt:Main</Label>\n'), 'setcompany', 'Yes'));
    expect(r.xml).toBe(MENU());
    expect(r.root).toBe('AxMenu');
  });

  it('adds the menu label without touching a submenu label', () => {
    const r = ok(upsertMenuProperty(MENU(''), 'Label', '@ContosoExt:Main'));
    expect(r.xml).toContain('\t<Name>ContosoMain</Name>\n\t<Label>@ContosoExt:Main</Label>\n\t<Elements>');
    expect(r.xml).toContain('\t\t\t<Label>@ContosoExt:Setup</Label>');
  });

  it('replaces the menu label, not the submenu one', () => {
    const r = ok(upsertMenuProperty(MENU(), 'Label', '@ContosoExt:Other'));
    expect(r.xml).toContain('\t<Label>@ContosoExt:Other</Label>\n\t<SetCompany>');
    expect(r.xml).toContain('\t\t\t<Label>@ContosoExt:Setup</Label>');
  });

  it('works on a menu without elements', () => {
    const empty = MENU().replace(/\t<Elements>[\s\S]*\t<\/Elements>\n/, '\t<Elements />\n');
    const r = ok(upsertMenuProperty(empty, 'ConfigurationKey', 'ContosoClaims'));
    expect(topLevel(r.xml)).toEqual(['Name', 'ConfigurationKey', 'Label', 'SetCompany', 'Elements']);
  });

  it('refuses a name that is not a menu property, with the known ones', () => {
    const r = upsertMenuProperty(MENU(), 'EnumParameter', 'Yes');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('SetCompany');
  });

  it('sets the menu\'s own MenuItemName, never the one of a menu item element below it', () => {
    // The generic replacement used to rewrite the first <MenuItemName> in the file,
    // which is the nested element's.
    const r = ok(upsertMenuProperty(MENU(), 'MenuItemName', 'ContosoOther'));
    expect(topLevel(r.xml)).toEqual(['Name', 'Label', 'MenuItemName', 'SetCompany', 'Elements']);
    expect(r.xml).toContain('\t\t\t\t\t<MenuItemName>ContosoParameters</MenuItemName>');
  });

  it('leaves a name the metamodel does not have, but the file carries below the top level, to the generic replacement', () => {
    expect(upsertMenuProperty(MENU(), 'Name', 'ContosoOther')).toBeUndefined();
  });
});

// ── Through the modify tool ─────────────────────────────────────────────────

const { files, mockBridgeSetProperty } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  // What the bridge answers for a property it has no case for.
  mockBridgeSetProperty: vi.fn(async () => ({ success: false, message: 'Bridge setProperty returned success=false' })),
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

describe('d365fo_file modify-property behind a bridge that has no case for the property', () => {
  beforeEach(() => { files.clear(); mockBridgeSetProperty.mockClear(); });

  for (const [objectType, root] of [
    ['menu-item-display', 'AxMenuItemDisplay'],
    ['menu-item-action', 'AxMenuItemAction'],
    ['menu-item-output', 'AxMenuItemOutput'],
  ] as const) {
    it(`adds Parameters and EnumTypeParameter to a ${objectType}`, async () => {
      const filePath = `${PKG}\\${root}\\ContosoClaimMatch.xml`;
      files.set(filePath, ITEM(root));
      for (const [propertyPath, propertyValue] of [['Parameters', 'Posted'], ['EnumTypeParameter', 'NoYes']]) {
        const r = await modifyD365FileTool(
          req({ objectType, objectName: 'ContosoClaimMatch', operation: 'modify-property', propertyPath, propertyValue, filePath }),
          buildContext(),
        );
        expect((r as any).isError, textOf(r)).toBeFalsy();
        expect(textOf(r)).toContain(`${root} property ${propertyPath}='${propertyValue}' via direct XML`);
      }
      expect(mockBridgeSetProperty).toHaveBeenCalledTimes(2);
      expect(files.get(filePath)).toMatch(
        /<Name>ContosoClaimMatch<\/Name>\r?\n\t<EnumTypeParameter>NoYes<\/EnumTypeParameter>\r?\n\t<Label>[^\n]*\n\t<Object>[^\n]*\n\t<ObjectType>Class<\/ObjectType>\r?\n\t<Parameters>Posted<\/Parameters>\r?\n<\/AxMenuItem/,
      );
    });
  }

  it('adds a property to a menu, ahead of Elements', async () => {
    const filePath = `${PKG}\\AxMenu\\ContosoMain.xml`;
    files.set(filePath, MENU('\t<Label>@ContosoExt:Main</Label>\n'));
    const r = await modifyD365FileTool(
      req({ objectType: 'menu', objectName: 'ContosoMain', operation: 'modify-property', propertyPath: 'SetCompany', propertyValue: 'Yes', filePath }),
      buildContext(),
    );
    expect((r as any).isError, textOf(r)).toBeFalsy();
    expect(files.get(filePath)).toMatch(/<Label>@ContosoExt:Main<\/Label>\r?\n\t<SetCompany>Yes<\/SetCompany>\r?\n\t<Elements>/);
  });

  it('keeps the byte order mark', async () => {
    const filePath = `${PKG}\\AxMenuItemDisplay\\ContosoClaimMatch.xml`;
    files.set(filePath, '\uFEFF' + ITEM('AxMenuItemDisplay'));
    const r = await modifyD365FileTool(
      req({ objectType: 'menu-item-display', objectName: 'ContosoClaimMatch', operation: 'modify-property', propertyPath: 'Parameters', propertyValue: 'Posted', filePath }),
      buildContext(),
    );
    expect((r as any).isError, textOf(r)).toBeFalsy();
    const written = files.get(filePath)!;
    expect(written.charCodeAt(0)).toBe(0xfeff);
    expect(written.slice(1)).toMatch(/^<\?xml/);
    expect(written).toContain('<Parameters>Posted</Parameters>');
  });

  it('fails without writing on a property the object does not have', async () => {
    const filePath = `${PKG}\\AxMenuItemAction\\ContosoClaimMatch.xml`;
    const before = ITEM('AxMenuItemAction');
    files.set(filePath, before);
    const r = await modifyD365FileTool(
      req({ objectType: 'menu-item-action', objectName: 'ContosoClaimMatch', operation: 'modify-property', propertyPath: 'Paramters', propertyValue: 'Posted', filePath }),
      buildContext(),
    );
    expect((r as any).isError).toBe(true);
    expect(textOf(r)).toMatch(/'Paramters' is not an AxMenuItemAction property/);
    expect(textOf(r)).toContain('Parameters');
    expect(files.get(filePath)).toBe(before);
  });
});
