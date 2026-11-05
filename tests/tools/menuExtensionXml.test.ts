/**
 * add-menu-item-to-menu on a menu-extension: the AxMenuExtension writer.
 *
 * The fixtures are shipped AxMenuExtension files from Microsoft models with the
 * objects renamed to Contoso — the shape, indentation and `xmlns=""` resets are
 * theirs:
 *   EXISTING_EXT  ← ApplicationWorkspaces RetailMain.Workspaces (Customizations,
 *                   Parent + PositionType, a Tile and an Action item)
 *   SHORT_ROOT    ← ApplicationSuite MainMenu.Tax (root without the two
 *                   modification collections, a top-level entry)
 *   SUBMENU_EXT   ← two entries, AccountsPayable.Extension (a submenu the
 *                   extension adds, its item nested in it) and
 *                   navpanemenu.ReqDefinePlanningPolicies (an added submenu
 *                   with an empty <Elements />)
 *   BASE_MENU     ← an excerpt of the AxMenu OrganizationAdministration
 *                   (inline submenus, SATclassifications at depth 3)
 * EMPTY_EXT is what create writes (generateAxMenuExtensionXml).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';

vi.mock('../../src/utils/baseObjectXml.js', () => ({
  findBaseObjectXml: vi.fn(async () => null),
  findBaseFormXml: vi.fn(async () => null),
}));

import { findBaseObjectXml } from '../../src/utils/baseObjectXml.js';
import { addMenuExtensionItem, addMenuExtensionSubmenu, menuSubmenuNames, submenuLocations } from '../../src/tools/xml/menuExtensionXml';
import { directXmlAddMenuItemToMenu, directXmlAddMenuItemToMenuExtension, directXmlAddSubmenu } from '../../src/tools/write/directXmlWriters';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator';

const EMPTY_EXT = XmlTemplateGenerator.generateAxMenuExtensionXml('ContosoMain.ContosoExtension');

const EXISTING_EXT = `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>ContosoMain.ContosoExtension</Name>
	<Customizations>
		<AxMenuCustomizationElement xmlns="">
			<Name>ContosoTemplateListPage</Name>
			<Visible>No</Visible>
		</AxMenuCustomizationElement>
	</Customizations>
	<Elements>
		<AxMenuExtensionElement xmlns="">
			<Parent>Channels</Parent>
			<PositionType>Begin</PositionType>
			<MenuElement xmlns=""
				i:type="AxMenuElementTile">
				<Name>ContosoChannelWorkspace</Name>
				<Tile>ContosoChannelWorkspace</Tile>
			</MenuElement>
		</AxMenuExtensionElement>
		<AxMenuExtensionElement xmlns="">
			<Parent>TaskManagement</Parent>
			<MenuElement xmlns=""
				i:type="AxMenuElementMenuItem">
				<Name>ContosoTaskCleaner</Name>
				<MenuItemName>ContosoTaskCleaner</MenuItemName>
				<MenuItemType>Action</MenuItemType>
			</MenuElement>
		</AxMenuExtensionElement>
	</Elements>
	<MenuElementModifications />
	<PropertyModifications />
</AxMenuExtension>`;

const SHORT_ROOT = `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>MainMenu.ContosoTax</Name>
	<Customizations />
	<Elements>
		<AxMenuExtensionElement xmlns="">
			<MenuElement xmlns=""
				i:type="AxMenuElementMenuReference">
				<Name>ContosoTax</Name>
				<MenuName>ContosoTax</MenuName>
			</MenuElement>
		</AxMenuExtensionElement>
	</Elements>
</AxMenuExtension>`;

const SUBMENU_EXT = `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>ContosoMain.ContosoSubmenus</Name>
	<Customizations />
	<Elements>
		<AxMenuExtensionElement xmlns="">
			<PositionType>AfterItem</PositionType>
			<PreviousSibling>Payments</PreviousSibling>
			<MenuElement xmlns=""
				i:type="AxMenuElementSubMenu">
				<Name>ContosoIntentLetters</Name>
				<FeatureClass>ContosoFeature</FeatureClass>
				<Label>@Contoso:IntentLetters</Label>
				<Elements>
					<AxMenuElement xmlns=""
						i:type="AxMenuElementMenuItem">
						<Name>ContosoVendIntentLetter</Name>
						<MenuItemName>ContosoIntentLetter</MenuItemName>
					</AxMenuElement>
				</Elements>
			</MenuElement>
		</AxMenuExtensionElement>
		<AxMenuExtensionElement xmlns="">
			<MenuElement xmlns=""
				i:type="AxMenuElementSubMenu">
				<Name>ContosoPlanningPolicies</Name>
				<Elements />
			</MenuElement>
		</AxMenuExtensionElement>
	</Elements>
	<MenuElementModifications />
	<PropertyModifications />
</AxMenuExtension>`;

const BASE_MENU = `<?xml version="1.0" encoding="utf-8"?>
<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>ContosoMain</Name>
	<Label>@Contoso:Main</Label>
	<SetCompany>Yes</SetCompany>
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
			<ShowParentModule>No</ShowParentModule>
		</AxMenuElement>
		<AxMenuElement xmlns=""
			i:type="AxMenuElementSubMenu">
			<Name>Setup</Name>
			<Label>@Contoso:Setup</Label>
			<Elements>
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
						<AxMenuElement xmlns=""
							i:type="AxMenuElementSubMenu">
							<Name>SATclassifications</Name>
							<CountryRegionCodes>MX</CountryRegionCodes>
							<Label>@Contoso:SATclassifications</Label>
							<Elements>
								<AxMenuElement xmlns=""
									i:type="AxMenuElementMenuItem">
									<Name>ContosoTaxRegime</Name>
									<MenuItemName>ContosoTaxRegime</MenuItemName>
								</AxMenuElement>
							</Elements>
						</AxMenuElement>
					</Elements>
				</AxMenuElement>
			</Elements>
		</AxMenuElement>
	</Elements>
</AxMenu>`;

function added(xml: string, spec: Parameters<typeof addMenuExtensionItem>[1]): string {
  const r = addMenuExtensionItem(xml, spec);
  if (r.kind !== 'added') throw new Error(`expected added, got ${r.kind}`);
  return r.xml;
}

describe('addMenuExtensionItem', () => {
  it('fills an empty <Elements /> with the shipped entry shape (Display carries no MenuItemType)', () => {
    const xml = added(EMPTY_EXT, { menuItemName: 'ContosoRentForm', parent: 'Inquiries' });
    expect(xml).toContain(
      '\t<Customizations />\n' +
      '\t<Elements>\n' +
      '\t\t<AxMenuExtensionElement xmlns="">\n' +
      '\t\t\t<Parent>Inquiries</Parent>\n' +
      '\t\t\t<MenuElement xmlns=""\n' +
      '\t\t\t\ti:type="AxMenuElementMenuItem">\n' +
      '\t\t\t\t<Name>ContosoRentForm</Name>\n' +
      '\t\t\t\t<MenuItemName>ContosoRentForm</MenuItemName>\n' +
      '\t\t\t</MenuElement>\n' +
      '\t\t</AxMenuExtensionElement>\n' +
      '\t</Elements>\n' +
      '\t<MenuElementModifications />\n',
    );
    expect(xml).not.toContain('MenuItemType');
  });

  it('writes no <Parent> for the top level', () => {
    const xml = added(EMPTY_EXT, { menuItemName: 'ContosoRentForm' });
    expect(xml).not.toContain('<Parent>');
    expect(xml).toContain('\t\t<AxMenuExtensionElement xmlns="">\n\t\t\t<MenuElement xmlns=""\n');
  });

  it.each([['action', 'Action'], ['output', 'Output'], ['OUTPUT', 'Output']])(
    'writes MenuItemType for %s',
    (type, value) => {
      const xml = added(EMPTY_EXT, { menuItemName: 'ContosoRentJob', menuItemType: type });
      expect(xml).toContain(
        `\t\t\t\t<MenuItemName>ContosoRentJob</MenuItemName>\n\t\t\t\t<MenuItemType>${value}</MenuItemType>\n\t\t\t</MenuElement>`,
      );
    },
  );

  it('appends after the existing entries and leaves them byte-identical', () => {
    const xml = added(EXISTING_EXT, { menuItemName: 'ContosoRentForm', parent: 'Channels' });
    const lastOld = EXISTING_EXT.indexOf('\n\t</Elements>');
    expect(xml.slice(0, lastOld)).toBe(EXISTING_EXT.slice(0, lastOld));
    expect(xml.slice(xml.indexOf('\n\t</Elements>'))).toBe(EXISTING_EXT.slice(lastOld));
    expect(xml.slice(lastOld)).toMatch(/^\n\t\t<AxMenuExtensionElement xmlns="">\n\t\t\t<Parent>Channels<\/Parent>/);
  });

  it('works on a root without the two modification collections', () => {
    const xml = added(SHORT_ROOT, { menuItemName: 'ContosoTaxSetup' });
    expect(xml.endsWith('\t\t</AxMenuExtensionElement>\n\t</Elements>\n</AxMenuExtension>')).toBe(true);
  });

  it('puts a base-menu parent in the ROOT <Elements>, not into a submenu the extension adds', () => {
    const r = addMenuExtensionItem(SUBMENU_EXT, { menuItemName: 'ContosoRentForm', parent: 'Setup' });
    expect(r.kind === 'added' && r.nested).toBe(false);
    const xml = added(SUBMENU_EXT, { menuItemName: 'ContosoRentForm', parent: 'Setup' });
    expect(xml.indexOf('<MenuItemName>ContosoRentForm')).toBeGreaterThan(xml.lastIndexOf('\t\t\t\t</Elements>'));
    expect(xml).toMatch(/<\/AxMenuExtensionElement>\n\t\t<AxMenuExtensionElement xmlns="">\n\t\t\t<Parent>Setup/);
  });

  it('nests an item for a submenu the extension adds inside that submenu, in the shipped shape', () => {
    const r = addMenuExtensionItem(SUBMENU_EXT, { menuItemName: 'ContosoRentForm', parent: 'contosointentletters' });
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(r.nested).toBe(true);
    expect(r.xml).toContain(
      '\t\t\t\t\t\t<MenuItemName>ContosoIntentLetter</MenuItemName>\n' +
      '\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t\t<AxMenuElement xmlns=""\n' +
      '\t\t\t\t\t\ti:type="AxMenuElementMenuItem">\n' +
      '\t\t\t\t\t\t<Name>ContosoRentForm</Name>\n' +
      '\t\t\t\t\t\t<MenuItemName>ContosoRentForm</MenuItemName>\n' +
      '\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t</Elements>\n',
    );
    // Nested items carry no <Parent>, and no new root entry appears.
    expect(r.xml).not.toContain('<Parent>');
    expect(r.xml.match(/<AxMenuExtensionElement /g)).toHaveLength(2);
  });

  it('opens an empty <Elements /> of an added submenu', () => {
    const xml = added(SUBMENU_EXT, { menuItemName: 'ContosoPlanJob', menuItemType: 'action', parent: 'ContosoPlanningPolicies' });
    expect(xml).toContain(
      '\t\t\t\t<Name>ContosoPlanningPolicies</Name>\n' +
      '\t\t\t\t<Elements>\n' +
      '\t\t\t\t\t<AxMenuElement xmlns=""\n' +
      '\t\t\t\t\t\ti:type="AxMenuElementMenuItem">\n' +
      '\t\t\t\t\t\t<Name>ContosoPlanJob</Name>\n' +
      '\t\t\t\t\t\t<MenuItemName>ContosoPlanJob</MenuItemName>\n' +
      '\t\t\t\t\t\t<MenuItemType>Action</MenuItemType>\n' +
      '\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t</Elements>\n' +
      '\t\t\t</MenuElement>\n',
    );
  });

  it('skips an item already nested in the added submenu', () => {
    expect(addMenuExtensionItem(SUBMENU_EXT, { menuItemName: 'ContosoIntentLetter', parent: 'ContosoIntentLetters' }).kind)
      .toBe('already-present');
  });

  it('skips the same menu item under the same parent, case-insensitively', () => {
    expect(addMenuExtensionItem(EXISTING_EXT, { menuItemName: 'contosotaskcleaner', parent: 'TASKMANAGEMENT' }).kind)
      .toBe('already-present');
    // Same item, other parent (or the top level) is a different placement.
    expect(addMenuExtensionItem(EXISTING_EXT, { menuItemName: 'ContosoTaskCleaner', parent: 'Channels' }).kind)
      .toBe('added');
    expect(addMenuExtensionItem(EXISTING_EXT, { menuItemName: 'ContosoTaskCleaner' }).kind).toBe('added');
    // A tile of that name is not a menu item.
    expect(addMenuExtensionItem(EXISTING_EXT, { menuItemName: 'ContosoChannelWorkspace', parent: 'Channels' }).kind)
      .toBe('added');
  });

  it('escapes the values, and still recognises the escaped item afterwards', () => {
    const xml = added(EMPTY_EXT, { menuItemName: 'Contoso&Co', parent: 'A<B' });
    expect(xml).toContain('<MenuItemName>Contoso&amp;Co</MenuItemName>');
    expect(xml).toContain('<Parent>A&lt;B</Parent>');
    expect(addMenuExtensionItem(xml, { menuItemName: 'Contoso&Co', parent: 'A<B' }).kind).toBe('already-present');
  });

  it('declines a file that is not a menu extension, or has no <Elements>', () => {
    expect(addMenuExtensionItem(BASE_MENU, { menuItemName: 'X' }).kind).toBe('unsupported');
    expect(addMenuExtensionItem(EMPTY_EXT.replace('\t<Elements />\n', ''), { menuItemName: 'X' }).kind)
      .toBe('no-collection');
  });
});

describe('menuSubmenuNames', () => {
  it('finds submenus at any depth by their own <Name>, not a nested one', () => {
    expect(menuSubmenuNames(BASE_MENU)).toEqual(['Workspaces', 'Setup', 'EInvoice', 'SATclassifications']);
    expect(menuSubmenuNames(SUBMENU_EXT)).toEqual(['ContosoIntentLetters', 'ContosoPlanningPolicies']);
    expect(menuSubmenuNames(EXISTING_EXT)).toEqual([]);
  });
});

describe('directXmlAddMenuItemToMenuExtension', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
    vi.mocked(findBaseObjectXml).mockReset();
    vi.mocked(findBaseObjectXml).mockResolvedValue(null);
  });

  async function extFile(xml: string, name = 'ContosoMain.ContosoExtension'): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'menu-ext-'));
    const file = path.join(dir, `${name}.xml`);
    await fs.writeFile(file, xml.replace(/\n/g, '\r\n'), 'utf-8');
    return file;
  }

  it('writes CRLF without a trailing newline, and names where the item went', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const file = await extFile(EMPTY_EXT);
    // A submenu at depth 3 of the base menu, named by its plain name as shipped extensions do.
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'satclassifications' }, {});
    expect(r.success).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(r.message).toContain("under submenu 'SATclassifications' of menu 'ContosoMain'");
    expect(findBaseObjectXml).toHaveBeenCalledWith('menu', 'ContosoMain', {});
    const written = await fs.readFile(file, 'utf-8');
    // The base menu's spelling is written, not the caller's.
    expect(written).toContain('<Parent>SATclassifications</Parent>\r\n');
    expect(written).not.toMatch(/(^|[^\r])\n/);
    expect(written.endsWith('</AxMenuExtension>')).toBe(true);
  });

  it('refuses a parent found nowhere, and lists the submenus', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const file = await extFile(SUBMENU_EXT, 'ContosoMain.ContosoSubmenus');
    const before = await fs.readFile(file, 'utf-8');
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'Periodic' }, {});
    expect(r.success).toBe(false);
    expect(r.message).toContain("Submenu 'Periodic' is not in menu 'ContosoMain'");
    expect(r.message).toContain('Workspaces, Setup, EInvoice, SATclassifications, ContosoIntentLetters, ContosoPlanningPolicies');
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });

  it('nests the item in a submenu the extension adds itself, and says so', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const file = await extFile(SUBMENU_EXT, 'ContosoMain.ContosoSubmenus');
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'ContosoIntentLetters' }, {});
    expect(r.success).toBe(true);
    expect(r.message).toContain("inside submenu 'ContosoIntentLetters', which this extension adds,");
    expect(r.message).not.toContain('⚠️');
    expect(await fs.readFile(file, 'utf-8')).not.toContain('<Parent>');
  });

  it('accepts a submenu that another indexed extension of the base menu adds', async () => {
    // Shipped: GeneralLedger.AppSuite_TR_Extension parents items on PeriodEndReports,
    // a submenu GeneralLedger.ApplicationSuite adds.
    vi.mocked(findBaseObjectXml).mockImplementation(async (type: string, name: string) =>
      type === 'menu' ? BASE_MENU : name === 'ContosoMain.ContosoSubmenus' ? SUBMENU_EXT : null);
    const all = vi.fn(() => [
      { name: 'ContosoMain.ContosoSubmenus' }, { name: 'ContosoMain.ContosoExtension' }, { name: 'ContosoMainX.Other' },
    ]);
    const prepare = vi.fn(() => ({ all }));
    const symbolIndex = { getReadDb: () => ({ prepare }) };
    const file = await extFile(EMPTY_EXT);
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'ContosoPlanningPolicies' }, symbolIndex);
    expect(r.success).toBe(true);
    expect(r.message).toContain("under submenu 'ContosoPlanningPolicies'");
    expect(all).toHaveBeenCalledWith('ContosoMain.%');
    // Neither itself nor a merely LIKE-matching name is read.
    expect(findBaseObjectXml).toHaveBeenCalledWith('menu-extension', 'ContosoMain.ContosoSubmenus', symbolIndex);
    expect(findBaseObjectXml).not.toHaveBeenCalledWith('menu-extension', 'ContosoMain.ContosoExtension', symbolIndex);
    expect(findBaseObjectXml).not.toHaveBeenCalledWith('menu-extension', 'ContosoMainX.Other', symbolIndex);
    expect(await fs.readFile(file, 'utf-8')).toContain('<Parent>ContosoPlanningPolicies</Parent>');
  });

  it('reads the other extensions once, for both the parent and the element name', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const getReadDb = vi.fn();
    const file = await extFile(EMPTY_EXT);
    await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'Periodic' }, { getReadDb });
    expect(getReadDb).toHaveBeenCalledTimes(1);
  });

  // Element names are unique across a menu and its extensions: none of the 1,428
  // elements of the 249 shipped extensions reuses a name of its base menu.
  it('names an item the base menu or another extension already has <item>N', async () => {
    vi.mocked(findBaseObjectXml).mockImplementation(async (type: string, name: string) =>
      type === 'menu' ? BASE_MENU : name === 'ContosoMain.ContosoSubmenus' ? SUBMENU_EXT : null);
    const symbolIndex = { getReadDb: () => ({ prepare: () => ({ all: () => [{ name: 'ContosoMain.ContosoSubmenus' }] }) }) };
    const file = await extFile(EMPTY_EXT);
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoTaxRegime', parentMenuElement: 'Setup' }, symbolIndex);
    expect(r.success).toBe(true);
    expect(r.message).toContain("so this element is named 'ContosoTaxRegime1'; it still opens 'ContosoTaxRegime'");
    // A name another extension uses (its submenu), on the top level.
    const s = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoIntentLetters' }, symbolIndex);
    expect(s.message).toContain("named 'ContosoIntentLetters1'");
    const written = await fs.readFile(file, 'utf-8');
    expect(written).toContain('<Name>ContosoTaxRegime1</Name>\r\n\t\t\t\t<MenuItemName>ContosoTaxRegime</MenuItemName>');
    expect(written).toContain('<Name>ContosoIntentLetters1</Name>');
    // A name nobody has keeps the item's own name, without the note.
    const plain = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm' }, symbolIndex);
    expect(plain.message).not.toContain('ℹ️');
  });

  it('writes with a warning when the base menu cannot be read', async () => {
    const file = await extFile(EMPTY_EXT);
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'Inquiries' }, {});
    expect(r.success).toBe(true);
    expect(r.message).toContain("Base menu 'ContosoMain' could not be read, so submenu 'Inquiries' was NOT checked");
    expect(await fs.readFile(file, 'utf-8')).toContain('<Parent>Inquiries</Parent>');
  });

  it('reads the base menu for a top-level item too: its element names are taken', async () => {
    const file = await extFile(EMPTY_EXT);
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm' }, {});
    expect(r.message).toContain('on the top level');
    expect(findBaseObjectXml).toHaveBeenCalledWith('menu', 'ContosoMain', {});
  });

  it('reports a second identical call as a skip and leaves the file as it was', async () => {
    const file = await extFile(EXISTING_EXT);
    const before = await fs.readFile(file, 'utf-8');
    vi.mocked(findBaseObjectXml).mockResolvedValue(null);
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoTaskCleaner', parentMenuElement: 'TaskManagement' }, {});
    expect(r.success).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.message).toContain('skipped (idempotent)');
    expect(r.message).not.toContain('✅');
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });

  it('the AxMenu writer escapes the item name too', async () => {
    const file = await extFile(BASE_MENU.replace(/<Elements>[\s\S]*<\/Elements>/, '<Elements />'), 'ContosoMain');
    await directXmlAddMenuItemToMenu(file, 'Contoso&Co', 'display');
    expect(await fs.readFile(file, 'utf-8')).toContain('<MenuItemName>Contoso&amp;Co</MenuItemName>');
  });

  it('gives a specific refusal for a file without <Elements>', async () => {
    const file = await extFile(EMPTY_EXT.replace('\t<Elements />\n', ''));
    const r = await directXmlAddMenuItemToMenuExtension(file, { menuItemToAdd: 'ContosoRentForm' }, {});
    expect(r.success).toBe(false);
    expect(r.message).toContain('has no <Elements> collection');
  });
});

describe('addMenuExtensionSubmenu', () => {
  it('adds a root entry with <Parent> in the shipped shape (Name, Label, <Elements />)', () => {
    const r = addMenuExtensionSubmenu(EMPTY_EXT, { name: 'ContosoRentals', label: '@ContosoRental:Rentals', parent: 'Setup' });
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(r.nested).toBe(false);
    expect(r.xml).toContain(
      '\t<Elements>\n' +
      '\t\t<AxMenuExtensionElement xmlns="">\n' +
      '\t\t\t<Parent>Setup</Parent>\n' +
      '\t\t\t<MenuElement xmlns=""\n' +
      '\t\t\t\ti:type="AxMenuElementSubMenu">\n' +
      '\t\t\t\t<Name>ContosoRentals</Name>\n' +
      '\t\t\t\t<Label>@ContosoRental:Rentals</Label>\n' +
      '\t\t\t\t<Elements />\n' +
      '\t\t\t</MenuElement>\n' +
      '\t\t</AxMenuExtensionElement>\n' +
      '\t</Elements>\n',
    );
  });

  it('a top-level submenu has no <Parent>, and no <Label> when none is given', () => {
    const r = addMenuExtensionSubmenu(EMPTY_EXT, { name: 'ContosoRentals' });
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(r.xml).not.toContain('<Parent>');
    expect(r.xml).not.toContain('<Label>');
  });

  it('nests a submenu inside one the extension adds, split tag as shipped', () => {
    const r = addMenuExtensionSubmenu(SUBMENU_EXT, { name: 'ContosoLetterSetup', parent: 'ContosoIntentLetters' });
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(r.nested).toBe(true);
    expect(r.xml).toContain(
      '\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t\t<AxMenuElement xmlns=""\n' +
      '\t\t\t\t\t\ti:type="AxMenuElementSubMenu">\n' +
      '\t\t\t\t\t\t<Name>ContosoLetterSetup</Name>\n' +
      '\t\t\t\t\t\t<Elements />\n' +
      '\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t</Elements>\n',
    );
    expect(r.xml.match(/<AxMenuExtensionElement /g)).toHaveLength(2);
  });

  it('skips the same name under the same parent, refuses it under another', () => {
    expect(addMenuExtensionSubmenu(SUBMENU_EXT, { name: 'contosoplanningpolicies' }).kind).toBe('already-present');
    expect(addMenuExtensionSubmenu(SUBMENU_EXT, { name: 'ContosoPlanningPolicies', parent: 'Setup' }))
      .toEqual({ kind: 'exists', parent: '' });
  });

  it('refuses the element name of an item of this extension (not its MenuItemName)', () => {
    expect(addMenuExtensionSubmenu(SUBMENU_EXT, { name: 'ContosoVendIntentLetter', parent: 'Setup' })).toEqual({ kind: 'name-in-use' });
    expect(addMenuExtensionSubmenu(SUBMENU_EXT, { name: 'ContosoIntentLetter', parent: 'Setup' }).kind).toBe('added');
  });

  it('addMenuExtensionItem takes a free name when the item name is taken', () => {
    const r = addMenuExtensionItem(EMPTY_EXT, { menuItemName: 'ContosoRentForm', takenNames: ['ContosoRentForm', 'contosorentform1'] });
    if (r.kind !== 'added') throw new Error(r.kind);
    expect(r.elementName).toBe('ContosoRentForm2');
    expect(r.xml).toContain('<Name>ContosoRentForm2</Name>\n\t\t\t\t<MenuItemName>ContosoRentForm</MenuItemName>');
  });

  it('submenuLocations gives each submenu its parent, root entries by <Parent>', () => {
    const withParent = addMenuExtensionSubmenu(SUBMENU_EXT, { name: 'ContosoRentals', parent: 'Setup' });
    if (withParent.kind !== 'added') throw new Error(withParent.kind);
    const nested = addMenuExtensionSubmenu(withParent.xml, { name: 'ContosoRentSetup', parent: 'ContosoRentals' });
    if (nested.kind !== 'added') throw new Error(nested.kind);
    const els = nested.xml.indexOf('<Elements>');
    const span = { tag: 'Elements', open: els, openEnd: els + '<Elements>'.length, close: 0, end: 0, selfClosed: false };
    expect(submenuLocations(nested.xml, span)).toEqual([
      { name: 'ContosoIntentLetters', parent: '' },
      { name: 'ContosoPlanningPolicies', parent: '' },
      { name: 'ContosoRentals', parent: 'Setup' },
      { name: 'ContosoRentSetup', parent: 'ContosoRentals' },
    ]);
  });
});

describe('directXmlAddSubmenu', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
    vi.mocked(findBaseObjectXml).mockReset();
    vi.mocked(findBaseObjectXml).mockResolvedValue(null);
  });

  async function file(xml: string, name: string): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'menu-sub-'));
    const f = path.join(dir, `${name}.xml`);
    await fs.writeFile(f, xml.replace(/\n/g, '\r\n'), 'utf-8');
    return f;
  }

  it('adds a submenu to an extension under a base-menu submenu, then takes an item nested in it', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const f = await file(EMPTY_EXT, 'ContosoMain.ContosoExtension');
    const r = await directXmlAddSubmenu(f, { submenuName: 'ContosoRentals', submenuLabel: '@ContosoRental:Rentals', parentMenuElement: 'setup' }, {});
    expect(r.success).toBe(true);
    expect(r.message).toContain("✅ Submenu 'ContosoRentals' added under submenu 'Setup' of menu 'ContosoMain'");
    expect(r.message).toContain('parentMenuElement="ContosoRentals"');
    expect(r.message).not.toContain('⚠️');
    const item = await directXmlAddMenuItemToMenuExtension(f, { menuItemToAdd: 'ContosoRentForm', parentMenuElement: 'ContosoRentals' }, {});
    expect(item.message).toContain("inside submenu 'ContosoRentals', which this extension adds,");
    const written = await fs.readFile(f, 'utf-8');
    expect(written).toContain('<Parent>Setup</Parent>\r\n');
    expect(written.match(/<Parent>/g)).toHaveLength(1);
    expect(written).toContain('<MenuItemName>ContosoRentForm</MenuItemName>');
  });

  it('refuses a name the base menu or another indexed extension already has', async () => {
    vi.mocked(findBaseObjectXml).mockImplementation(async (type: string, name: string) =>
      type === 'menu' ? BASE_MENU : name === 'ContosoMain.ContosoSubmenus' ? SUBMENU_EXT : null);
    const symbolIndex = { getReadDb: () => ({ prepare: () => ({ all: () => [{ name: 'ContosoMain.ContosoSubmenus' }] }) }) };
    const f = await file(EMPTY_EXT, 'ContosoMain.ContosoExtension');
    const before = await fs.readFile(f, 'utf-8');
    for (const submenuName of ['EInvoice', 'contosoplanningpolicies']) {
      const r = await directXmlAddSubmenu(f, { submenuName }, symbolIndex);
      expect(r.success).toBe(false);
      expect(r.message).toContain('already exists in menu \'ContosoMain\'');
      expect(r.message).toContain(`parentMenuElement="${submenuName}"`);
    }
    expect(await fs.readFile(f, 'utf-8')).toBe(before);
  });

  it('refuses a name a menu item or tile of the base menu already has', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const f = await file(EMPTY_EXT, 'ContosoMain.ContosoExtension');
    const before = await fs.readFile(f, 'utf-8');
    for (const submenuName of ['ContosoSystemDate', 'contosoworkspace']) {
      const r = await directXmlAddSubmenu(f, { submenuName, parentMenuElement: 'Setup' }, {});
      expect(r.success).toBe(false);
      expect(r.message).toContain(`'${submenuName}' is already the name of an element`);
      expect(r.message).toContain('choose another submenuName');
    }
    expect(await fs.readFile(f, 'utf-8')).toBe(before);
  });

  it('on an AxMenu: refuses a name an item of the menu has, and names a repeated item <item>N', async () => {
    const f = await file(BASE_MENU, 'ContosoMain');
    const sub = await directXmlAddSubmenu(f, { submenuName: 'ContosoTaxRegime' }, {});
    expect(sub.success).toBe(false);
    expect(sub.message).toContain("'ContosoTaxRegime' is already the name of an element");
    const item = await directXmlAddMenuItemToMenu(f, 'ContosoTaxRegime', 'display', 'Setup');
    expect(item?.message).toContain("so this element is named 'ContosoTaxRegime1'");
    expect(await fs.readFile(f, 'utf-8')).toContain('<Name>ContosoTaxRegime1</Name>');
  });

  it('refuses an unknown parent with the list, like the item op', async () => {
    vi.mocked(findBaseObjectXml).mockResolvedValue(BASE_MENU);
    const f = await file(EMPTY_EXT, 'ContosoMain.ContosoExtension');
    const r = await directXmlAddSubmenu(f, { submenuName: 'ContosoRentals', parentMenuElement: 'Reportzz' }, {});
    expect(r.success).toBe(false);
    expect(r.message).toContain("Submenu 'Reportzz' is not in menu 'ContosoMain'");
  });

  it('writes with a warning when the base menu cannot be read, and warns on a literal label', async () => {
    const f = await file(EMPTY_EXT, 'ContosoMain.ContosoExtension');
    const r = await directXmlAddSubmenu(f, { submenuName: 'ContosoRentals', submenuLabel: 'Rentals', parentMenuElement: 'Setup' }, {});
    expect(r.success).toBe(true);
    expect(r.message).toContain("Base menu 'ContosoMain' could not be read, so 'ContosoRentals' and submenu 'Setup' were NOT checked");
    expect(r.message).toContain("submenuLabel 'Rentals' is not a label id");
  });

  it('on an AxMenu: nests under a submenu of that menu, refuses one it does not have', async () => {
    const f = await file(BASE_MENU, 'ContosoMain');
    const ok = await directXmlAddSubmenu(f, { submenuName: 'ContosoRentals', parentMenuElement: 'EInvoice' }, {});
    expect(ok.message).toContain("added under submenu 'EInvoice' of menu 'ContosoMain'");
    expect(findBaseObjectXml).not.toHaveBeenCalled();
    const bad = await directXmlAddSubmenu(f, { submenuName: 'ContosoOther', parentMenuElement: 'Reportzz' }, {});
    expect(bad.success).toBe(false);
    expect(bad.message).toContain('Submenus: Workspaces, Setup, EInvoice, SATclassifications, ContosoRentals');
    const again = await directXmlAddSubmenu(f, { submenuName: 'ContosoRentals', parentMenuElement: 'EInvoice' }, {});
    expect(again.skipped).toBe(true);
  });

  it('the AxMenu item writer takes a parent, and names the submenus when it is wrong', async () => {
    const f = await file(BASE_MENU, 'ContosoMain');
    const ok = await directXmlAddMenuItemToMenu(f, 'ContosoRentForm', 'display', 'Workspaces');
    expect(ok?.message).toContain("added under submenu 'Workspaces' via direct XML.");
    const bad = await directXmlAddMenuItemToMenu(f, 'ContosoRentForm', 'display', 'Reportzz');
    expect(bad?.success).toBe(false);
    expect(bad?.message).toContain("Submenu 'Reportzz' is not in menu 'ContosoMain'");
    const written = await fs.readFile(f, 'utf-8');
    expect(written.indexOf('<Name>ContosoRentForm</Name>')).toBeLessThan(written.indexOf('<Name>ContosoSystemDate</Name>'));
  });
});
