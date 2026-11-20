/**
 * `<Tags>` (the free-text label D365FO objects and elements carry, any label: a ticket key, a project or feature name) written
 * to AOT XML as pure string in / string out, for every object type and for the elements that
 * carry the property.
 *
 * Position matters: a property written out of serialised order is dropped by the deserializer
 * without a word. The serializer writes `Name` (and `SourceCode` on objects that have it) first,
 * then the remaining scalar properties in alphabetical order, then the collections. So `Tags`
 * goes after every scalar that sorts before it and before the first scalar that sorts after it
 * or the first collection. This matches shipped XML (`TableGroup < Tags < TitleField1`,
 * `Label < Tags < Value` on an enum value). Exceptions are in {@link ROOT_BEFORE_ANCHOR} and
 * {@link FIELD_ELEMENT_ORDER}.
 */

import { FIELD_ELEMENT_ORDER, detectIndentUnit } from './tableFieldPropertyEdit.js';
import { AX_TABLE_ELEMENT_ORDER } from '../../utils/axTablePropertyOrder.js';
import { ENTITY_TOP_LEVEL_ORDER } from './dataEntityViewEdit.js';

/** Elements whose children are a collection: `Tags` is always written before the first of them. */
const COLLECTIONS = new Set([
  'ArrayElements', 'Relations', 'TableReferences', 'Fields', 'FieldGroups', 'Indexes', 'Mappings',
  'DeleteActions', 'StateMachines', 'FullTextIndexes', 'Methods', 'DataSources', 'Design', 'Parts',
  'EnumValues', 'PropertyModifications', 'Elements', 'Query', 'Metadata', 'ViewMetadata', 'Ranges',
  'DataEntityPermissions', 'DirectAccessPermissions', 'EntryPoints', 'FormControlExtensions',
  'FieldGroupExtensions', 'FieldExtensions', 'IndexExtensions', 'RelationExtensions',
  'FullTextIndexExtensions', 'MappingExtensions', 'DeleteActionExtensions', 'ControlModifications',
  'DataSourceExtensions', 'ControlExtensions', 'Duties', 'Privileges', 'SubRoles', 'Permissions',
  'Services', 'ServiceOperations', 'Operations', 'Constraints', 'ExtensionProperties', 'Actions',
  'Items', 'MenuItems', 'Customizations', 'EnumValueExtensions', 'ViewExtensions', 'Entries', 'Rules',
]);

/** Scalar properties that hold child elements; they sort alphabetically like any other scalar. */
const SCALAR_CONTAINERS = new Set(['SubscriberAccessLevel']);

/** Children that always come first, before the alphabetical scalars. */
const LEADING = new Set(['Name', 'SourceCode']);

/**
 * Roots whose `Tags` is written before a named collection rather than by the alphabetical rule.
 * AxEnumExtension serialises `EnumValues` ahead of its scalars.
 */
const ROOT_BEFORE_ANCHOR: Record<string, string> = {
  AxEnumExtension: 'PropertyModifications',
};

/**
 * Roots whose `Tags` comes right after `Name` / `SourceCode`, before every other scalar. Measured
 * on shipped XML: all 5 AxQuery files that carry Tags have it ahead of QueryType, AllowCrossCompany,
 * Interactive and UserUpdate, which the alphabetical rule would put in front of it.
 */
const ROOT_TAGS_FIRST: ReadonlySet<string> = new Set(['AxQuery']);

/** Roots whose scalar order is not alphabetical (measured on shipped XML). */
const ROOT_ORDER: Record<string, readonly string[]> = {
  AxTable: AX_TABLE_ELEMENT_ORDER,
  AxDataEntityView: ENTITY_TOP_LEVEL_ORDER,
  AxCompositeDataEntityView: ENTITY_TOP_LEVEL_ORDER,
};

/**
 * Roots whose `<Tags>` position was verified (round-trip over shipped XML) or derived from the
 * serializer rule. Anything else (reports, macros, label-file descriptors, model descriptors, …) is
 * refused rather than guessed: an element in the wrong place is dropped without a word.
 */
