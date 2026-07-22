/**
 * Field type → form control type resolution.
 *
 * The indexed `symbols` table stores a uniform "String" signature for every
 * field, so it cannot tell an enum from a date from a real. To emit the correct
 * AxForm control for each field (ComboBox for enums, Date for dates, …) we read
 * the field's real `i:type` straight from the table's AOT XML — which every
 * indexed field row points at via its `file_path`.
 *
 * Mapping is driven by the field's AxTableField i:type (reliable, present on
 * every field) rather than the EDT name, so it works for custom EDTs too.
 */

import fs from 'fs';
import { lookupSymbolNocase } from './symbolLookup.js';

export interface ControlTypeInfo {
  /** AxForm control i:type attribute, e.g. 'AxFormComboBoxControl' */
  iType: string;
  /** <Type> element value, e.g. 'ComboBox' */
  typeValue: string;
}

/** Fallback when the field type is unknown — a plain string control is always valid. */
export const DEFAULT_CONTROL: ControlTypeInfo = {
  iType: 'AxFormStringControl',
  typeValue: 'String',
};

/** AxTableField i:type → AxForm control (enums handled separately in {@link controlForTableField}). */
const TABLE_FIELD_TO_CONTROL: Record<string, ControlTypeInfo> = {
  AxTableFieldString: { iType: 'AxFormStringControl', typeValue: 'String' },
  AxTableFieldMemo: { iType: 'AxFormStringControl', typeValue: 'String' },
  AxTableFieldInt: { iType: 'AxFormIntegerControl', typeValue: 'Integer' },
  AxTableFieldInt64: { iType: 'AxFormInt64Control', typeValue: 'Int64' },
  AxTableFieldReal: { iType: 'AxFormRealControl', typeValue: 'Real' },
  AxTableFieldDate: { iType: 'AxFormDateControl', typeValue: 'Date' },
  AxTableFieldUtcDateTime: { iType: 'AxFormDateTimeControl', typeValue: 'DateTime' },
  AxTableFieldTime: { iType: 'AxFormTimeControl', typeValue: 'Time' },
  AxTableFieldGuid: { iType: 'AxFormGuidControl', typeValue: 'Guid' },
};

/**
 * Resolve the form control for a table field, given its AxTableField i:type and
 * (for enums) the bound enum name. NoYes enums become a CheckBox; every other
 * enum a ComboBox — matching how shipped forms render them.
 */
export function controlForTableField(tableFieldIType: string, enumType?: string): ControlTypeInfo {
  if (tableFieldIType === 'AxTableFieldEnum') {
    if (enumType && enumType.trim().toLowerCase() === 'noyes') {
      return { iType: 'AxFormCheckBoxControl', typeValue: 'CheckBox' };
    }
    return { iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' };
  }
  return TABLE_FIELD_TO_CONTROL[tableFieldIType] ?? DEFAULT_CONTROL;
}

/** field name (lower-cased) → resolved control type */
export type FieldControlMap = Map<string, ControlTypeInfo>;

/**
 * Parse a table's AOT XML into a field→control-type map. Returns an empty map on
 * any failure (missing file, parse issue) — callers fall back to String controls.
 */
export function parseTableFieldControls(tableXml: string): FieldControlMap {
  const map: FieldControlMap = new Map();
  // Each <AxTableField … i:type="AxTableFieldXxx"> … </AxTableField> block.
  // [^>]* spans the (possibly multi-line) opening tag up to its '>'.
  const fieldRe = /<AxTableField\b[^>]*?i:type="(AxTableField\w+)"[^>]*>([\s\S]*?)<\/AxTableField>/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(tableXml)) !== null) {
    const iType = m[1];
    const body = m[2];
    const name = body.match(/<Name>([^<]+)<\/Name>/)?.[1]?.trim();
    if (!name) continue;
    const enumType = body.match(/<EnumType>([^<]+)<\/EnumType>/)?.[1]?.trim();
    map.set(name.toLowerCase(), controlForTableField(iType, enumType));
  }
  return map;
}

/**
 * A view's own XML carries no field TYPES — an `<AxViewFieldBound>` only names
 * the underlying table field. Parse the bindings so the types can be picked up
 * from the tables the view's query reads.
 *
 * `dataSource` is the QUERY datasource alias, not a table name; resolving it
 * needs the query (see {@link parseQueryDataSourceTables}).
 */
export function parseViewFieldBindings(
  viewXml: string,
): Array<{ name: string; dataField: string; dataSource?: string }> {
  const out: Array<{ name: string; dataField: string; dataSource?: string }> = [];
  const fieldRe = /<AxViewField\b[^>]*?i:type="AxViewFieldBound"[^>]*>([\s\S]*?)<\/AxViewField>/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(viewXml)) !== null) {
    const body = m[1];
    const name = body.match(/<Name>([^<]+)<\/Name>/)?.[1]?.trim();
    if (!name) continue;
    const dataField = body.match(/<DataField>([^<]+)<\/DataField>/)?.[1]?.trim() ?? name;
    const dataSource = body.match(/<DataSource>([^<]+)<\/DataSource>/)?.[1]?.trim();
    out.push({ name, dataField, dataSource });
  }
  return out;
}

/**
 * Map a query's datasource ALIASES to the tables behind them. In AxQuery XML a
 * datasource's `<Table>` always directly follows its `<Name>`, at every nesting
 * level, so one pass over that pair covers root and child datasources alike.
 */
