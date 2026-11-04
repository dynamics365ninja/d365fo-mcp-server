/**
 * Menu items into an AxMenuExtension — the write half `menu-extension` never had.
 *
 * The cross-model write guard sends an agent that wants an item in a standard
 * menu to a `menu-extension` (EXTENSION_TYPE_OF.menu), and create wrote one —
 * but every modify on it was refused at the bridge gate, so the extension could
 * not be filled. The C# AddMenuItemToMenu reads an AxMenu only, and the AxMenu
 * XML fallback writes the wrong shape for an extension (a bare <AxMenuElement>
 * directly under <Elements>).
 *
 * Shape pinned against the shipped AOT — 224 AxMenuExtension files in Microsoft
 * models (e.g. ApplicationWorkspaces\AxMenuExtension\RetailMain.Workspaces.xml,
 * ApplicationSuite\Foundation\AxMenuExtension\MainMenu.Tax.xml):
 *   - each entry of the root <Elements> is an <AxMenuExtensionElement xmlns="">,
 *     its children in the order Parent?, PositionType?, PreviousSibling?,
 *     MenuElement — all four shapes occur;
 *   - the element itself is <MenuElement xmlns="" i:type="AxMenuElementMenuItem">,
 *     the attribute on its own line, holding Name, MenuItemName, MenuItemType;
 *   - MenuItemType is written for Action and Output only — the shipped Display
 *     items omit it (Display is the model default);
 *   - <Parent> is a plain submenu name: 112 distinct values, none with a path
 *     separator, naming nested submenus too (SATclassifications sits at depth 3
 *     of OrganizationAdministration). Without it the item lands on the top level
 *     of the base menu, which 107 of the 279 entry shapes do, menu items among
 *     them;
 *   - a submenu the extension adds ITSELF is an <MenuElement
 *     i:type="AxMenuElementSubMenu"> with its own <Elements>, and its items are
 *     nested there as <AxMenuElement xmlns=""> — 197 such items in a sample of 43
 *     extensions, against 0 separate entries with <Parent> naming the extension's
 *     own submenu;
 *   - root order Name, Customizations, Elements, MenuElementModifications,
 *     PropertyModifications in 192 files, the first three only in 32.
 *
 * Appends at the end only: PositionType (Begin | AfterItem) / PreviousSibling
 * are left out by choice.
 */
import { escapeXml } from '../../utils/xmlEscape.js';

export type MenuExtensionItemType = 'display' | 'action' | 'output';

export interface MenuExtensionItemSpec {
  menuItemName: string;
  menuItemType?: string;
  /** Submenu of the base menu (or of this extension) the item goes under; empty = top level. */
  parent?: string;
}

export type AddMenuExtensionItemResult =
  /** `nested`: placed inside a submenu this extension adds, rather than as a root entry. */
  | { kind: 'added'; xml: string; menuItemType: MenuExtensionItemType; nested: boolean }
  /** The same menu item is already under the same parent — idempotent no-op. */
  | { kind: 'already-present' }
  /** No root <Elements> collection to insert into. */
  | { kind: 'no-collection' }
  /** Not an AxMenuExtension; the caller declines. */
  | { kind: 'unsupported' };

const MENU_ITEM_TYPE_VALUE: Record<MenuExtensionItemType, string | null> = {
  display: null,
  action: 'Action',
  output: 'Output',
};

interface ElementSpan {
  tag: string;
  open: number;
  openEnd: number;
  close: number;
  end: number;
  selfClosed: boolean;
}

/**
 * The direct children of the element whose open tag ends at `from`, each matched
 * to its own close. Depth is what keeps a submenu's nested <Elements> from being
 * taken for the collection that holds it.
 */
function* directChildren(xml: string, from: number): Generator<ElementSpan> {
  const re = /<(\/?)([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/g;
  re.lastIndex = from;
  let depth = 0;
  let current: { tag: string; open: number; openEnd: number } | null = null;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] === '/') {
      if (--depth < 0) return;
      if (depth === 0 && current) {
        yield { ...current, close: m.index, end: re.lastIndex, selfClosed: false };
        current = null;
      }
    } else if (m[3] === '/') {
      if (depth === 0) {
        yield { tag: m[2], open: m.index, openEnd: re.lastIndex, close: re.lastIndex, end: re.lastIndex, selfClosed: true };
      }
    } else {
      if (depth === 0) current = { tag: m[2], open: m.index, openEnd: re.lastIndex };
      depth++;
    }
  }
}

function child(xml: string, el: ElementSpan, tag: string): ElementSpan | null {
  if (el.selfClosed) return null;
  for (const c of directChildren(xml, el.openEnd)) if (c.tag === tag) return c;
  return null;
}

/** Text of a direct child, as written in the file (still XML-escaped). */
function childText(xml: string, el: ElementSpan, tag: string): string | null {
  const c = child(xml, el, tag);
  return c ? xml.slice(c.openEnd, c.close).trim() : null;
}

function iType(xml: string, el: ElementSpan): string | null {
  return /\bi:type="([^"]*)"/.exec(xml.slice(el.open, el.openEnd))?.[1] ?? null;
}

/** Whitespace before an element on its own line — the indent its children are one tab deeper than. */
function lineIndent(xml: string, at: number): string {
  return xml.slice(xml.lastIndexOf('\n', at) + 1, at);
}

const same = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

/**
 * Names of every submenu in an AxMenu or AxMenuExtension, at any depth, as written
 * in the file (still XML-escaped). A <Parent> may name a nested submenu by its
 * plain name, and an extension may add a submenu and items under it in one file.
 */
