/**
 * Unmapped fields of a data entity (AxDataEntityViewUnmappedField<Type>) — pure string builders.
 *
 * A mapped field reads a datasource field 1:1. An unmapped field declares its own type and is
 * filled in code (a virtual Base64 column, a value set in postLoad) or, with a
 * ComputedFieldMethod, computed in SQL. It has no DataField/DataSource and is not part of the
 * entity query.
 *
 * Shape and member order measured on the shipped ApplicationSuite entities (CustCreditCardEntity
 * and ~4,000 other unmapped fields): Name, AccessModifier, AllowEdit, AllowEditOnCreate,
 * CountryRegionCodes, HelpText, Label, Mandatory, ComputedFieldMethod, ExtendedDataType,
 * IsComputedField, EnumType, StringSize. A plain field carries <IsComputedField>No</IsComputedField>
 * after its EDT; a computed one carries ComputedFieldMethod instead.
 * The deserializer drops a mis-ordered member silently, so the order is not cosmetic.
 */

import { escapeXml } from '../../utils/xmlEscape.js';
import { normalizeFieldBaseType, type AxFieldBaseType } from '../../utils/axFieldTypes.js';
import { detectIndentUnit, yesNo } from './tableFieldPropertyEdit.js';

export interface EntityUnmappedFieldSpec {
  name: string;
  /** EDT name. */
  edt?: string;
  /** Base type keyword (String, Integer, Int64, Real, Date, Time, UtcDateTime/DateTime, Enum, Container, Guid). */
  baseType?: string;
  enumType?: string;
  stringSize?: string | number;
  label?: string;
  helpText?: string;
  mandatory?: string | boolean;
  /** Static method returning the SQL of a computed column; makes the field computed. */
  computedFieldMethod?: string;
}

/**
 * create data-entity fields[] entry: unmapped only when it says `unmapped: true`. A type on a
 * mapped-looking entry ({name, type, edt}, the table-create shape) must NOT turn it unmapped:
 * that used to be a mapped field and would silently become an empty one. Existing callers are unchanged.
 */
export function isUnmappedEntityFieldSpec(f: Record<string, any>): boolean {
  return f.unmapped === true;
}

/** Entity-field element suffix per base type (Integer's element is `Int`). */
const SUFFIX: Record<AxFieldBaseType, string> = {
  String: 'String', Integer: 'Int', Int64: 'Int64', Real: 'Real', Date: 'Date', Time: 'Time',
  UtcDateTime: 'UtcDateTime', Enum: 'Enum', Container: 'Container', Guid: 'Guid',
};

export interface BuiltUnmappedField {
  ok: true;
  /** The element, tab-indented for a top-level <Fields>. */
  xml: string;
  baseType: AxFieldBaseType;
}

/**
 * Build one unmapped field. `resolveEdtBase` (optional) names the base type of an EDT when the
 * caller gave only fieldType; without it the base type must be given or the EDT name must be
 * unmistakable. A type is never guessed: an unresolvable one is refused.
 */
