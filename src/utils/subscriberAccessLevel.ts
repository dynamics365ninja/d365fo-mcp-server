/**
 * AxTable `SubscriberAccessLevel` — "Subscriber access level" in the Visual
 * Studio property sheet.
 *
 * Not a scalar like the rest of the property block: the metamodel type is
 * `AccessGrant`, six permissions each `Unset | Allow | Deny`, and the
 * serializer writes only the ones that are set, as child elements in
 * alphabetical order:
 *
 *   <SubscriberAccessLevel>
 *     <Read>Allow</Read>
 *   </SubscriberAccessLevel>
 *
 * All-Unset (the metamodel default) is written as no element at all.
 *
 * Visual Studio sets Read=Allow on every new regular table, and that is by far
 * the commonest value in shipped and partner metadata. Data entity staging
 * tables carry none (156 of 4,619 shipped ones have the element).
 *
 * TempDB/InMemory tables get none here, but that is a choice, not a measured
 * rule: of 18,467 shipped tables, 617 of 2,705 TempDB/InMemory tables carry
 * Read=Allow — about the same share as regular tables, most of which predate
 * the VS default and carry nothing. On a temporary table the grant has no
 * effect either way, so leaving it out keeps the file minimal. This server wrote none either,
 * and had no way to set one: the scalar property writer cannot express child
 * elements, and the name was not in the AxTable element order, so it was
 * dropped (issue #1073).
 */

/** The AccessGrant permissions, in the order the serializer writes them. */
export const SUBSCRIBER_PERMISSIONS = ['Correct', 'Create', 'Delete', 'Invoke', 'Read', 'Update'] as const;
export type SubscriberPermission = (typeof SUBSCRIBER_PERMISSIONS)[number];
export type SubscriberGrant = 'Allow' | 'Deny';
export type SubscriberAccessLevel = Partial<Record<SubscriberPermission, SubscriberGrant>>;

/** What Visual Studio writes on a new regular table. */
export const DEFAULT_SUBSCRIBER_ACCESS_LEVEL: SubscriberAccessLevel = { Read: 'Allow' };

export type ParsedSubscriberAccessLevel =
  | { ok: true; level: SubscriberAccessLevel }
  | { ok: false; error: string };

const USAGE =
  'Pass an object such as { "read": "Allow" } or { "read": "Allow", "create": "Deny" }, ' +
  'the same as a string "Read=Allow,Create=Deny", "No Access" for every permission denied, ' +
  'or "None" for no access level. ' +
  `Permissions: ${SUBSCRIBER_PERMISSIONS.join(', ')}; values: Allow, Deny, Unset.`;

function permissionOf(key: string): SubscriberPermission | undefined {
  return SUBSCRIBER_PERMISSIONS.find(p => p.toLowerCase() === key.trim().toLowerCase());
}

/** Allow / Deny, null for Unset (leave it out), undefined when not a valid value. */
function grantOf(raw: unknown): SubscriberGrant | null | undefined {
  if (raw === true) return 'Allow';
  if (raw === false) return 'Deny';
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'allow' || v === 'yes') return 'Allow';
  if (v === 'deny' || v === 'no') return 'Deny';
  if (v === 'unset' || v === '') return null;
  return undefined;
}

/**
 * A caller's `subscriberAccessLevel` value, in any of the accepted spellings.
 * An empty result means "no access level": the element is left out.
 */
export function parseSubscriberAccessLevel(raw: unknown): ParsedSubscriberAccessLevel {
  let entries: Array<[string, unknown]>;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^(none|unset)?$/i.test(s)) return { ok: true, level: {} };
    // "No Access" is how the property sheet and xppbp name every permission denied.
    if (/^no\s*access$/i.test(s)) {
      return { ok: true, level: Object.fromEntries(SUBSCRIBER_PERMISSIONS.map(p => [p, 'Deny'])) as SubscriberAccessLevel };
    }
    // A bare permission list ("Read" / "Read,Update") grants Allow, as the
    // property sheet's commonest setting does.
    entries = s
      .split(/[,;]/)
      .filter(p => p.trim())
      .map(p => {
        const [k, v] = p.split(/[=:]/);
        return [k, v === undefined ? 'Allow' : v];
      });
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    entries = Object.entries(raw as Record<string, unknown>);
  } else {
    return { ok: false, error: `Invalid subscriberAccessLevel ${JSON.stringify(raw)}. ${USAGE}` };
  }

  const level: SubscriberAccessLevel = {};
  for (const [key, value] of entries) {
    const permission = permissionOf(key);
    if (!permission) return { ok: false, error: `Unknown subscriber permission '${key.trim()}'. ${USAGE}` };
    const grant = grantOf(value);
    if (grant === undefined) {
      return {
        ok: false,
        error: `Invalid value ${JSON.stringify(value)} for subscriber permission ${permission}. ${USAGE}`,
      };
    }
    if (grant) level[permission] = grant;
    else delete level[permission];
  }
  return { ok: true, level };
}