export const TAGGABLE_ROOTS: ReadonlySet<string> = new Set([
  'AxTable', 'AxEnum', 'AxEdt', 'AxClass', 'AxForm', 'AxQuery', 'AxView', 'AxMap', 'AxDataEntityView',
  'AxCompositeDataEntityView', 'AxMenu', 'AxMenuItemDisplay', 'AxMenuItemAction', 'AxMenuItemOutput',
  'AxSecurityPrivilege', 'AxSecurityDuty', 'AxSecurityRole', 'AxService', 'AxServiceGroup',
  'AxConfigurationKey', 'AxTile', 'AxResource',
  'AxTableExtension', 'AxEnumExtension', 'AxFormExtension', 'AxDataEntityViewExtension',
  'AxSecurityDutyExtension', 'AxSecurityRoleExtension', 'AxMenuExtension', 'AxEdtExtension',
  'AxMenuItemDisplayExtension', 'AxMenuItemActionExtension', 'AxMenuItemOutputExtension',
  'AxViewExtension', 'AxMapExtension', 'AxQuerySimpleExtension',
]);

export type TagsMode = 'replace' | 'add' | 'remove';

/** Kinds of element (inside an object) that carry `Tags`. */
export type TagsElementKind =
  | 'field' | 'enum-value' | 'relation' | 'constraint' | 'index' | 'field-group' | 'method';

export interface TagsEditResult {
  ok: boolean;
  xml: string;
  changed: boolean;
  /** What is in the file after the edit (`undefined`: no Tags element). */
  tags?: string;
  message: string;
}

// ── value handling ──────────────────────────────────────────────────────────────────────────

const splitTags = (s: string): string[] =>
  s.split(/[,;]/).map(t => t.trim()).filter(Boolean);

/** "A, B" from a string (comma or semicolon separated) or an array. '' stays '' (meaning: none). */
export function normalizeTagsInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const parts = Array.isArray(input) ? input.flatMap(v => splitTags(String(v))) : splitTags(String(input));
  return [...new Set(parts)].join(', ');
}

