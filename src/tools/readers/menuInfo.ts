/**
 * get_object_info for `menu` and `menu-extension`.
 *
 * get_object_info had neither type, so an agent placing an item had no tool to
 * find a submenu: on a dev VM it grepped PackagesLocalDirectory for the menu XML
 * and read it raw ("get_object_info has no menu reader, so I'll read the menu XML
 * directly"). The write operations take a submenu by its plain name
 * (parentMenuElement), so what an agent needs is the tree of names — of the base
 * menu, and of the submenus its extensions add.
 *
 * Reads through utils/menuFiles.ts: index, configured model, then every package
 * folder, so a write-only companion (no index) reads standard menus too.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SERVER_MODE } from '../../server/serverMode.js';
import type { XppServerContext } from '../../types/context.js';
import { indexedMenuExtensions, readMenuExtensions, readMenuXml } from '../../utils/menuFiles.js';
import { type ElementSpan, child, childText, directChildren, iType } from '../xml/menuExtensionXml.js';

const MenuInfoArgsSchema = z.object({
  name: z.string().describe('Menu name, or for menu-extension a base menu name or a full extension name (Base.Suffix)'),
  submenusOnly: z.boolean().optional().describe('true = the submenu tree only, with an item count per submenu'),
});

/**
 * Why nothing was read. A read-only server (the shared one in the hybrid setup)
 * reads only the files its index points to and still finds on its disk — the source
 * of some models, not the standard packages — and its index keeps no menu XML: the
 * full build indexes no menus, and the stored copies leave them out. "Not found"
 * would send the caller to search and update_symbol_index for an object that
 * exists. The local companion has the files. Worded without "not found", which
 * would append that very guidance.
 *
 * What the index does know there is which extensions a menu has (the full build
 * indexes menu extensions by name, not their content), so that list goes along:
 * "which extensions does this menu have?" is answerable on the shared server.
 */
function unreadable(what: string, baseMenu: string, symbolIndex: unknown): string {
  if (SERVER_MODE === 'read-only') {
    const known = indexedMenuExtensions(baseMenu, symbolIndex);
    return `❌ ${what} cannot be read on this server: it has no copy of the file, and its index keeps ` +
      `no menu XML. Read it with get_object_info on the local companion (d365fo-local), which reads the ` +
      `files on the dev VM.` +
      (known.length
        ? `\n\nThe index knows these extensions of menu "${baseMenu}" (names only, not their entries):\n` +
          known.map(k => `- ${k.name} (model ${k.model})`).join('\n')
        : '');
  }
  return `${what} not found — not in the index, the configured model or any package folder.`;
}

/**
 * The extensions of `baseMenu` the index knows but whose file was not read. On the
 * shared server the index points into the source of every model, but only some of
 * it is on that disk (custom models, not Microsoft's): on a dev VM a menu's custom
 * extensions came back as "Extensions of menu (5)", Microsoft's left out without a
 * word, and a partial list reads as the whole one. Above the rendered extensions,
 * so the 400-line cut keeps it.
 */
function notRead(baseMenu: string, read: Array<{ name: string }>, symbolIndex: unknown): { count: number; lines: string[] } {
  const have = new Set(read.map(e => e.name.toLowerCase()));
  const missing = indexedMenuExtensions(baseMenu, symbolIndex).filter(k => !have.has(k.name.toLowerCase()));
  if (missing.length === 0) return { count: 0, lines: [] };
  return {
    count: missing.length,
    lines: [
      `**Not read (${missing.length}):** known to the index, but this server has no copy of their files:`,
      ...missing.map(k => `- ${k.name} (model ${k.model})`),
      ...(SERVER_MODE === 'read-only'
        ? ['Read them with get_object_info(objectType="menu-extension", name="<extension>") on the local companion (d365fo-local).']
        : []),
      '',
    ],
  };
}

const readOf = (read: number, unread: number) => (unread ? `${read} of ${read + unread} read` : `${read}`);

/** Above this many lines the tree is cut, with a pointer to submenusOnly. */
const MAX_LINES = 400;

interface Counts { submenus: number; items: number }

function rootSpan(xml: string, rootTag: string): ElementSpan | null {
  const m = new RegExp(`<${rootTag}\\b[^>]*>`).exec(xml);
  return m ? { tag: rootTag, open: m.index, openEnd: m.index + m[0].length, close: 0, end: 0, selfClosed: false } : null;
}

/** Items directly in a collection (not in its submenus). */
function itemCount(xml: string, elements: ElementSpan | null): number {
  if (!elements || elements.selfClosed) return 0;
  let n = 0;
  for (const c of directChildren(xml, elements.openEnd)) if (iType(xml, c) !== 'AxMenuElementSubMenu') n++;
  return n;
}

