/**
 * Items and submenus into an AxMenu of one's own model (menuXml.ts).
 *
 * BASE_MENU is an excerpt of the shipped AxMenu OrganizationAdministration with the
 * items renamed to Contoso: its FIRST element is a submenu (Workspaces), which is
 * what sent the old fallback's item into that submenu — it inserted before the
 * first `</Elements>` in the file. EMPTY_MENU is what create writes.
 */
import { describe, it, expect } from 'vitest';
import { addMenuItem, addMenuSubmenu } from '../../src/tools/xml/menuXml';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator';

const EMPTY_MENU = XmlTemplateGenerator.generateAxMenuXml('ContosoRental');

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

function xmlOf(r: { kind: string; xml?: string }): string {
  if (r.kind !== 'added' || !r.xml) throw new Error(`expected added, got ${r.kind}`);
  return r.xml;
}

describe('addMenuItem (AxMenu)', () => {
  it('puts a top-level item at the end of the ROOT <Elements>, not into the first submenu', () => {
    const xml = xmlOf(addMenuItem(BASE_MENU, { menuItemName: 'ContosoRentForm' }));
    // Everything up to the root close is unchanged; the item is its last child.
    const rootClose = BASE_MENU.lastIndexOf('\n\t</Elements>');
    expect(xml.slice(0, rootClose)).toBe(BASE_MENU.slice(0, rootClose));
    expect(xml.slice(rootClose)).toBe(
      '\n\t\t<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">\n' +
      '\t\t\t<Name>ContosoRentForm</Name>\n' +
      '\t\t\t<MenuItemName>ContosoRentForm</MenuItemName>\n' +
      '\t\t\t<MenuItemType>Display</MenuItemType>\n' +
      '\t\t</AxMenuElement>\n' +
      '\t</Elements>\n</AxMenu>',
    );
  });

  it('puts an item into a submenu at depth 3, named by its plain name', () => {
    const xml = xmlOf(addMenuItem(BASE_MENU, { menuItemName: 'ContosoRentJob', menuItemType: 'action', parent: 'satclassifications' }));
    expect(xml).toContain(
      '\t\t\t\t\t\t\t\t\t<MenuItemName>ContosoTaxRegime</MenuItemName>\n' +
      '\t\t\t\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t\t\t\t\t<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">\n' +
      '\t\t\t\t\t\t\t\t\t<Name>ContosoRentJob</Name>\n' +
      '\t\t\t\t\t\t\t\t\t<MenuItemName>ContosoRentJob</MenuItemName>\n' +
      '\t\t\t\t\t\t\t\t\t<MenuItemType>Action</MenuItemType>\n' +
      '\t\t\t\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t\t\t\t</Elements>\n',
    );
  });

  it('names the submenus when the parent is not in the menu', () => {
    expect(addMenuItem(BASE_MENU, { menuItemName: 'X', parent: 'Reports' }))
      .toEqual({ kind: 'no-parent', submenus: ['Workspaces', 'Setup', 'EInvoice', 'SATclassifications'] });
  });

  it('skips the item already in that collection, but not one in another submenu', () => {
    expect(addMenuItem(BASE_MENU, { menuItemName: 'contososystemdate' }).kind).toBe('already-present');
    expect(addMenuItem(BASE_MENU, { menuItemName: 'ContosoTaxRegime', parent: 'SATclassifications' }).kind).toBe('already-present');
    expect(addMenuItem(BASE_MENU, { menuItemName: 'ContosoTaxRegime', parent: 'Setup' }).kind).toBe('added');
  });

  it('opens the empty <Elements /> of a new menu, and escapes', () => {
    const xml = xmlOf(addMenuItem(EMPTY_MENU, { menuItemName: 'Contoso&Co' }));
    expect(xml).toContain('\t<Elements>\n\t\t<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">\n\t\t\t<Name>Contoso&amp;Co</Name>');
    expect(xml).toContain('\t\t</AxMenuElement>\n\t</Elements>');
  });

  it('declines a menu extension', () => {
    expect(addMenuItem('<AxMenuExtension><Name>A.B</Name><Elements /></AxMenuExtension>', { menuItemName: 'X' }).kind)
      .toBe('unsupported');
  });
});

describe('addMenuSubmenu (AxMenu)', () => {
  it('adds a top-level submenu with label and an empty collection', () => {
    const xml = xmlOf(addMenuSubmenu(BASE_MENU, { name: 'ContosoRentals', label: '@ContosoRental:Rentals' }));
    expect(xml.slice(BASE_MENU.lastIndexOf('\n\t</Elements>'))).toBe(
      '\n\t\t<AxMenuElement xmlns="" i:type="AxMenuElementSubMenu">\n' +
      '\t\t\t<Name>ContosoRentals</Name>\n' +
      '\t\t\t<Label>@ContosoRental:Rentals</Label>\n' +
      '\t\t\t<Elements />\n' +
      '\t\t</AxMenuElement>\n' +
      '\t</Elements>\n</AxMenu>',
    );
  });

  it('nests a submenu under a parent, without a label when none is given', () => {
    const r = addMenuSubmenu(BASE_MENU, { name: 'ContosoRentSetup', parent: 'EInvoice' });
    expect(r.kind === 'added' && r.nested).toBe(true);
    expect(xmlOf(r)).toContain(
      '\t\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t\t\t<AxMenuElement xmlns="" i:type="AxMenuElementSubMenu">\n' +
      '\t\t\t\t\t\t\t<Name>ContosoRentSetup</Name>\n' +
      '\t\t\t\t\t\t\t<Elements />\n' +
      '\t\t\t\t\t\t</AxMenuElement>\n' +
      '\t\t\t\t\t</Elements>\n',
    );
  });

  it('skips the same name under the same parent, refuses it under another', () => {
    expect(addMenuSubmenu(BASE_MENU, { name: 'einvoice', parent: 'Setup' }).kind).toBe('already-present');
    expect(addMenuSubmenu(BASE_MENU, { name: 'EInvoice' })).toEqual({ kind: 'exists', parent: 'Setup' });
    expect(addMenuSubmenu(BASE_MENU, { name: 'Workspaces', parent: 'Setup' })).toEqual({ kind: 'exists', parent: '' });
  });

  it('names the submenus when the parent is not in the menu', () => {
    expect(addMenuSubmenu(BASE_MENU, { name: 'X', parent: 'Reports' }).kind).toBe('no-parent');
  });

  it('a new submenu then takes its first item', () => {
    const withSub = xmlOf(addMenuSubmenu(EMPTY_MENU, { name: 'ContosoRentals' }));
    const xml = xmlOf(addMenuItem(withSub, { menuItemName: 'ContosoRentForm', parent: 'ContosoRentals' }));
    expect(xml).toContain(
      '\t\t\t<Name>ContosoRentals</Name>\n' +
      '\t\t\t<Elements>\n' +
      '\t\t\t\t<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">\n' +
      '\t\t\t\t\t<Name>ContosoRentForm</Name>\n',
    );
  });
});
