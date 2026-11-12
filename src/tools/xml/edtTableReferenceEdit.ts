/**
 * modify-property ReferenceField on an existing EDT: the EDT's table reference.
 *
 * An EDT points at a table in two places. <ReferenceTable> is a scalar property
 * and the bridge's property setter writes it. The related field is not a
 * property at all: it lives in the single <AxEdtTableReference> child of
 * <TableReferences>, next to the table name. No scalar writer can express that,
 * so "ReferenceField" was advertised for EDTs and refused with "Unknown AxEdt
 * property" (#1161).
 *
 * This writer sets that child on the XML:
 *
 *   <ReferenceTable>CustTable</ReferenceTable>
 *   ...
 *   <TableReferences>
 *     <AxEdtTableReference>
 *       <RelatedField>AccountNum</RelatedField>
 *       <Table>CustTable</Table>
 *     </AxEdtTableReference>
 *   </TableReferences>
 *
 * The value is the related field, or "Table.Field" to set both in one call. With
 * a bare field the table comes from the file: its <ReferenceTable>, or the table
 * of the reference it already has. With neither the request is refused. An
 * existing reference is updated in place, never joined by a second one. When
 * the EDT also carries one legacy <Relations><AxEdtRelation> (many shipped EDTs
 * hold both, with the same values), that entry gets the same table and field so
 * the two stay in agreement. The child's shape is the one shipped EDTs have and
 * edtRelationResolver.ts reads back.
 */

import { escapeXml } from '../../utils/xmlEscape.js';

export type EdtTableReferenceResult =
  | { ok: true; xml: string; changed: boolean; table: string; relatedField: string; wroteReferenceTable: boolean; syncedLegacyRelation: boolean }
  | { ok: false; error: string };

/** True when a propertyPath names the EDT's related field (bare name, any case). */
export function isEdtReferenceFieldProperty(propertyPath: string): boolean {
  return propertyPath.trim().toLowerCase() === 'referencefield';
}

/** "Field" or "Table.Field", as passed in propertyValue. */
export function parseEdtReferenceFieldValue(
  rawValue: unknown,
): { ok: true; table?: string; relatedField: string } | { ok: false; error: string } {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  const parts = value.split('.').map(p => p.trim());
  const isName = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  if (!value || parts.length > 2 || !parts.every(isName)) {
    return {
      ok: false,
      error:
        `Invalid ReferenceField ${JSON.stringify(rawValue)}. Pass the related field name ("AccountNum"), ` +
        `or "Table.Field" ("CustTable.AccountNum") to set the reference table in the same call.`,
    };
  }
  return parts.length === 2
    ? { ok: true, table: parts[0], relatedField: parts[1] }
    : { ok: true, relatedField: parts[0] };
}

