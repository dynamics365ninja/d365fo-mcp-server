/**
 * The one canonical D365FO field base-type map.
 *
 * There used to be five copies of this dictionary — createD365File.ts
 * (fieldTypeToAxType), generateTableFields.ts (axTableFieldType),
 * smartXmlBuilder.ts (getAxTableFieldType), mapXml.ts (FIELD_TYPE_TO_AXTYPE) and
 * the C# CreateTableField switch — and they disagreed on both spelling and
 * casing, all of them looking up a Record<string,string> with a raw `||`
 * fallback to String. Three concrete wrong writes came out of that:
 *
 *   • mapXml's copy keyed Integer as `Int`, so the documented `type:"Integer"`
 *     missed and the map field was written AxMapFieldString — a silently
 *     mistyped field that builds clean.
 *   • every copy was case-SENSITIVE, so `type:"integer"` / `"guid"` fell through
 *     to String as well.
 *   • mapXml's copy mapped `Boolean` to `AxMapFieldBoolean`, which is not a
 *     metamodel element at all (verified by reflection over
 *     Microsoft.Dynamics.AX.Metadata.dll: the AxMapField* family is Container,
 *     Date, Enum, Guid, Int, Int64, Real, String, Time, UtcDateTime — no
 *     Boolean). D365FO has no boolean field type; it uses an Enum field over
 *     NoYes.
 *
 * The element families below are the reflected metamodel type names, not a
 * guess. Lookup is case-insensitive and also accepts a full i:type element name
 * ("AxTableFieldInt"), because callers copy those out of XML they just read.
 */

/** Canonical spelling of every base type a D365FO field can have. */
export type AxFieldBaseType =
  | 'String'
  | 'Integer'
  | 'Int64'
  | 'Real'
  | 'Date'
  | 'Time'
  | 'UtcDateTime'
  | 'Enum'
  | 'Container'
  | 'Guid';

export const AX_FIELD_BASE_TYPES: readonly AxFieldBaseType[] = [
  'String', 'Integer', 'Int64', 'Real', 'Date', 'Time', 'UtcDateTime', 'Enum', 'Container', 'Guid',
];

/**
 * Every accepted spelling, lower-cased, → the canonical base type.
 * `Int` and `Integer` are the same type (the ELEMENT is AxTableFieldInt, the
 * base-type keyword the bridge and the tool schemas use is "Integer"), which is
 * exactly the divergence that made mapXml drop `type:"Integer"`.
 */
const BASE_TYPE_ALIASES: Readonly<Record<string, AxFieldBaseType>> = {
  string: 'String',
  str: 'String',
  integer: 'Integer',
  int: 'Integer',
  int32: 'Integer',
  int64: 'Int64',
  long: 'Int64',
  real: 'Real',
  decimal: 'Real',
  date: 'Date',
  time: 'Time',
  timeofday: 'Time',
  utcdatetime: 'UtcDateTime',
  datetime: 'UtcDateTime',
  enum: 'Enum',
  container: 'Container',
  guid: 'Guid',
};

/** i:type element suffix per canonical base type — Integer's element is `Int`. */
const ELEMENT_SUFFIX: Readonly<Record<AxFieldBaseType, string>> = {
  String: 'String',
  Integer: 'Int',
  Int64: 'Int64',
  Real: 'Real',
  Date: 'Date',
  Time: 'Time',
  UtcDateTime: 'UtcDateTime',
  Enum: 'Enum',
  Container: 'Container',
  Guid: 'Guid',
};

/** The i:type prefixes a caller may paste in instead of a base-type keyword. */
const ELEMENT_PREFIX = /^Ax(?:Table|Map|View|Query|DataEntityView)?(?:Base)?Field/i;

/**
 * Canonical base type for any spelling a caller might send, or undefined when
 * the input names no D365FO field type. Undefined is the caller's cue to fall
 * back (EDT-name heuristics) or to refuse — never to quietly emit String.
 */
export function normalizeFieldBaseType(raw: unknown): AxFieldBaseType | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const stripped = trimmed.replace(ELEMENT_PREFIX, '');
  return BASE_TYPE_ALIASES[stripped.toLowerCase()] ?? BASE_TYPE_ALIASES[trimmed.toLowerCase()];
}

/** `<AxTableField i:type="…">` element for a canonical base type. */
export function axTableFieldElement(base: AxFieldBaseType): string {
  return `AxTableField${ELEMENT_SUFFIX[base]}`;
}

/** `<AxMapBaseField i:type="…">` element for a canonical base type. */
export function axMapFieldElement(base: AxFieldBaseType): string {
  return `AxMapField${ELEMENT_SUFFIX[base]}`;
}

/**
 * Base type guessed from an EDT NAME, for the case where the caller gave an EDT
 * but no base type and the EDT is not (yet) in the index. Extracted verbatim
 * from the three identical copies it used to have; the order of the tests is
 * load-bearing (RecId before Int, UtcDateTime before Date).
 */
export function baseTypeFromEdtName(edtName: string | undefined): AxFieldBaseType | undefined {
  if (!edtName) return undefined;
  const e = edtName.toLowerCase();
  if (e === 'recid' || e.endsWith('recid') || e.includes('refrecid')) return 'Int64';
  if (e.includes('utcdatetime') || (e.includes('datetime') && !e.includes('transdate'))) return 'UtcDateTime';
  if (e.includes('date') && !e.includes('time') && !e.includes('update')) return 'Date';
  if (e.includes('amount') || e.includes('mst') || e.includes('price') || e.includes('qty')
      || e.includes('percent') || e === 'real') return 'Real';
  if (e === 'noyesid' || e.endsWith('noyesid') || e === 'noyes') return 'Enum';
  if ((e.endsWith('int') || e.includes('count') || e.includes('level'))
      && !e.includes('account') && !e.includes('name')) return 'Integer';
  return undefined;
}

/**
 * The error text every builder uses when a caller names a type that does not
 * exist. Spelling out the accepted set is the whole point: the failure mode this
 * replaces was a String field written under a wrong name and reported as success.
 */
export function unknownFieldTypeMessage(context: string, raw: string): string {
  const boolHint = /^bool(ean)?$/i.test(raw.trim())
    ? ' D365FO has no boolean field type — use type:"Enum" with enumType:"NoYes".'
    : '';
  return (
    `${context}: "${raw}" is not a D365FO field type — nothing was written. ` +
    `Valid types (case-insensitive): ${AX_FIELD_BASE_TYPES.join(', ')}.${boolHint}`
  );
}
