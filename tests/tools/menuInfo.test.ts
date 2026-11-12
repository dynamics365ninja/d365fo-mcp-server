/**
 * get_object_info for `menu` and `menu-extension` (readers/menuInfo.ts).
 *
 * get_object_info had neither type, so on a dev VM an agent placing an item
 * grepped PackagesLocalDirectory for the menu XML to find a submenu. The fixtures
 * are shipped files with the objects renamed to Contoso: an excerpt of the AxMenu
 * OrganizationAdministration, and an extension of it shaped like
 * OrganizationAdministration.ApplicationSuite_Extension (a submenu under a nested
 * base submenu, items positioned after a sibling, a customization).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';

const files: {
  menu: string | null;
  extensions: Array<{ name: string; xml: string }>;
  indexed: Array<{ name: string; model: string }>;
} = { menu: null, extensions: [], indexed: [] };
vi.mock('../../src/utils/menuFiles.js', () => ({
  indexedMenuExtensions: vi.fn(() => files.indexed),
  readMenuXml: vi.fn(async () => files.menu),
  readMenuExtensions: vi.fn(async (base: string, _idx: unknown, exclude?: string) =>
    files.extensions.filter(e => e.name.toLowerCase().startsWith(`${base.toLowerCase()}.`) && e.name !== exclude)),
}));
const mode = { value: 'full' as string };
vi.mock('../../src/server/serverMode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/serverMode.js')>()),
  get SERVER_MODE() { return mode.value; },
}));
vi.mock('../../src/utils/objectFileLookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/objectFileLookup.js')>()),
  findD365FileOnDisk: vi.fn(async () => null),
  findAotFilesInAllPackages: vi.fn(async () => []),
}));

import { menuExtensionInfoTool, menuInfoTool } from '../../src/tools/readers/menuInfo';
import { getObjectInfoTool } from '../../src/tools/readers/getObjectInfo';
import { readObjectXml } from '../../src/tools/readers/objectXml';
import { findAotFilesInAllPackages } from '../../src/utils/objectFileLookup.js';

const BASE_MENU = `<?xml version="1.0" encoding="utf-8"?>
<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>ContosoMain</Name>
	<Label>@Contoso:Main</Label>
	<Elements>
		<AxMenuElement xmlns=""
			i:type="AxMenuElementSubMenu">
			<Name>Workspaces</Name>
			<Label>@Contoso:Workspaces</Label>
			<Elements>
				<AxMenuElement xmlns=""
					i:type="AxMenuElementTile">
					<Name>ContosoWorkspace</Name>
					<Tile>ContosoWorkspace</Tile>
				</AxMenuElement>
			</Elements>
		</AxMenuElement>
		<AxMenuElement xmlns=""
			i:type="AxMenuElementMenuItem">
			<Name>ContosoSystemDate</Name>
			<MenuItemName>ContosoSystemDate</MenuItemName>
		</AxMenuElement>
		<AxMenuElement xmlns=""
			i:type="AxMenuElementSubMenu">
			<Name>Setup</Name>
			<Label>@Contoso:Setup</Label>
			<Elements>
				<AxMenuElement xmlns=""
					i:type="AxMenuElementMenuItem">
					<Name>ContosoParamsEntry</Name>
					<MenuItemName>ContosoParameters</MenuItemName>
					<MenuItemType>Action</MenuItemType>
				</AxMenuElement>
				<AxMenuElement xmlns=""
					i:type="AxMenuElementSubMenu">
					<Name>EInvoice</Name>
					<Label>@Contoso:EInvoice</Label>
					<Elements>
						<AxMenuElement xmlns=""
							i:type="AxMenuElementMenuItem">
							<Name>ContosoEInvoiceParameters</Name>
							<MenuItemName>ContosoEInvoiceParameters</MenuItemName>
						</AxMenuElement>
					</Elements>
				</AxMenuElement>
			</Elements>
		</AxMenuElement>
	</Elements>
</AxMenu>`;

const EXTENSION = `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>ContosoMain.ContosoSuite</Name>
	<Customizations>
		<AxMenuCustomizationElement xmlns="">
			<Name>ContosoSystemDate</Name>
			<Visible>No</Visible>
		</AxMenuCustomizationElement>
	</Customizations>
	<Elements>
		<AxMenuExtensionElement xmlns="">
			<Parent>EInvoice</Parent>
			<MenuElement xmlns=""
				i:type="AxMenuElementSubMenu">
				<Name>ContosoTransport</Name>
				<Label>@Contoso:Transport</Label>
				<Elements>
					<AxMenuElement xmlns=""
						i:type="AxMenuElementMenuItem">
						<Name>ContosoTrailerType</Name>
						<MenuItemName>ContosoTrailerType</MenuItemName>
					</AxMenuElement>
				</Elements>
			</MenuElement>
		</AxMenuExtensionElement>
		<AxMenuExtensionElement xmlns="">
			<Parent>EInvoice</Parent>
			<PositionType>AfterItem</PositionType>
			<PreviousSibling>ContosoEInvoiceParameters</PreviousSibling>
			<MenuElement xmlns=""
				i:type="AxMenuElementMenuItem">
				<Name>ContosoTimeEngine</Name>
				<MenuItemName>ContosoTimeEngine</MenuItemName>
			</MenuElement>
		</AxMenuExtensionElement>
		<AxMenuExtensionElement xmlns="">
			<PositionType>Begin</PositionType>
			<MenuElement xmlns=""
				i:type="AxMenuElementMenuReference">
				<Name>ContosoTax</Name>
				<MenuName>ContosoTax</MenuName>
			</MenuElement>
		</AxMenuExtensionElement>
	</Elements>
	<MenuElementModifications />
	<PropertyModifications />
</AxMenuExtension>`;

const OTHER_EXTENSION = `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>ContosoMain.ContosoNumbers</Name>
	<Customizations />
	<Elements>
		<AxMenuExtensionElement xmlns="">
			<Parent>Setup</Parent>
			<MenuElement xmlns=""
				i:type="AxMenuElementMenuItem">
				<Name>ContosoNumberSeq</Name>
				<MenuItemName>ContosoNumberSeq</MenuItemName>
			</MenuElement>
		</AxMenuExtensionElement>
	</Elements>
</AxMenuExtension>`;

const req = (args: Record<string, unknown>) => ({ method: 'tools/call', params: { name: 'x', arguments: args } }) as any;
const text = (r: any): string => r.content[0].text;

beforeEach(() => {
  mode.value = 'full';
  files.indexed = [];
  files.menu = BASE_MENU;
  files.extensions = [
    { name: 'ContosoMain.ContosoSuite', xml: EXTENSION },
    { name: 'ContosoMain.ContosoNumbers', xml: OTHER_EXTENSION },
  ];
});

describe('menu reader', () => {
  it('renders the tree with depth, labels, item targets and kinds, and counts', async () => {
    const t = text(await menuInfoTool(req({ name: 'ContosoMain' }), {} as any));
    expect(t).toContain('# AxMenu: `ContosoMain`');
    expect(t).toContain('**Label:** @Contoso:Main');
    expect(t).toContain('**Submenus:** 3 · **Items:** 4');
    expect(t).toContain(
      '- 📁 **Setup** — @Contoso:Setup\n' +
      '  - ContosoParamsEntry → ContosoParameters (Action)\n' +
      '  - 📁 **EInvoice** — @Contoso:EInvoice\n' +
      '    - ContosoEInvoiceParameters\n',
    );
    expect(t).toContain('  - tile ContosoWorkspace');
  });

  it('submenusOnly gives the submenu tree with an item count each', async () => {
    const t = text(await menuInfoTool(req({ name: 'ContosoMain', submenusOnly: true }), {} as any));
    expect(t).toContain('## Submenus');
    expect(t).toContain('- 📁 **Workspaces** — @Contoso:Workspaces (1 item)\n- 📁 **Setup** — @Contoso:Setup (1 item)\n  - 📁 **EInvoice** — @Contoso:EInvoice (1 item)');
    expect(t).not.toContain('ContosoSystemDate');
  });

  it('summarises the extensions: items, and the submenus they add with their parent', async () => {
    const t = text(await menuInfoTool(req({ name: 'ContosoMain' }), {} as any));
    expect(t).toContain('## Extensions (2)');
    expect(t).toContain('- `ContosoMain.ContosoSuite`: 3 items; adds submenu ContosoTransport (under EInvoice)');
    expect(t).toContain('- `ContosoMain.ContosoNumbers`: 1 item');
    expect(t).toContain('parentMenuElement');
  });

  it('says where it looked when the menu is not found', async () => {
    files.menu = null;
    const r = await menuInfoTool(req({ name: 'ContosoNope' }), {} as any);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not in the index, the configured model or any package folder');
  });
});

describe('menu-extension reader', () => {
  it('a full name shows that extension: parent, position, nested items, customizations', async () => {
    const t = text(await menuExtensionInfoTool(req({ name: 'contosomain.contososuite' }), {} as any));
    expect(t).toContain('# AxMenuExtension: `ContosoMain.ContosoSuite` (extends `ContosoMain`)');
    expect(t).toContain('**Submenus added:** 1 · **Items added:** 3');
    expect(t).toContain(
      '- under **EInvoice**:\n' +
      '  - 📁 **ContosoTransport** — @Contoso:Transport\n' +
      '    - ContosoTrailerType\n' +
      '- under **EInvoice**, after ContosoEInvoiceParameters:\n' +
      '  - ContosoTimeEngine\n' +
      '- top level, first:\n' +
      '  - ↪ menu ContosoTax\n',
    );
    expect(t).toContain('- changes to base elements: ContosoSystemDate (Visible=No)');
    expect(t).not.toContain('ContosoNumbers');
  });

  it('a base name lists every extension of the menu', async () => {
    const t = text(await menuExtensionInfoTool(req({ name: 'ContosoMain' }), {} as any));
    expect(t).toContain('# Extensions of menu `ContosoMain` (2)');
    expect(t).toContain('## AxMenuExtension: `ContosoMain.ContosoSuite`');
    expect(t).toContain('## AxMenuExtension: `ContosoMain.ContosoNumbers`');
  });

  it('not found, for one extension and for a menu without any', async () => {
    expect(text(await menuExtensionInfoTool(req({ name: 'ContosoMain.Nope' }), {} as any))).toContain('Menu extension "ContosoMain.Nope" not found');
    expect(text(await menuExtensionInfoTool(req({ name: 'ContosoOther' }), {} as any))).toContain('No extension of menu "ContosoOther" found');
  });
});

describe('extensions the index knows but whose file was not read', () => {
  beforeEach(() => {
    files.indexed = [
      { name: 'contosomain.contososuite', model: 'ContosoSuite' }, // read, in another casing
      { name: 'ContosoMain.ContosoNumbers', model: 'ContosoCore' },
      { name: 'ContosoMain.ApplicationSuite_Extension', model: 'ApplicationSuite' },
    ];
  });

  it('a base name: counted in the heading and listed above the extensions, with the companion on a read-only server', async () => {
    mode.value = 'read-only';
    const t = text(await menuExtensionInfoTool(req({ name: 'ContosoMain' }), {} as any));
    expect(t).toContain(
      '# Extensions of menu `ContosoMain` (2 of 3 read)\n\n' +
      '**Not read (1):** known to the index, but this server has no copy of their files:\n' +
      '- ContosoMain.ApplicationSuite_Extension (model ApplicationSuite)\n' +
      'Read them with get_object_info(objectType="menu-extension", name="<extension>") on the local companion (d365fo-local).\n\n' +
      '## AxMenuExtension: `ContosoMain.ContosoSuite`',
    );
  });

  it('the menu reader counts and lists them too; a server with files names no companion', async () => {
    const t = text(await menuInfoTool(req({ name: 'ContosoMain' }), {} as any));
    expect(t).toContain('## Extensions (2 of 3 read)\n\n**Not read (1):**');
    expect(t).toContain('- ContosoMain.ApplicationSuite_Extension (model ApplicationSuite)\n\n- `ContosoMain.ContosoSuite`');
    expect(t).not.toContain('d365fo-local');
  });

  it('nothing to say when every indexed extension was read, or for one extension by name', async () => {
    files.indexed = files.indexed.slice(0, 2);
    expect(text(await menuExtensionInfoTool(req({ name: 'ContosoMain' }), {} as any))).toContain('# Extensions of menu `ContosoMain` (2)\n\n## AxMenuExtension');
    files.indexed.push({ name: 'ContosoMain.ApplicationSuite_Extension', model: 'ApplicationSuite' });
    expect(text(await menuExtensionInfoTool(req({ name: 'ContosoMain.ContosoSuite' }), {} as any))).not.toContain('Not read');
  });
});

describe('on a read-only server (no copy of the files, no menus in the index)', () => {
  it('says why it cannot read the menu and points to the companion, without "not found" guidance', async () => {
    mode.value = 'read-only';
    files.menu = null;
    files.extensions = [];
    // Through get_object_info: a "not found" text would get the search/update_symbol_index block appended.
    const r = await getObjectInfoTool(req({ objectType: 'menu', name: 'OrganizationAdministration' }), {} as any);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('cannot be read on this server: it has no copy of the file');
    expect(text(r)).toContain('d365fo-local');
    expect(text(r)).not.toContain('update_symbol_index');
    for (const name of ['OrganizationAdministration.ContosoExt', 'OrganizationAdministration']) {
      const e = await getObjectInfoTool(req({ objectType: 'menu-extension', name }), {} as any);
      expect(text(e)).toContain('cannot be read on this server');
      expect(text(e)).not.toContain('update_symbol_index');
    }
  });

  it('lists the extensions the index knows, names and models, since it has no files', async () => {
    mode.value = 'read-only';
    files.menu = null;
    files.extensions = [];
    files.indexed = [
      { name: 'OrganizationAdministration.ContosoSuite', model: 'ContosoSuite' },
      { name: 'OrganizationAdministration.ContosoNumbers', model: 'ContosoCore' },
    ];
    const list =
      'The index knows these extensions of menu "OrganizationAdministration" (names only, not their entries):\n' +
      '- OrganizationAdministration.ContosoSuite (model ContosoSuite)\n' +
      '- OrganizationAdministration.ContosoNumbers (model ContosoCore)';
    const viaExt = await getObjectInfoTool(req({ objectType: 'menu-extension', name: 'OrganizationAdministration' }), {} as any);
    expect(text(viaExt)).toContain('❌ The entries of the extensions of menu "OrganizationAdministration" cannot be read on this server');
    expect(text(viaExt)).toContain(list);
    const viaMenu = await getObjectInfoTool(req({ objectType: 'menu', name: 'OrganizationAdministration' }), {} as any);
    expect(text(viaMenu)).toContain(list);
    expect(text(viaMenu)).not.toContain('update_symbol_index');
  });

  it('a server with files does not list index names on a miss', async () => {
    files.menu = null;
    files.indexed = [{ name: 'ContosoNope.X', model: 'M' }];
    expect(text(await menuInfoTool(req({ name: 'ContosoNope' }), {} as any))).not.toContain('The index knows');
  });

  it('a server with files still says not found, with the guidance', async () => {
    files.menu = null;
    const r = await getObjectInfoTool(req({ objectType: 'menu', name: 'ContosoNope' }), {} as any);
    expect(text(r)).toContain('not found — not in the index, the configured model or any package folder');
  });
});

describe('through get_object_info', () => {
  it('accepts objectType menu and menu-extension, options passed through', async () => {
    const m = await getObjectInfoTool(req({ objectType: 'menu', name: 'ContosoMain', options: { submenusOnly: true } }), {} as any);
    expect(m.isError).toBeFalsy();
    expect(text(m)).toContain('## Submenus');
    const e = await getObjectInfoTool(req({ objectType: 'menu-extension', name: 'ContosoMain.ContosoNumbers' }), {} as any);
    expect(text(e)).toContain('under **Setup**');
  });

  it('include:"xml" finds a menu in the package folders when neither the model nor the index has it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'menu-xml-'));
    try {
      const f = path.join(dir, 'ContosoMain.xml');
      await fs.writeFile(f, BASE_MENU, 'utf-8');
      vi.mocked(findAotFilesInAllPackages).mockImplementation(async (folder: string, match: (n: string) => boolean) =>
        folder === 'AxMenu' && match('ContosoMain.xml') ? [f] : []);
      const r = await readObjectXml('menu', 'contosomain', {});
      expect(r.isError).toBe(false);
      expect(r.text).toContain(`**File:** ${f}`);
      expect(r.text).toContain('<Name>ContosoMain</Name>');
    } finally {
      vi.mocked(findAotFilesInAllPackages).mockReset();
      vi.mocked(findAotFilesInAllPackages).mockResolvedValue([]);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
