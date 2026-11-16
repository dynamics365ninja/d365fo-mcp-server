/**
 * Minimal text edits to an existing .rnrproj.
 *
 * ProjectFileManager used to parse the project with xml2js and write the whole
 * file back with the xml2js Builder. Only the BOM and the line endings survived
 * that (#1197). Everything else was serialised again: `<TargetFrameworkProfile />`
 * lost its space, every `<Folder Include="…" />` too, a multi-line value picked up
 * `&#xD;` entities, attributes and elements were laid out the builder's way. A pull
 * request that added one object to a project showed the whole project file as
 * changed, and teams cleaned those diffs up by hand.
 *
 * This module edits the text instead. It finds element ranges with a small tag
 * scanner (enough for an MSBuild project: elements, attributes, comments, CDATA,
 * processing instructions) and splices whole lines in or out, with the
 * indentation of the neighbouring items. Every byte it does not insert or remove
 * stays as it was.
 *
 * Placement follows MSBuild's own construction API, which Visual Studio uses to
 * write these items (Microsoft.Build.Construction):
 *  - ProjectItemGroupElement.AddItem: "Adds a new item ordered by include" among
 *    the items of the same type in the group. The item goes before the first item
 *    whose Include sorts after it (ordinal, ignoring case), otherwise after the
 *    last one. A project VS keeps sorted stays sorted.
 *  - ProjectRootElement.AddItemGroup: a new item group goes after the last item
 *    group, else after the last property group, else at the end of the project.
 *  - Removing the last item of an item group removes the group too, which is
 *    what MSBuild does when an item is removed through the evaluation model.
 */

import { normalizeInclude } from './projectMembership.js';

export type Eol = '\r\n' | '\n';

interface XmlElement {
  name: string;
  /** Offset of `<`. */
  start: number;
  /** Offset just past the closing `>` of the whole element. */
  end: number;
  /** Offset just past the start tag's `>`. */
  openEnd: number;
  /** Offset of the closing tag's `<`, or `end` for a self-closing element. */
  closeStart: number;
  attrs: Record<string, string>;
  children: XmlElement[];
}

/** One item to write: `<Folder Include="…" />` or `<Content Include="…">…</Content>`. */
export interface ProjectItemSpec {
  type: 'Folder' | 'Content';
  include: string;
  /** Child metadata elements, in order. Empty renders a self-closing item. */
  metadata: Array<[string, string]>;
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e];
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** The `<Project>` root element, with its element tree. Throws on unbalanced tags. */
function parseProject(text: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const name = m[2];
    if (!name) continue; // comment, CDATA, doctype, processing instruction
    if (m[1]) {
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error('Invalid .rnrproj file structure');
      open.closeStart = m.index;
      open.end = m.index + m[0].length;
      continue;
    }
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    for (let a = ATTR.exec(m[3]); a; a = ATTR.exec(m[3])) {
      attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
    }
    const el: XmlElement = {
      name, start: m.index, end: m.index + m[0].length, openEnd: m.index + m[0].length,
      closeStart: m.index + m[0].length, attrs, children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    if (!m[4]) stack.push(el);
  }
  if (stack.length > 0 || !root || root.name !== 'Project') throw new Error('Invalid .rnrproj file structure');
  return root;
}

function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