export function buildEntityUnmappedFieldXml(
  spec: EntityUnmappedFieldSpec,
  resolveEdtBase?: (edt: string) => AxFieldBaseType | undefined,
): BuiltUnmappedField | { ok: false; message: string } {
  if (!/^[A-Za-z_]\w*$/.test(spec.name)) return { ok: false, message: `'${spec.name}' is not a valid field name` };
  // A base-type keyword in the EDT slot (fieldType="String") is a base type, never an EDT name.
  if (spec.edt && /^Ax\w*Field/i.test(spec.edt)) {
    return { ok: false, message: `'${spec.edt}' is an XML element name, not an EDT: pass the EDT name or fieldBaseType` };
  }
  const edtAsBase = spec.edt ? normalizeFieldBaseType(spec.edt) : undefined;
  if (edtAsBase) spec = { ...spec, edt: undefined, baseType: spec.baseType ?? edtAsBase };
  let base = spec.baseType ? normalizeFieldBaseType(spec.baseType) : undefined;
  if (spec.baseType && !base) return { ok: false, message: `fieldBaseType '${spec.baseType}' is not a field base type` };
  if (!base && spec.enumType) base = 'Enum';
  const edtBase = spec.edt ? resolveEdtBase?.(spec.edt) : undefined;
  if (base && edtBase && base !== edtBase && base !== 'Enum' && edtBase !== 'Enum') {
    return { ok: false, message: `EDT '${spec.edt}' is a ${edtBase}, not a ${base}: drop fieldBaseType or fix it` };
  }
  if (!base && spec.edt) base = edtBase;
  if (!base) {
    return {
      ok: false,
      message:
        `cannot tell the type of unmapped field '${spec.name}'` +
        (spec.edt ? (resolveEdtBase ? ` (EDT '${spec.edt}' is not in the index)` : ` (no index to look up EDT '${spec.edt}')`) : '') +
        `: pass fieldBaseType (String, Integer, Int64, Real, Date, Time, UtcDateTime, Enum, Container, Guid), ` +
        `fieldEnumType, or an EDT the index knows`,
    };
  }
  if (base === 'Enum' && !spec.enumType && !spec.edt) {
    return { ok: false, message: `an Enum unmapped field needs fieldEnumType (or an enum EDT)` };
  }
  if (base !== 'Enum' && spec.enumType) {
    return { ok: false, message: `fieldEnumType given but fieldBaseType is ${base}` };
  }
  const sizeGiven = spec.stringSize !== undefined && String(spec.stringSize) !== '';
  if (sizeGiven && (base !== 'String' || !/^(-1|[1-9]\d*)$/.test(String(spec.stringSize)))) {
    return { ok: false, message: `fieldStringSize '${spec.stringSize}' must be a positive integer (or -1) and applies to String fields only` };
  }
  if (base === 'String' && !spec.edt && !sizeGiven && !spec.computedFieldMethod) {
    // 16 of the shipped fields have no type at all, but a string with neither EDT nor size has unknown length.
    return { ok: false, message: `a String unmapped field needs an EDT (fieldType) or fieldStringSize` };
  }
  let mandatory: string | undefined;
  if (spec.mandatory !== undefined) {
    mandatory = yesNo(spec.mandatory);
    if (!mandatory) return { ok: false, message: `Mandatory takes Yes or No, not '${spec.mandatory}'` };
  }
  if (spec.computedFieldMethod && !/^[A-Za-z_]\w*$/.test(spec.computedFieldMethod)) {
    return { ok: false, message: `'${spec.computedFieldMethod}' is not a method name` };
  }
  const member = (tag: string, value: string | number | undefined) =>
    value === undefined || value === '' ? '' : `\n\t\t\t<${tag}>${escapeXml(String(value))}</${tag}>`;
  const xml =
    `\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedField${SUFFIX[base]}">` +
    member('Name', spec.name) +
    member('HelpText', spec.helpText) +
    member('Label', spec.label) +
    member('Mandatory', mandatory) +
    member('ComputedFieldMethod', spec.computedFieldMethod) +
    member('ExtendedDataType', spec.edt) +
    (spec.computedFieldMethod ? '' : '\n\t\t\t<IsComputedField>No</IsComputedField>') +
    member('EnumType', base === 'Enum' ? spec.enumType : undefined) +
    member('StringSize', sizeGiven ? spec.stringSize : undefined) +
    `\n\t\t</AxDataEntityViewField>`;
  return { ok: true, xml, baseType: base };
}

/** Re-indent a tab-built element in the file's own indent unit. */
export const reindent = (element: string, u: string): string =>
  element.replace(/^\t+/gm, tabs => u.repeat(tabs.length));

export interface AddUnmappedResult { ok: boolean; xml?: string; message: string }

/**
 * Append an unmapped field to the document's top-level <Fields> (AxDataEntityView or
 * AxDataEntityViewExtension), creating the collection element's content when it is self-closed.
 * Nothing but <Fields> is touched: keys, public names, staging reference, query stay as they are.
 */
export function addEntityUnmappedField(
  xml: string,
  spec: EntityUnmappedFieldSpec,
  resolveEdtBase?: (edt: string) => AxFieldBaseType | undefined,
): AddUnmappedResult {
  if (!/<AxDataEntityView(Extension)?[\s>]/.test(xml)) return { ok: false, message: 'not an AxDataEntityView / AxDataEntityViewExtension document' };
  const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`<AxDataEntityViewField\\b[^>]*>\\s*<Name>${esc}</Name>`, 'i').test(xml)) {
    return { ok: false, message: `field '${spec.name}' already exists on this entity` };
  }
  const built = buildEntityUnmappedFieldXml(spec, resolveEdtBase);
  if (!built.ok) return { ok: false, message: built.message };
  const u = detectIndentUnit(xml);
  const element = reindent(built.xml, u);
  const empty = new RegExp(`^${u}<Fields */>`, 'm').exec(xml);
  if (empty) {
    return {
      ok: true,
      xml: `${xml.slice(0, empty.index)}${u}<Fields>\n${element}\n${u}</Fields>${xml.slice(empty.index + empty[0].length)}`,
      message: `unmapped field ${spec.name} added`,
    };
  }
  const open = new RegExp(`^${u}<Fields>\\n`, 'm').exec(xml);
  if (!open) return { ok: false, message: 'the document has no top-level <Fields> collection' };
  const close = new RegExp(`^${u}</Fields>`, 'm').exec(xml.slice(open.index));
  if (!close) return { ok: false, message: 'unbalanced <Fields>' };
  const at = open.index + close.index;
  return { ok: true, xml: `${xml.slice(0, at)}${element}\n${xml.slice(at)}`, message: `unmapped field ${spec.name} added` };
}