export function parseQueryDataSourceTables(queryXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<Name>([^<]+)<\/Name>\s*<Table>([^<]+)<\/Table>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(queryXml)) !== null) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/** The `<Query>` an AxView is built on, or undefined for a query-less view. */
export function parseViewQueryName(viewXml: string): string | undefined {
  const v = viewXml.match(/<Query>([^<]*)<\/Query>/)?.[1]?.trim();
  return v ? v : undefined;
}

/** AOT XML of a top-level object, via the symbol index. Empty string when unavailable. */
function readIndexedObjectXml(db: any, name: string, types: readonly string[]): string {
  const hit = lookupSymbolNocase(db, name, types);
  const p = hit?.file_path;
  if (!p || !fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Field→control-type map for a VIEW: hop view → query → the query's tables, and
 * type each view field from the table field it is bound to.
 *
 * Without this every control on a form over a view came out as a plain String —
 * enums, dates and reals included — because the view XML the map was parsed from
 * contains no `AxTableField` at all.
 */
function getViewFieldControlMap(db: any, viewXml: string, depth = 0): FieldControlMap {
  const map: FieldControlMap = new Map();
  const bindings = parseViewFieldBindings(viewXml);
  if (bindings.length === 0) return map;

  const queryName = parseViewQueryName(viewXml);
  const aliasToTable = queryName
    ? parseQueryDataSourceTables(readIndexedObjectXml(db, queryName, ['query']))
    : new Map<string, string>();

  // One parse per underlying object, not per field. A query datasource may itself
  // be a VIEW (GeneralJournalUnionView reads GeneralJournalWithSubledgerView), so
  // this recurses — bounded, because a cyclic view chain would not compile but a
  // malformed one on disk still must not hang the scaffold.
  const MAX_VIEW_DEPTH = 4;
  const sourceMaps = new Map<string, FieldControlMap>();
  const mapForSource = (name: string): FieldControlMap => {
    let m = sourceMaps.get(name);
    if (!m) {
      const xml = readIndexedObjectXml(db, name, ['table', 'view']);
      m = /^\s*<AxView[\s>]/m.test(xml)
        ? (depth < MAX_VIEW_DEPTH ? getViewFieldControlMap(db, xml, depth + 1) : new Map())
        : parseTableFieldControls(xml);
      sourceMaps.set(name, m);
    }
    return m;
  };

  for (const b of bindings) {
    // The alias usually equals the object name, so it is a sane last resort.
    const source = (b.dataSource && aliasToTable.get(b.dataSource)) || b.dataSource;
    if (!source) continue;
    const hit = mapForSource(source).get(b.dataField.toLowerCase());
    if (hit) map.set(b.name.toLowerCase(), hit);
  }
  return map;
}

/**
 * Build a field→control-type map for a table by locating its AOT XML through the
 * symbol index (any field row of the table carries the table's `file_path`).
 * Views are supported too, through the extra query→table hop described in
 * {@link getViewFieldControlMap}.
 *
 * @param db   read-only better-sqlite3 handle (symbolIndex.getReadDb())
 * @param table table (or view) name
 */
export function getFieldControlMap(db: any, table: string): FieldControlMap {
  try {
    // Canonicalize first — `parent_name = ? COLLATE NOCASE` cannot use
    // idx_parent_type_name and scans all 360k field rows (180 s cold).
    const canonical = lookupSymbolNocase(db, table)?.name ?? table;
    const row = db
      .prepare(
        `SELECT file_path FROM symbols
         WHERE type = 'field' AND parent_name = ?
           AND file_path IS NOT NULL AND file_path != ''
         LIMIT 1`,
      )
      .get(canonical) as { file_path?: string } | undefined;
    if (!row?.file_path || !fs.existsSync(row.file_path)) return new Map();
    const xml = fs.readFileSync(row.file_path, 'utf-8');
    // An AxView document has no AxTableField to parse — take the view route.
    if (/^\s*<AxView[\s>]/m.test(xml)) return getViewFieldControlMap(db, xml);
    return parseTableFieldControls(xml);
  } catch {
    return new Map();
  }
}

/**
 * Read `<TitleField1>` out of a table's AOT XML. The element is table-level, so
 * the match is anchored on the FIRST occurrence outside any nested block —
 * `<TitleField1>` exists nowhere else in an AxTable document, so a plain match
 * is safe. Returns undefined when the table declares no title field.
 */
export function parseTableTitleField(tableXml: string): string | undefined {
  const v = tableXml.match(/<TitleField1>([^<]*)<\/TitleField1>/)?.[1]?.trim();
  return v ? v : undefined;
}

/**
 * Resolve a table's `TitleField1` through the symbol index (same file_path hop as
 * {@link getFieldControlMap}). Used by the form scaffold so a DetailsMaster title
 * control binds to the record's identifying field instead of the alphabetically
 * first one (docs/eval-sweep-findings-2026-07-21.md #32).
 */
export function getTableTitleField(db: any, table: string): string | undefined {
  try {
    const canonical = lookupSymbolNocase(db, table)?.name ?? table;
    const row = db
      .prepare(
        `SELECT file_path FROM symbols
         WHERE type = 'field' AND parent_name = ?
           AND file_path IS NOT NULL AND file_path != ''
         LIMIT 1`,
      )
      .get(canonical) as { file_path?: string } | undefined;
    if (!row?.file_path || !fs.existsSync(row.file_path)) return undefined;
    return parseTableTitleField(fs.readFileSync(row.file_path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Control type for a single field from a (possibly undefined) map, defaulting to String. */
export function controlForField(field: string, types?: FieldControlMap): ControlTypeInfo {
  return types?.get(field.toLowerCase()) ?? DEFAULT_CONTROL;
}