const textOf = (xml: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(xml)?.[1];

/**
 * Set the table reference of an AxEdt document. Returns undefined for any other
 * document, so the caller can fall through to the generic property path.
 */
export function setEdtTableReference(xml: string, rawValue: unknown): EdtTableReferenceResult | undefined {
  if (!/<AxEdt[\s>]/.test(xml)) return undefined;

  const parsed = parseEdtReferenceFieldValue(rawValue);
  if (!parsed.ok) return parsed;

  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  // One indent step, as the file writes it in front of <Name>.
  const unit = /^([ \t]+)<Name>/m.exec(xml)?.[1] ?? '\t';

  // Many shipped EDTs carry a legacy <Relations><AxEdtRelation> AND a matching
  // table reference (same RelatedField and Table). Readers take the legacy one
  // first, so a single one is kept in agreement below. Several cannot be: there
  // is no telling which of them the reference mirrors.
  const relations = /<Relations>([\s\S]*?)<\/Relations>/.exec(xml)?.[1];
  const legacy = relations?.match(/<AxEdtRelation[\s>]/g)?.length ?? 0;
  if (legacy > 1) {
    return {
      ok: false,
      error: `This EDT has ${legacy} legacy relations (AxEdtRelation). Only an EDT with a single one can be updated.`,
    };
  }

  const open = /<TableReferences>([\s\S]*?)<\/TableReferences>/.exec(xml);
  const existing = open ? open[1].match(/<AxEdtTableReference[\s>]/g)?.length ?? 0 : 0;
  if (existing > 1) {
    return {
      ok: false,
      error: `This EDT has ${existing} table references. Only an EDT with a single reference can be updated.`,
    };
  }

  const propertyTable = /^[ \t]*<ReferenceTable>\s*([^<]*?)\s*<\/ReferenceTable>/m.exec(xml)?.[1] || undefined;
  const referenceTableOfChild = open ? textOf(open[1], 'Table') : undefined;
  const table = parsed.table ?? propertyTable ?? referenceTableOfChild ?? (legacy === 1 ? textOf(relations!, 'Table') : undefined);
  if (!table) {
    return {
      ok: false,
      error:
        'This EDT has no ReferenceTable, so the related field has no table to belong to. Pass the table too: ' +
        `propertyValue="<Table>.${parsed.relatedField}", or set ReferenceTable first.`,
    };
  }

  let next = xml;

  // ── <ReferenceTable> ───────────────────────────────────────────────────────
  // Written only when the caller named the table. A bare field never touches it.
  let wroteReferenceTable = false;
  if (parsed.table && parsed.table !== propertyTable) {
    const line = `<ReferenceTable>${escapeXml(parsed.table)}</ReferenceTable>`;
    if (/^[ \t]*<ReferenceTable\b[^>]*?(?:\/>|>[^<]*<\/ReferenceTable>)/m.test(next)) {
      next = next.replace(/<ReferenceTable\b[^>]*?(?:\/>|>[^<]*<\/ReferenceTable>)/, () => line);
    } else {
      const at = referenceTableInsertOffset(next);
      if (at === undefined) {
        return { ok: false, error: 'Could not place <ReferenceTable> in this file (no <ArrayElements>, <Relations> or <TableReferences> to anchor on).' };
      }
      next = next.slice(0, at) + `${unit}${line}${eol}` + next.slice(at);
    }
    wroteReferenceTable = true;
  }

  // ── <TableReferences> ──────────────────────────────────────────────────────
  const child =
    `${unit}${unit}<AxEdtTableReference>${eol}` +
    `${unit}${unit}${unit}<RelatedField>${escapeXml(parsed.relatedField)}</RelatedField>${eol}` +
    `${unit}${unit}${unit}<Table>${escapeXml(table)}</Table>${eol}` +
    `${unit}${unit}</AxEdtTableReference>${eol}`;
  const filled = `<TableReferences>${eol}${child}${unit}</TableReferences>`;

  // In place: only the two values change, anything else on the entry stays. A
  // reference with only <Table> (no <RelatedField>) is a shipped shape too.
  const setValues = (block: string, entry: string): string => {
    let b = block;
    b = /<Table>[^<]*<\/Table>/.test(b)
      ? b.replace(/<Table>[^<]*<\/Table>/, () => `<Table>${escapeXml(table)}</Table>`)
      : b.replace(new RegExp(`([ \\t]*)</${entry}>`), (_m, ind: string) => `${ind}${unit}<Table>${escapeXml(table)}</Table>${eol}${ind}</${entry}>`);
    b = /<RelatedField>[^<]*<\/RelatedField>/.test(b)
      ? b.replace(/<RelatedField>[^<]*<\/RelatedField>/, () => `<RelatedField>${escapeXml(parsed.relatedField)}</RelatedField>`)
      : b.replace(/([ \t]*)<Table>/, (_m, ind: string) => `${ind}<RelatedField>${escapeXml(parsed.relatedField)}</RelatedField>${eol}${ind}<Table>`);
    return b;
  };

  // The one legacy relation follows the reference. None is ever created.
  let syncedLegacyRelation = false;
  if (legacy === 1) {
    const synced = next.replace(/<Relations>[\s\S]*?<\/Relations>/, block => setValues(block, 'AxEdtRelation'));
    syncedLegacyRelation = synced !== next;
    next = synced;
  }

  if (existing === 1) {
    next = next.replace(/<TableReferences>[\s\S]*?<\/TableReferences>/, block => setValues(block, 'AxEdtTableReference'));
  } else if (open) {
    next = next.replace(/<TableReferences>[\s\S]*?<\/TableReferences>/, () => filled);
  } else if (/<TableReferences\s*\/>/.test(next)) {
    next = next.replace(/<TableReferences\s*\/>/, () => filled);
  } else {
    // No collection at all: it follows <Relations> (or <ArrayElements>).
    const anchorOf = (tag: string) =>
      new RegExp(`^[ \\t]*<${tag}(?:\\s*/>|>[\\s\\S]*?</${tag}>)[ \\t]*\\r?\\n`, 'm').exec(next);
    const anchor = anchorOf('Relations') ?? anchorOf('ArrayElements');
    if (!anchor) {
      return { ok: false, error: 'Could not place <TableReferences> in this file (no <Relations> or <ArrayElements> to anchor on).' };
    }
    const end = anchor.index + anchor[0].length;
    next = next.slice(0, end) + `${unit}${filled}${eol}` + next.slice(end);
  }

  return { ok: true, xml: next, changed: next !== xml, table, relatedField: parsed.relatedField, wroteReferenceTable, syncedLegacyRelation };
}

/**
 * Where a new <ReferenceTable> line starts. The EDT's scalar properties follow
 * <Name> in alphabetical order and end at <ArrayElements>, so it goes in front of
 * the first one that sorts after it, or in front of the collections.
 */
function referenceTableInsertOffset(xml: string): number | undefined {
  const collections = /^[ \t]*<(?:ArrayElements|Relations|TableReferences)[\s/>]/m.exec(xml);
  if (!collections) return undefined;
  const head = xml.slice(0, collections.index);
  for (const m of head.matchAll(/^[ \t]*<([A-Za-z_][A-Za-z0-9_]*)>[^<]*<\/\1>[ \t]*\r?$/gm)) {
    if (m[1] !== 'Name' && m[1].toLowerCase() > 'referencetable') return m.index!;
  }
  return collections.index;
}