/** The whitespace an element's line starts with, or null when other text precedes it. */
function indentOf(text: string, pos: number): string | null {
  const prefix = text.slice(lineStartOf(text, pos), pos);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

/** Offset just past the line break that ends `pos`'s line, when only whitespace follows `pos`. */
function endOfLineAfter(text: string, pos: number): number | null {
  const m = /^[ \t]*(\r?\n|$)/.exec(text.slice(pos));
  return m ? pos + m[0].length : null;
}

function itemGroups(root: XmlElement): XmlElement[] {
  return root.children.filter(c => c.name === 'ItemGroup');
}

function renderItem(spec: ProjectItemSpec, indent: string, childIndent: string, eol: Eol): string {
  const open = `${indent}<${spec.type} Include="${escapeAttr(spec.include)}"`;
  if (spec.metadata.length === 0) return `${open} />`;
  const children = spec.metadata.map(([k, v]) => `${childIndent}<${k}>${escapeText(v)}</${k}>`);
  return [`${open}>`, ...children, `${indent}</${spec.type}>`].join(eol);
}

/** Insert whole `block` lines (already indented) above the line holding offset `pos`. */
function insertBefore(text: string, pos: number, block: string, eol: Eol): string {
  if (indentOf(text, pos) !== null) {
    const at = lineStartOf(text, pos);
    return text.slice(0, at) + block + eol + text.slice(at);
  }
  return text.slice(0, pos) + block.trimStart() + eol + text.slice(pos);
}

/** Insert whole `block` lines (already indented) below element `el`'s last line. */
function insertAfter(text: string, el: XmlElement, block: string, eol: Eol): string {
  const lineEnd = /^[ \t]*\r?\n/.exec(text.slice(el.end));
  if (lineEnd) {
    const at = el.end + lineEnd[0].length;
    return text.slice(0, at) + block + eol + text.slice(at);
  }
  return text.slice(0, el.end) + eol + block + text.slice(el.end);
}

/** The indentation step the file uses, taken from the root's first child. */
function indentUnit(text: string, root: XmlElement): string {
  const first = root.children[0];
  const rootIndent = indentOf(text, root.start) ?? '';
  const childIndent = first ? indentOf(text, first.start) : null;
  if (childIndent && childIndent.startsWith(rootIndent) && childIndent.length > rootIndent.length) {
    return childIndent.slice(rootIndent.length);
  }
  return '  ';
}

/** Normalised Includes of every item of `type` in the project's item groups. */
export function listProjectIncludes(text: string, type: string): string[] {
  const out: string[] = [];
  for (const group of itemGroups(parseProject(text))) {
    for (const item of group.children) {
      if (item.name === type && typeof item.attrs.Include === 'string') out.push(normalizeInclude(item.attrs.Include));
    }
  }
  return out;
}

/**
 * `text` with `spec` added as one item. The item goes into the first item group
 * that already holds items of its type, sorted by Include among them. Without
 * such a group, a new one is added (see the module comment for where). The
 * caller checks for duplicates first (listProjectIncludes).
 */
export function insertProjectItem(text: string, spec: ProjectItemSpec, eol: Eol): string {
  const root = parseProject(text);
  const unit = indentUnit(text, root);
  const groups = itemGroups(root);
  const group = groups.find(g => g.children.some(c => c.name === spec.type));

  if (group) {
    const same = group.children.filter(c => c.name === spec.type);
    const groupIndent = indentOf(text, group.start) ?? '';
    const itemIndent = indentOf(text, same[0].start) ?? groupIndent + unit;
    // Metadata indentation from an existing item that has some, else one step in.
    const withChildren = group.children.find(c => c.children.length > 0);
    const childIndent = (withChildren && indentOf(text, withChildren.children[0].start)) ?? itemIndent + unit;
    const block = renderItem(spec, itemIndent, childIndent, eol);
    // .NET OrdinalIgnoreCase compares upper-cased code units. Lower-casing would
    // order `_` and `\` differently against letters.
    const key = spec.include.toUpperCase();
    const next = same.find(c => (c.attrs.Include ?? '').toUpperCase() > key);
    return next
      ? insertBefore(text, next.start, block, eol)
      : insertAfter(text, same[same.length - 1], block, eol);
  }

  const lastOf = (name: string) => root.children.filter(c => c.name === name).pop();
  const anchor = groups[groups.length - 1] ?? lastOf('PropertyGroup');
  const indent = (anchor ? indentOf(text, anchor.start) : null) ?? (indentOf(text, root.start) ?? '') + unit;
  const block = [
    `${indent}<ItemGroup>`,
    renderItem(spec, indent + unit, indent + unit + unit, eol),
    `${indent}</ItemGroup>`,
  ].join(eol);
  return anchor ? insertAfter(text, anchor, block, eol) : insertBefore(text, root.closeStart, block, eol);
}

/** `[start, end)` widened to whole lines when the range stands on lines of its own. */
function lineRange(text: string, start: number, end: number): [number, number] {
  const after = endOfLineAfter(text, end);
  if (indentOf(text, start) !== null && after !== null) return [lineStartOf(text, start), after];
  return [start, end];
}

/**
 * `text` without the items of `type` whose normalised Include `matches` accepts,
 * each with its own line(s). An item group left with no items is removed as
 * well. Returns the number of items removed (0 leaves `text` untouched).
 */
export function removeProjectItems(
  text: string,
  type: string,
  matches: (normalizedInclude: string) => boolean,
): { text: string; removed: number } {
  const ranges: Array<[number, number]> = [];
  let removed = 0;
  for (const group of itemGroups(parseProject(text))) {
    const hits = group.children.filter(c =>
      c.name === type && typeof c.attrs.Include === 'string' && matches(normalizeInclude(c.attrs.Include)));
    if (hits.length === 0) continue;
    removed += hits.length;
    // Anything left between the group's tags besides these items (other items,
    // comments, text) keeps the group.
    let rest = '';
    let cursor = group.openEnd;
    for (const hit of hits) {
      rest += text.slice(cursor, hit.start);
      cursor = hit.end;
    }
    rest += text.slice(cursor, group.closeStart);
    if (hits.length === group.children.length && rest.trim() === '') {
      ranges.push(lineRange(text, group.start, group.end));
    } else {
      for (const hit of hits) ranges.push(lineRange(text, hit.start, hit.end));
    }
  }
  let out = text;
  for (const [s, e] of ranges.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(e);
  return { text: out, removed };
}