/** Combine the tag already on an object with the one asked for. Returns '' when nothing is left. */
export function combineTags(existing: string | undefined, incoming: string, mode: TagsMode): string {
  const have = existing ? splitTags(existing) : [];
  const want = splitTags(incoming);
  if (mode === 'replace') return [...new Set(want)].join(', ');
  if (mode === 'add') {
    const seen = new Set<string>();
    return [...have, ...want].filter(t => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).join(', ');
  }
  const drop = new Set(want.map(t => t.toLowerCase()));
  return have.filter(t => !drop.has(t.toLowerCase())).join(', ');
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ── a tolerant child scanner ────────────────────────────────────────────────────────────────

interface Child {
  name: string;
  /** Offset of `<`. */
  start: number;
  /** Offset just past the closing `>`. */
  end: number;
  selfClosing: boolean;
  hasChildElements: boolean;
  /** Offset just past the opening tag, and of the closing tag (equal to `end` when self-closing). */
  innerStart: number;
  innerEnd: number;
}

const TOKEN =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** Direct child elements of the range [from, to) (the inside of a parent element). */
function childrenOf(xml: string, from: number, to: number): Child[] {
  const out: Child[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  re.lastIndex = from;
  let depth = 0;
  let cur: Child | null = null;
  for (let m = re.exec(xml); m && m.index < to; m = re.exec(xml)) {
    if (m[2] === undefined) continue; // CDATA / comment / PI
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    if (!closing) {
      if (depth === 0) {
        cur = {
          name: m[2], start: m.index, end: m.index + m[0].length, selfClosing,
          hasChildElements: false, innerStart: m.index + m[0].length, innerEnd: m.index + m[0].length,
        };
        if (selfClosing) out.push(cur);
      } else if (depth === 1 && cur) {
        cur.hasChildElements = true;
      }
      if (!selfClosing) depth++;
    } else {
      depth--;
      if (depth === 0 && cur) {
        cur.end = m.index + m[0].length;
        cur.innerEnd = m.index;
        out.push(cur);
        cur = null;
      }
      if (depth < 0) break;
    }
  }
  return out;
}

interface Root { name: string; node: Child }

function findRoot(xml: string): Root | null {
  const m = /<(Ax\w+)\b[^>]*?(\/?)>/.exec(xml);
  if (!m || m[2] === '/') return null;
  const close = xml.lastIndexOf(`</${m[1]}>`);
  if (close < 0) return null;
  const start = m.index;
  const innerStart = start + m[0].length;
  return {
    name: m[1],
    node: { name: m[1], start, end: close + m[1].length + 3, selfClosing: false, hasChildElements: true, innerStart, innerEnd: close },
  };
}

const textOf = (xml: string, c: Child) => unescapeText(xml.slice(c.innerStart, c.innerEnd));

const isCollection = (c: Child) =>
  COLLECTIONS.has(c.name) || (c.hasChildElements && !SCALAR_CONTAINERS.has(c.name) && !LEADING.has(c.name));

type Placement =
  | { kind: 'alpha'; anchor?: string }
  | { kind: 'after-leading' }
  | { kind: 'order'; order: readonly string[] }
  | { kind: 'after-name' };

/** Index of the child to insert in front of; `-1` = append after the last child. */
function insertionIndex(children: Child[], place: Placement): number {
  if (place.kind === 'after-name') {
    const n = children.findIndex(c => c.name === 'Name');
    return n + 1 < children.length ? n + 1 : -1;
  }
  if (place.kind === 'after-leading') {
    const i = children.findIndex(c => !LEADING.has(c.name));
    return i;
  }
  if (place.kind === 'order') {
    const tagsAt = place.order.indexOf('Tags');
    for (let i = 0; i < children.length; i++) {
      const at = place.order.indexOf(children[i].name);
      if (at > tagsAt || (at < 0 && isCollection(children[i]))) return i;
    }
    return -1;
  }
  if (place.anchor) {
    const a = children.findIndex(c => c.name === place.anchor);
    return a;
  }
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (LEADING.has(c.name)) continue;
    if (isCollection(c) || c.name > 'Tags') return i;
  }
  return -1;
}

const eolOf = (xml: string) => (xml.includes('\r\n') ? '\r\n' : '\n');

function lineStart(xml: string, offset: number): number {
  const nl = xml.lastIndexOf('\n', offset - 1);
  return nl + 1;
}

/** Indentation of the line the offset is on, when only whitespace precedes it. */
function indentAt(xml: string, offset: number): string | null {
  const before = xml.slice(lineStart(xml, offset), offset);
  return /^[ \t]*$/.test(before) ? before : null;
}

/**
 * Set, replace or remove `<Tags>` among the direct children of one element.
 * `parent` is the element's own span; `parentIndent` is its indentation.
 */
function applyToElement(
  xml: string,
  parent: Child,
  place: Placement,
  value: string | null,
  mode: TagsMode,
): { xml: string; changed: boolean; tags?: string } | null {
  if (parent.selfClosing) return null;
  const children = childrenOf(xml, parent.innerStart, parent.innerEnd);
  const existing = children.find(c => c.name === 'Tags');
  const current = existing && !existing.selfClosing ? textOf(xml, existing) : existing ? '' : undefined;

  // What the element should end up holding.
  let next: string;
  if (value === null) next = '';
  else next = combineTags(current, value, mode);

  if (existing) {
    if (next === '') {
      // Drop the whole line when the element is alone on it.
      const ls = lineStart(xml, existing.start);
      let from = existing.start;
      let to = existing.end;
      const lead = xml.slice(ls, existing.start);
      const trail = /^[ \t]*\r?\n/.exec(xml.slice(existing.end));
      if (/^[ \t]*$/.test(lead) && trail) { from = ls; to = existing.end + trail[0].length; }
      return { xml: xml.slice(0, from) + xml.slice(to), changed: true, tags: undefined };
    }
    if (current === next && !existing.selfClosing) return { xml, changed: false, tags: next };
    const text = `<Tags>${escapeText(next)}</Tags>`;
    return { xml: xml.slice(0, existing.start) + text + xml.slice(existing.end), changed: true, tags: next };
  }
  if (next === '') return { xml, changed: false, tags: undefined };

  const eol = eolOf(xml);
  const at = insertionIndex(children, place);
  const text = `<Tags>${escapeText(next)}</Tags>`;
  const parentIndent = indentAt(xml, parent.start) ?? '';
  const unit = detectIndentUnit(xml);

  if (at >= 0) {
    const ref = children[at];
    const indent = indentAt(xml, ref.start);
    if (indent !== null) {
      const ls = lineStart(xml, ref.start);
      return { xml: xml.slice(0, ls) + indent + text + eol + xml.slice(ls), changed: true, tags: next };
    }
    return { xml: xml.slice(0, ref.start) + text + xml.slice(ref.start), changed: true, tags: next };
  }
  // Append: after the last child, in front of the closing tag.
  const last = children[children.length - 1];
  if (last) {
    const indent = indentAt(xml, last.start) ?? parentIndent + unit;
    const ls = lineStart(xml, parent.innerEnd);
    const closingOnOwnLine = indentAt(xml, parent.innerEnd) !== null;
    if (closingOnOwnLine) {
      return { xml: xml.slice(0, ls) + indent + text + eol + xml.slice(ls), changed: true, tags: next };
    }
    return { xml: xml.slice(0, last.end) + text + xml.slice(last.end), changed: true, tags: next };
  }
  // No children at all.
  const inner = xml.slice(parent.innerStart, parent.innerEnd);
  const body = eol + parentIndent + unit + text + eol + parentIndent;
  return { xml: xml.slice(0, parent.innerStart) + body + xml.slice(parent.innerStart + inner.length), changed: true, tags: next };
}

const failure = (xml: string, message: string): TagsEditResult => ({ ok: false, xml, changed: false, message });

const describeResult = (what: string, r: { changed: boolean; tags?: string }) =>
  r.tags
    ? r.changed ? `${what}: Tags set to "${r.tags}"` : `${what}: Tags already "${r.tags}"`
    : r.changed ? `${what}: Tags removed` : `${what}: no Tags to remove`;

// ── object level ────────────────────────────────────────────────────────────────────────────

/** The root element name (`AxTable`, …) of an AOT XML document. */
export function rootElementName(xml: string): string | null {
  return findRoot(xml)?.name ?? null;
}

/** Current `<Tags>` of the object (undefined when absent). */
export function readObjectTags(xml: string): string | undefined {
  const root = findRoot(xml);
  if (!root) return undefined;
  const t = childrenOf(xml, root.node.innerStart, root.node.innerEnd).find(c => c.name === 'Tags');
  return t ? textOf(xml, t) : undefined;
}

/**
 * Set the Tags of the object itself. `value === null` (or '' with mode replace) removes it.
 * `mode` add / remove combine with what is there.
 */
export function setObjectTags(xml: string, value: string | null, mode: TagsMode = 'replace'): TagsEditResult {
  const root = findRoot(xml);
  if (!root) return failure(xml, 'no Ax* root element found');
  if (!TAGGABLE_ROOTS.has(root.name)) return failure(xml, `unsupported: Tags position is not known for ${root.name}`);
  // An object-level property of a data entity is written by upsertDataEntityProperty; same position.
  const order = ROOT_ORDER[root.name];
  const place: Placement = ROOT_TAGS_FIRST.has(root.name) ? { kind: 'after-leading' }
    : order ? { kind: 'order', order } : { kind: 'alpha', anchor: ROOT_BEFORE_ANCHOR[root.name] };
  const r = applyToElement(xml, root.node, place, value, mode);
  if (!r) return failure(xml, `${root.name} has no content`);
  return { ok: true, ...r, message: describeResult(root.name, r) };
}

// ── element level ───────────────────────────────────────────────────────────────────────────

const ELEMENT_PATH: Record<TagsElementKind, { collection: string }> = {
  field: { collection: 'Fields' },
  'enum-value': { collection: 'EnumValues' },
  relation: { collection: 'Relations' },
  constraint: { collection: 'Constraints' },
  index: { collection: 'Indexes' },
  'field-group': { collection: 'FieldGroups' },
  method: { collection: 'Methods' },
};

const nameOf = (xml: string, el: Child): string | undefined => {
  const n = childrenOf(xml, el.innerStart, el.innerEnd).find(c => c.name === 'Name');
  return n ? textOf(xml, n).trim() : undefined;
};

/** Locate a named element of `kind`; for a constraint, `parentName` is the relation it sits in. */
function findElement(xml: string, kind: TagsElementKind, name: string, parentName?: string): Child | null | 'ambiguous' {
  const root = findRoot(xml);
  if (!root) return null;
  const search = (from: number, to: number, path: string[]): Child[] => {
    const hits: Child[] = [];
    for (const c of childrenOf(xml, from, to)) {
      if (path.length === 1) {
        if (c.name === path[0]) {
          for (const el of childrenOf(xml, c.innerStart, c.innerEnd)) {
            if ((nameOf(xml, el) ?? '').toLowerCase() === name.toLowerCase()) hits.push(el);
          }
        }
      } else if (c.name === path[0]) {
        hits.push(...search(c.innerStart, c.innerEnd, path.slice(1)));
      }
    }
    return hits;
  };

  const { collection } = ELEMENT_PATH[kind];
  let hits: Child[];
  if (kind === 'method') {
    hits = search(root.node.innerStart, root.node.innerEnd, ['SourceCode', 'Methods']);
    if (hits.length === 0) hits = search(root.node.innerStart, root.node.innerEnd, ['Methods']);
  } else if (kind === 'constraint') {
    const rels: Child[] = [];
    for (const c of childrenOf(xml, root.node.innerStart, root.node.innerEnd)) {
      if (c.name !== 'Relations') continue;
      for (const r of childrenOf(xml, c.innerStart, c.innerEnd)) {
        if (!parentName || (nameOf(xml, r) ?? '').toLowerCase() === parentName.toLowerCase()) rels.push(r);
      }
    }
    hits = rels.flatMap(r => search(r.innerStart, r.innerEnd, ['Constraints']));
  } else {
    hits = search(root.node.innerStart, root.node.innerEnd, [collection]);
  }
  if (hits.length === 0) return null;
  return hits.length > 1 ? 'ambiguous' : hits[0];
}

const TABLE_FIELD_ROOTS = new Set(['AxTable', 'AxTableExtension']);
const ENTITY_FIELD_ROOTS = new Set(['AxDataEntityView', 'AxDataEntityViewExtension', 'AxCompositeDataEntityView']);

/** Where `Tags` goes in an element of `kind`, or null when this root's element order is not known. */
const placementFor = (kind: TagsElementKind, rootName: string): Placement | null => {
  if (kind === 'field') {
    if (TABLE_FIELD_ROOTS.has(rootName)) return { kind: 'order', order: FIELD_ELEMENT_ORDER };
    if (ENTITY_FIELD_ROOTS.has(rootName)) return { kind: 'after-name' }; // Name, Tags, DataField, …
    return null;
  }
  return kind === 'constraint' ? { kind: 'after-name' } : { kind: 'alpha' };
};

/**
 * Set, replace or remove the Tags of one element of an object. `value === null` removes.
 * `parentName` names the relation a constraint belongs to.
 */
export function setElementTags(
  xml: string,
  kind: TagsElementKind,
  name: string,
  value: string | null,
  mode: TagsMode = 'replace',
  parentName?: string,
): TagsEditResult {
  const el = findElement(xml, kind, name, parentName);
  if (el === 'ambiguous') return failure(xml, `${kind} '${name}' appears more than once`);
  if (!el) return failure(xml, `${kind} '${name}' not found`);
  const place = placementFor(kind, rootElementName(xml) ?? '');
  if (!place) return failure(xml, `${kind} Tags are not supported on ${rootElementName(xml)}`);
  const r = applyToElement(xml, el, place, value, mode);
  if (!r) return failure(xml, `${kind} '${name}' is empty`);
  return { ok: true, ...r, message: describeResult(`${kind} ${name}`, r) };
}

/** Current Tags of one element (undefined when it has none or is not found). */
export function readElementTags(xml: string, kind: TagsElementKind, name: string, parentName?: string): string | undefined {
  const el = findElement(xml, kind, name, parentName);
  if (!el || el === 'ambiguous' || el.selfClosing) return undefined;
  const t = childrenOf(xml, el.innerStart, el.innerEnd).find(c => c.name === 'Tags');
  return t ? textOf(xml, t) : undefined;
}

/** Names of the constraints of a relation (to tag them with the relation). */
export function constraintNamesOf(xml: string, relationName: string): string[] {
  const root = findRoot(xml);
  if (!root) return [];
  const names: string[] = [];
  for (const c of childrenOf(xml, root.node.innerStart, root.node.innerEnd)) {
    if (c.name !== 'Relations') continue;
    for (const r of childrenOf(xml, c.innerStart, c.innerEnd)) {
      if ((nameOf(xml, r) ?? '').toLowerCase() !== relationName.toLowerCase()) continue;
      for (const k of childrenOf(xml, r.innerStart, r.innerEnd)) {
        if (k.name !== 'Constraints') continue;
        for (const con of childrenOf(xml, k.innerStart, k.innerEnd)) {
          const n = nameOf(xml, con);
          if (n) names.push(n);
        }
      }
    }
  }
  return names;
}
