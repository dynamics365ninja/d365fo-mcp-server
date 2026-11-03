/**
 * Items and submenus into an AxMenu — a menu of one's own model. (A standard menu
 * is changed through an AxMenuExtension: menuExtensionXml.ts.)
 *
 * A shipped AxMenu (OrganizationAdministration: 33 submenus, 149 items) holds its
 * submenus INLINE: <AxMenuElement i:type="AxMenuElementSubMenu"> with Name, Label
 * and its own <Elements>, nested up to three deep. No shipped menu or extension
 * has a <SubMenu> field.
 *
 * The XML fallback for add-menu-item-to-menu used to insert before the FIRST
 * `</Elements>` in the file. In a menu with inline submenus that is the close of
 * the first submenu (OrganizationAdministration: Workspaces), so the item landed
 * inside it. Collections are matched by depth here.
 *
 * Items keep the shape that writer has always produced — the one-line tag and an
 * explicit MenuItemType, Display included — so a menu written before this change
 * and after it reads the same.
 */
import { escapeXml } from '../../utils/xmlEscape.js';
import {
  type AddSubmenuResult, type ElementSpan, type MenuSubmenuSpec,
  appendTo, child, childText, directChildren, findSubmenuElements, iType, lineIndent,
  menuSubmenuNames, same, submenuElementBlock, submenuLocations,
} from './menuExtensionXml.js';

export type AddMenuItemResult =
  | { kind: 'added'; xml: string; menuItemType: string }
  | { kind: 'already-present' }
  /** The parent is no submenu of this menu. */
  | { kind: 'no-parent'; submenus: string[] }
  | { kind: 'no-collection' }
  | { kind: 'unsupported' };

const MENU_ITEM_TYPE: Record<string, string> = { display: 'Display', action: 'Action', output: 'Output' };

/** The collection to write into — the root <Elements>, or the named submenu's — and the root one. */
function target(xml: string, parent: string): { collection: ElementSpan; rootElements: ElementSpan } | { missing: true } | null {
  const root = /<AxMenu\b[^>]*>/.exec(xml);
  if (!root) return null;
  const rootEl = { tag: 'AxMenu', open: root.index, openEnd: root.index + root[0].length, close: 0, end: 0, selfClosed: false };
  const collection = child(xml, rootEl, 'Elements');
  if (!collection) return null;
  if (!parent) return { collection, rootElements: collection };
  const sub = findSubmenuElements(xml, collection, parent);
  return sub ? { collection: sub, rootElements: collection } : { missing: true };
}

export function addMenuItem(xml: string, spec: { menuItemName: string; menuItemType?: string; parent?: string }): AddMenuItemResult {
  if (!/<AxMenu\b/.test(xml)) return { kind: 'unsupported' };
  const parent = spec.parent?.trim() ? escapeXml(spec.parent.trim()) : '';
  const t = target(xml, parent);
  if (!t) return { kind: 'no-collection' };
  if ('missing' in t) return { kind: 'no-parent', submenus: menuSubmenuNames(xml) };

  const name = escapeXml(String(spec.menuItemName).trim());
  const menuItemType = MENU_ITEM_TYPE[String(spec.menuItemType ?? '').trim().toLowerCase()] ?? 'Display';
  if (!t.collection.selfClosed) {
    for (const c of directChildren(xml, t.collection.openEnd)) {
      if (iType(xml, c) === 'AxMenuElementMenuItem' && same(childText(xml, c, 'MenuItemName'), name)) {
        return { kind: 'already-present' };
      }
    }
  }
  const ind = `${lineIndent(xml, t.collection.open)}\t`;
  const block =
    `${ind}<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">\n` +
    `${ind}\t<Name>${name}</Name>\n` +
    `${ind}\t<MenuItemName>${name}</MenuItemName>\n` +
    `${ind}\t<MenuItemType>${menuItemType}</MenuItemType>\n` +
    `${ind}</AxMenuElement>\n`;
  return { kind: 'added', xml: appendTo(xml, t.collection, block), menuItemType };
}

export function addMenuSubmenu(xml: string, spec: MenuSubmenuSpec): AddSubmenuResult {
  if (!/<AxMenu\b/.test(xml)) return { kind: 'unsupported' };
  const parent = spec.parent?.trim() ? escapeXml(spec.parent.trim()) : '';
  const t = target(xml, parent);
  if (!t) return { kind: 'no-collection' };
  if ('missing' in t) return { kind: 'no-parent', submenus: menuSubmenuNames(xml) };

  const name = escapeXml(spec.name.trim());
  const taken = submenuLocations(xml, t.rootElements).find(l => same(l.name, name));
  if (taken) return same(taken.parent, parent) ? { kind: 'already-present' } : { kind: 'exists', parent: taken.parent };

  const label = spec.label?.trim() ? escapeXml(spec.label.trim()) : '';
  const block = submenuElementBlock(`${lineIndent(xml, t.collection.open)}\t`, name, label, false);
  return { kind: 'added', xml: appendTo(xml, t.collection, block), nested: !!parent };
}