/** One menu element and, for a submenu, what it holds — as indented list lines. */
function renderElement(xml: string, el: ElementSpan, depth: number, out: string[], counts: Counts, submenusOnly: boolean): void {
  const pad = '  '.repeat(depth);
  const name = childText(xml, el, 'Name') ?? '?';
  const type = iType(xml, el);
  if (type === 'AxMenuElementSubMenu') {
    counts.submenus++;
    const label = childText(xml, el, 'Label');
    const elements = child(xml, el, 'Elements');
    const n = submenusOnly ? itemCount(xml, elements) : 0;
    const items = submenusOnly ? ` (${n} item${n === 1 ? '' : 's'})` : '';
    out.push(`${pad}- 📁 **${name}**${label ? ` — ${label}` : ''}${items}`);
    if (elements && !elements.selfClosed) {
      for (const c of directChildren(xml, elements.openEnd)) renderElement(xml, c, depth + 1, out, counts, submenusOnly);
    }
    return;
  }
  counts.items++;
  if (submenusOnly) return;
  switch (type) {
    case 'AxMenuElementMenuItem': {
      const target = childText(xml, el, 'MenuItemName');
      const kind = childText(xml, el, 'MenuItemType');
      out.push(`${pad}- ${name}${target && target !== name ? ` → ${target}` : ''}${kind && kind !== 'Display' ? ` (${kind})` : ''}`);
      return;
    }
    case 'AxMenuElementMenuReference':
      out.push(`${pad}- ↪ menu ${childText(xml, el, 'MenuName') ?? name}`);
      return;
    case 'AxMenuElementTile':
      out.push(`${pad}- tile ${childText(xml, el, 'Tile') ?? name}`);
      return;
    case 'AxMenuElementSeparator':
      out.push(`${pad}- ———`);
      return;
    default:
      out.push(`${pad}- ${name}${type ? ` (${type.replace(/^AxMenuElement/, '')})` : ''}`);
  }
}

/** The entries of one extension: per root entry its parent (or the top level) and the element. */
function renderExtension(xml: string, out: string[], counts: Counts, submenusOnly: boolean): void {
  const root = rootSpan(xml, 'AxMenuExtension');
  const elements = root ? child(xml, root, 'Elements') : null;
  if (!elements || elements.selfClosed) {
    out.push('*(no entries)*');
  } else {
    for (const entry of directChildren(xml, elements.openEnd)) {
      if (entry.tag !== 'AxMenuExtensionElement') continue;
      const me = child(xml, entry, 'MenuElement');
      if (!me) continue;
      const parent = childText(xml, entry, 'Parent');
      const position = childText(xml, entry, 'PositionType');
      const after = childText(xml, entry, 'PreviousSibling');
      const where = `${parent ? `under **${parent}**` : 'top level'}${position === 'Begin' ? ', first' : after ? `, after ${after}` : ''}`;
      const before = out.length;
      renderElement(xml, me, 1, out, counts, submenusOnly);
      if (out.length > before) out.splice(before, 0, `- ${where}:`);
    }
  }
  const customizations = root ? child(xml, root, 'Customizations') : null;
  if (customizations && !customizations.selfClosed) {
    const changed: string[] = [];
    for (const c of directChildren(xml, customizations.openEnd)) {
      const props = [...directChildren(xml, c.openEnd)].filter(p => p.tag !== 'Name')
        .map(p => `${p.tag}=${xml.slice(p.openEnd, p.close).trim()}`);
      changed.push(`${childText(xml, c, 'Name')}${props.length ? ` (${props.join(', ')})` : ''}`);
    }
    if (changed.length) out.push(`- changes to base elements: ${changed.join('; ')}`);
  }
}

/** One line per extension: the submenus it adds (with their parent) and how many items. */
function extensionSummary(name: string, xml: string): string {
  const added: string[] = [];
  const counts: Counts = { submenus: 0, items: 0 };
  const root = rootSpan(xml, 'AxMenuExtension');
  const elements = root ? child(xml, root, 'Elements') : null;
  if (elements && !elements.selfClosed) {
    for (const entry of directChildren(xml, elements.openEnd)) {
      const me = entry.tag === 'AxMenuExtensionElement' ? child(xml, entry, 'MenuElement') : null;
      if (!me) continue;
      if (iType(xml, me) === 'AxMenuElementSubMenu') {
        const parent = childText(xml, entry, 'Parent');
        added.push(`${childText(xml, me, 'Name')}${parent ? ` (under ${parent})` : ''}`);
      }
      renderElement(xml, me, 0, [], counts, true);
    }
  }
  return `- \`${name}\`: ${counts.items} item${counts.items === 1 ? '' : 's'}` +
    (added.length ? `; adds submenu${added.length === 1 ? '' : 's'} ${added.join(', ')}` : '');
}