/**
 * A modify-property / bridge value: the parse of a "Read=Allow,…" string, a
 * JSON object string, or an object, and the "Read=Allow,Create=Deny" / "None"
 * text the bridge's property setter reads.
 */
export function subscriberAccessLevelValue(
  raw: unknown,
): { ok: true; level: SubscriberAccessLevel; bridgeText: string } | { ok: false; error: string } {
  let value = raw;
  if (typeof raw === 'string' && /^\s*\{/.test(raw)) {
    try { value = JSON.parse(raw); } catch { /* reported as invalid by the parse */ }
  }
  const parsed = parseSubscriberAccessLevel(value);
  if (!parsed.ok) return parsed;
  const set = SUBSCRIBER_PERMISSIONS.filter(p => parsed.level[p]).map(p => `${p}=${parsed.level[p]}`);
  return { ok: true, level: parsed.level, bridgeText: set.length > 0 ? set.join(',') : 'None' };
}

/**
 * The `<SubscriberAccessLevel>` element at `indent`, children one level deeper.
 * '' for an empty level — the serializer writes nothing for all-Unset.
 */
export function renderSubscriberAccessLevel(
  level: SubscriberAccessLevel,
  indent = '\t',
  childIndent = indent + (/^ +$/.test(indent) ? indent : '\t'),
): string {
  const children = SUBSCRIBER_PERMISSIONS.filter(p => level[p]).map(p => `${childIndent}<${p}>${level[p]}</${p}>`);
  if (children.length === 0) return '';
  return `${indent}<SubscriberAccessLevel>\n${children.join('\n')}\n${indent}</SubscriberAccessLevel>`;
}

/** `s` as a literal regex fragment. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The table-level `<SubscriberAccessLevel>` element, with its line. */
const TABLE_LEVEL_ELEMENT =
  /^([ \t]*)<SubscriberAccessLevel\s*\/>[ \t]*\r?\n?|^([ \t]*)<SubscriberAccessLevel>[\s\S]*?<\/SubscriberAccessLevel>[ \t]*\r?\n?/m;

/**
 * Where the table's own property block ends: the first collection element.
 * An access level further down belongs to something else in the table.
 */
function propertyBlockEnd(xml: string): number {
  const m = /^[ \t]*<(DeleteActions|FieldGroups|Fields|FullTextIndexes|Indexes|Mappings|Relations|StateMachines)[\s/>]/m.exec(
    xml,
  );
  return m ? m.index : xml.length;
}

/** The access level an AxTable document declares ({} when it has none). */
export function readSubscriberAccessLevel(xml: string): SubscriberAccessLevel {
  const m = /<SubscriberAccessLevel>([\s\S]*?)<\/SubscriberAccessLevel>/.exec(xml.slice(0, propertyBlockEnd(xml)));
  const level: SubscriberAccessLevel = {};
  if (!m) return level;
  for (const p of SUBSCRIBER_PERMISSIONS) {
    const v = new RegExp(`<${p}>\\s*(Allow|Deny)\\s*</${p}>`).exec(m[1])?.[1];
    if (v === 'Allow' || v === 'Deny') level[p] = v;
  }
  return level;
}

export function sameSubscriberAccessLevel(a: SubscriberAccessLevel, b: SubscriberAccessLevel): boolean {
  return SUBSCRIBER_PERMISSIONS.every(p => a[p] === b[p]);
}

/** "Read=Allow, Create=Deny", or "none". */
export function describeSubscriberAccessLevel(level: SubscriberAccessLevel): string {
  const parts = SUBSCRIBER_PERMISSIONS.filter(p => level[p]).map(p => `${p}=${level[p]}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** Whether an AxTable document is a TempDB / InMemory table, which carries no access level. */
export function isTempAxTable(xml: string): boolean {
  return /<TableType>\s*(TempDB|InMemory)\s*<\/TableType>/i.test(xml);
}

/**
 * The access level a NEW table gets: the caller's, when one was passed and is
 * valid; otherwise what xppbp expects (src/utils/bpCreateDefaults.ts): No Access
 * (every permission denied) on a TempDB/InMemory or Staging table, Read=Allow on
 * any other. Undefined for an invalid value, which the create reconcile reports.
 */
export function tableSubscriberAccessLevel(
  requested: unknown,
  tableType: unknown,
  tableGroup?: unknown,
): SubscriberAccessLevel | undefined {
  if (requested !== undefined && requested !== null) {
    const parsed = parseSubscriberAccessLevel(requested);
    return parsed.ok ? parsed.level : undefined;
  }
  const localOnly =
    /^(TempDB|InMemory)$/i.test(String(tableType ?? '').trim()) || /^staging$/i.test(String(tableGroup ?? '').trim());
  return localOnly
    ? (Object.fromEntries(SUBSCRIBER_PERMISSIONS.map(p => [p, 'Deny'])) as SubscriberAccessLevel)
    : { ...DEFAULT_SUBSCRIBER_ACCESS_LEVEL };
}

/**
 * Table-level elements that come BEFORE SubscriberAccessLevel wherever they
 * appear. Measured on 3,670 shipped tables: inserting right after the last of
 * these reproduces the serialized position in all but 30, which carry
 * AllowRowVersionChangeTracking or DisableLockEscalation (seen on both sides)
 * ahead of it. Anchoring on the first known SUCCESSOR instead misplaced 279:
 * elements outside the canonical order list (Visible, Visibility, Extends,
 * AllowChangeTracking, …) sit between it and the next listed one.
 */
const PREDECESSORS = [
  'Name', 'SourceCode', 'Label', 'DeveloperDocumentation', 'ConfigurationKey', 'OperationalDomain',
  'FormRef', 'CountryRegionCodes', 'SingularLabel', 'IsObsolete', 'EntityRelationshipType',
  'ListPageRef', 'CountryRegionContextField', 'ReportRef', 'PreviewPartRef',
];

/**
 * Write `level` as the AxTable's access level, replacing any existing one, or
 * remove it when `level` is empty. A new element goes directly after the last
 * table-level predecessor (always at least <Name>), at table-level indentation —
 * never inside a field or the X++ source. Null when the document is not an
 * AxTable.
 */
export function setSubscriberAccessLevel(xml: string, level: SubscriberAccessLevel): string | null {
  if (!/<AxTable[\s>]/.test(xml)) return null;
  const eol = /\r\n/.test(xml) ? '\r\n' : '\n';
  const blockEnd = propertyBlockEnd(xml);
  const existing = TABLE_LEVEL_ELEMENT.exec(xml.slice(0, blockEnd));
  if (existing) {
    const indent = existing[1] ?? existing[2] ?? '\t';
    // Keep the file's own child indentation (tabs, or spaces in a hand-edited file).
    const childIndent = /\n([ \t]+)</.exec(existing[0])?.[1];
    const rendered = renderSubscriberAccessLevel(level, indent, childIndent);
    const replacement = rendered ? rendered.replace(/\n/g, eol) + eol : '';
    return xml.slice(0, existing.index) + replacement + xml.slice(existing.index + existing[0].length);
  }
  if (!renderSubscriberAccessLevel(level)) return xml;

  // Table-level indentation is the table name's: <Name> is the first child.
  const nameLine = /^([ \t]*)<Name>/m.exec(xml);
  if (!nameLine) return null;
  const indent = nameLine[1] || '\t';
  const head = xml.slice(0, blockEnd);
  let insertAt = -1;
  // The indent and tag come from the document; escaped before they become a pattern.
  const indentRe = escapeRegExp(indent);
  for (const m of head.matchAll(new RegExp(`^${indentRe}<(${PREDECESSORS.join('|')})(\\s*/>|>)`, 'gm'))) {
    const start = m.index!;
    const lineEnd = head.indexOf('\n', start);
    if (lineEnd === -1) continue;
    const line = head.slice(start, lineEnd).trimEnd();
    // One-line element (or self-closing): ends with its line. Otherwise it ends
    // with its closing tag at the same indentation (<SourceCode> … </SourceCode>).
    let end = lineEnd;
    if (!line.endsWith('/>') && !line.endsWith(`</${m[1]}>`)) {
      const close = new RegExp(`^${indentRe}</${escapeRegExp(m[1])}>`, 'm').exec(head.slice(start));
      if (!close) continue;
      end = head.indexOf('\n', start + close.index);
      if (end === -1) continue;
    }
    insertAt = Math.max(insertAt, end + 1);
  }
  if (insertAt === -1) return null;
  const rendered = renderSubscriberAccessLevel(level, indent).replace(/\n/g, eol);
  return xml.slice(0, insertAt) + rendered + eol + xml.slice(insertAt);
}