export function menuSubmenuNames(xml: string): string[] {
  const names: string[] = [];
  const re = /<[A-Za-z_][\w.:-]*\b[^>]*\bi:type="AxMenuElementSubMenu"[^>]*>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0].endsWith('/>')) continue;
    const el = { tag: '', open: m.index, openEnd: m.index + m[0].length, close: 0, end: 0, selfClosed: false };
    const name = childText(xml, el, 'Name');
    if (name) names.push(name);
  }
  return names;
}

/** The <Elements> of the submenu named `name` that this extension adds, at any depth. */
function ownSubmenuElements(xml: string, collection: ElementSpan, name: string): ElementSpan | null {
  for (const c of directChildren(xml, collection.openEnd)) {
    const el = c.tag === 'AxMenuExtensionElement' ? child(xml, c, 'MenuElement') : c;
    if (!el || iType(xml, el) !== 'AxMenuElementSubMenu') continue;
    const elements = child(xml, el, 'Elements');
    if (!elements) continue;
    if (same(childText(xml, el, 'Name'), name)) return elements;
    const deeper = elements.selfClosed ? null : ownSubmenuElements(xml, elements, name);
    if (deeper) return deeper;
  }
  return null;
}

/** Insert `block` (lines already indented) at the end of a collection, either spelling of empty included. */
function appendTo(xml: string, collection: ElementSpan, block: string): string {
  const indent = lineIndent(xml, collection.open);
  if (collection.selfClosed || !xml.slice(collection.openEnd, collection.close).trim()) {
    return `${xml.slice(0, collection.open)}<${collection.tag}>\n${block}${indent}</${collection.tag}>${xml.slice(collection.end)}`;
  }
  // Consume the whitespace run that is the close tag's own indent, so the block
  // is not indented on top of it.
  let from = collection.close;
  while (from > 0 && /\s/.test(xml[from - 1])) from--;
  return `${xml.slice(0, from)}\n${block}${indent}${xml.slice(collection.close)}`;
}

/** Add one menu item to an AxMenuExtension, at the end of its parent collection. */
export function addMenuExtensionItem(xml: string, spec: MenuExtensionItemSpec): AddMenuExtensionItemResult {
  const root = /<AxMenuExtension\b[^>]*>/.exec(xml);
  if (!root) return { kind: 'unsupported' };
  const rootEl = { tag: 'AxMenuExtension', open: root.index, openEnd: root.index + root[0].length, close: 0, end: 0, selfClosed: false };
  const collection = child(xml, rootEl, 'Elements');
  if (!collection) return { kind: 'no-collection' };

  const raw = String(spec.menuItemType ?? '').trim().toLowerCase();
  const menuItemType: MenuExtensionItemType = raw === 'action' || raw === 'output' ? raw : 'display';
  const typeValue = MENU_ITEM_TYPE_VALUE[menuItemType];
  const name = escapeXml(String(spec.menuItemName).trim());
  const parent = spec.parent?.trim() ? escapeXml(spec.parent.trim()) : '';

  // Compared escaped against escaped, case-insensitively as X++ names are.
  const isThisItem = (xmlOf: string, el: ElementSpan | null) =>
    !!el && iType(xmlOf, el) === 'AxMenuElementMenuItem' && same(childText(xmlOf, el, 'MenuItemName'), name);

  // A submenu this extension adds takes the item INSIDE it, as the shipped files do.
  const own = parent ? ownSubmenuElements(xml, collection, parent) : null;
  if (own) {
    if (!own.selfClosed) {
      for (const c of directChildren(xml, own.openEnd)) if (isThisItem(xml, c)) return { kind: 'already-present' };
    }
    const ind = `${lineIndent(xml, own.open)}\t`;
    const block =
      `${ind}<AxMenuElement xmlns=""\n` +
      `${ind}\ti:type="AxMenuElementMenuItem">\n` +
      `${ind}\t<Name>${name}</Name>\n` +
      `${ind}\t<MenuItemName>${name}</MenuItemName>\n` +
      (typeValue ? `${ind}\t<MenuItemType>${typeValue}</MenuItemType>\n` : '') +
      `${ind}</AxMenuElement>\n`;
    return { kind: 'added', xml: appendTo(xml, own, block), menuItemType, nested: true };
  }

  if (!collection.selfClosed) {
    for (const c of directChildren(xml, collection.openEnd)) {
      if (c.tag !== 'AxMenuExtensionElement') continue;
      if (isThisItem(xml, child(xml, c, 'MenuElement')) && same(childText(xml, c, 'Parent'), parent)) {
        return { kind: 'already-present' };
      }
    }
  }

  const ind = `${lineIndent(xml, collection.open)}\t`;
  const block =
    `${ind}<AxMenuExtensionElement xmlns="">\n` +
    (parent ? `${ind}\t<Parent>${parent}</Parent>\n` : '') +
    `${ind}\t<MenuElement xmlns=""\n` +
    `${ind}\t\ti:type="AxMenuElementMenuItem">\n` +
    `${ind}\t\t<Name>${name}</Name>\n` +
    `${ind}\t\t<MenuItemName>${name}</MenuItemName>\n` +
    (typeValue ? `${ind}\t\t<MenuItemType>${typeValue}</MenuItemType>\n` : '') +
    `${ind}\t</MenuElement>\n` +
    `${ind}</AxMenuExtensionElement>\n`;
  return { kind: 'added', xml: appendTo(xml, collection, block), menuItemType, nested: false };
}