function capped(lines: string[], hint: string): string[] {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), '', `… ${lines.length - MAX_LINES} more lines cut. ${hint}`];
}

export async function menuInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = MenuInfoArgsSchema.parse(request.params.arguments);
    const xml = await readMenuXml(args.name, context.symbolIndex);
    if (!xml) {
      return {
        content: [{ type: 'text', text: unreadable(`Menu "${args.name}"`, args.name, context.symbolIndex) }],
        isError: true,
      };
    }
    const root = rootSpan(xml, 'AxMenu');
    const elements = root ? child(xml, root, 'Elements') : null;
    const name = (root && childText(xml, root, 'Name')) || args.name;
    const label = root ? childText(xml, root, 'Label') : null;
    const tree: string[] = [];
    const counts: Counts = { submenus: 0, items: 0 };
    if (elements && !elements.selfClosed) {
      for (const c of directChildren(xml, elements.openEnd)) renderElement(xml, c, 0, tree, counts, !!args.submenusOnly);
    }
    const extensions = await readMenuExtensions(name, context.symbolIndex);
    const unread = notRead(name, extensions, context.symbolIndex);

    const lines = [
      `# AxMenu: \`${name}\``,
      '',
      ...(label ? [`**Label:** ${label}`] : []),
      `**Submenus:** ${counts.submenus} · **Items:** ${counts.items}`,
      '',
      `## ${args.submenusOnly ? 'Submenus' : 'Elements'}`,
      '',
      ...(tree.length ? tree : ['*(empty)*']),
      '',
      `## Extensions (${readOf(extensions.length, unread.count)})`,
      '',
      ...unread.lines,
      ...(extensions.length
        ? [...extensions.map(e => extensionSummary(e.name, e.xml)),
           '', `Entries of one: get_object_info(objectType="menu-extension", name="<extension>"); all: name="${name}".`]
        : ['*(none found)*']),
      '',
      `To place an item or a submenu, pass the submenu's plain name as parentMenuElement: d365fo_file(action="modify", ` +
        `objectType="menu-extension" (a standard menu) | "menu" (your own), operation="add-menu-item-to-menu" | "add-submenu").`,
    ];
    return { content: [{ type: 'text', text: capped(lines, 'Pass options {"submenusOnly": true} for the submenu tree alone.').join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting menu info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}

export async function menuExtensionInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = MenuInfoArgsSchema.parse(request.params.arguments);
    const asGiven = args.name.split('.')[0];
    const single = args.name.includes('.') ? args.name.toLowerCase() : null;
    const all = await readMenuExtensions(asGiven, context.symbolIndex);
    const shown = single ? all.filter(e => e.name.toLowerCase() === single) : all;
    if (shown.length === 0) {
      return {
        content: [{ type: 'text', text: single
          ? unreadable(`Menu extension "${args.name}"`, asGiven, context.symbolIndex)
          : SERVER_MODE === 'read-only'
            ? unreadable(`The entries of the extensions of menu "${asGiven}"`, asGiven, context.symbolIndex)
            : `No extension of menu "${asGiven}" found — not in the index, the configured model or any package folder.` }],
        isError: true,
      };
    }
    // The base menu as the extensions spell it, not as the caller typed it.
    const baseMenu = shown[0].name.split('.')[0];
    const unread = single ? { count: 0, lines: [] } : notRead(baseMenu, shown, context.symbolIndex);
    const lines: string[] = single ? [] : [`# Extensions of menu \`${baseMenu}\` (${readOf(shown.length, unread.count)})`, '', ...unread.lines];
    for (const e of shown) {
      const counts: Counts = { submenus: 0, items: 0 };
      const body: string[] = [];
      renderExtension(e.xml, body, counts, !!args.submenusOnly);
      lines.push(`${single ? '#' : '##'} AxMenuExtension: \`${e.name}\` (extends \`${baseMenu}\`)`, '');
      lines.push(`**Submenus added:** ${counts.submenus} · **Items added:** ${counts.items}`, '', ...body, '');
    }
    lines.push(`The base menu's own tree: get_object_info(objectType="menu", name="${baseMenu}").`);
    return { content: [{ type: 'text', text: capped(lines, 'Pass options {"submenusOnly": true}, or one extension\'s full name.').join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting menu extension info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
