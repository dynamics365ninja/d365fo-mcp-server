/**
 * Turn a mapped field of an AxDataEntityView into a computed (unmapped) field — pure
 * string in / string out.
 *
 * A mapped field reads a datasource field 1:1. A computed field is an
 * `AxDataEntityViewUnmappedField<Type>` whose <ComputedFieldMethod> names a static method
 * returning the SQL of the column (SysComputedColumn). Changing one into the other used to
 * mean rewriting the whole entity XML; modify-field with computedFieldMethod does it here.
 *
 * Shipped shape, measured on ApplicationSuite entities:
 *   <AxDataEntityViewField xmlns="" i:type="AxDataEntityViewUnmappedFieldUtcDateTime">
 *     <Name>ConfirmationCreationDateTime</Name>
 *     <Label>@SYS84593</Label>
 *     <ComputedFieldMethod>confirmationDateComputedColumnDefinition</ComputedFieldMethod>
 *     <ExtendedDataType>CreatedDateTime</ExtendedDataType>
 *   </AxDataEntityViewField>
 * Members before DataField in a mapped field (AllowEdit, Label, Mandatory, …) all come
 * before ComputedFieldMethod in an unmapped one, so the new members take DataField's place.
 */

import { detectIndentUnit } from './tableFieldPropertyEdit.js';

export interface ComputedFieldType {
  /** Suffix of AxDataEntityViewUnmappedField<…>: String, Int, Int64, Real, Date, UtcDateTime, Enum, Guid, Container, Time. */
  baseType: string;
  edt?: string;
  enumType?: string;
}

export interface MappedFieldBinding {
  dataField: string;
  dataSource: string;
  /** Table of the datasource, when the entity's query names it. */
  table?: string;
}

type Result = { ok: true; xml: string } | { ok: false; message: string };

const BASE_TYPES = ['String', 'Int', 'Int64', 'Real', 'Date', 'UtcDateTime', 'Enum', 'Guid', 'Container', 'Time'];

/**
 * System fields have no AxTableField in the table XML. Their types, as the kernel defines
 * them (the EDT carries the same name).
 */
const SYSTEM_FIELDS: Record<string, ComputedFieldType> = {
  createddatetime: { baseType: 'UtcDateTime', edt: 'CreatedDateTime' },
  modifieddatetime: { baseType: 'UtcDateTime', edt: 'ModifiedDateTime' },
  createdby: { baseType: 'String', edt: 'CreatedBy' },
  modifiedby: { baseType: 'String', edt: 'ModifiedBy' },
  createdtransactionid: { baseType: 'Int64', edt: 'CreatedTransactionId' },
  modifiedtransactionid: { baseType: 'Int64', edt: 'ModifiedTransactionId' },
  recid: { baseType: 'Int64', edt: 'RecId' },
  dataareaid: { baseType: 'String', edt: 'DataAreaId' },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each <AxDataEntityViewField> block directly under the entity's top-level <Fields>. */
function entityFieldBlocks(xml: string): Array<{ name: string; type: string; start: number; end: number; body: string }> {
  const u = detectIndentUnit(xml);
  const open = new RegExp(`\\n${u}<Fields>\\n`).exec(xml);
  if (!open) return [];
  const close = xml.indexOf(`\n${u}</Fields>`, open.index);
  if (close < 0) return [];
  const out: Array<{ name: string; type: string; start: number; end: number; body: string }> = [];
  const re = new RegExp(`\\n${u}${u}<AxDataEntityViewField\\b[^>]*?i:type="([^"]+)"[^>]*>([\\s\\S]*?)\\n${u}${u}</AxDataEntityViewField>`, 'g');
  re.lastIndex = open.index;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && m.index < close) {
    const name = /<Name>([^<]+)<\/Name>/.exec(m[2])?.[1] ?? '';
    out.push({ name, type: m[1], start: m.index, end: m.index + m[0].length, body: m[0] });
  }
  return out;
}

/** The datasource → table of the entity's query (root or embedded), or undefined. */
export function entityDataSourceTable(xml: string, dataSource: string): string | undefined {
  const re = new RegExp(`<(AxQuerySimpleRootDataSource|AxQuerySimpleEmbeddedDataSource)>\\s*<Name>${esc(dataSource)}</Name>([\\s\\S]*?)<Table>([^<]+)</Table>`);
  const m = re.exec(xml);
  // A nested datasource's own <Name> between the two would mean the <Table> is not ours.
  if (!m || /<AxQuerySimple(Root|Embedded)DataSource>/.test(m[2])) return undefined;
  return m[3];
}

/** Binding of the entity's own mapped field, or a reason it cannot be converted. */
export function entityMappedFieldBinding(xml: string, fieldName: string): MappedFieldBinding | { error: string } {
  const field = entityFieldBlocks(xml).find(f => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!field) return { error: `the entity has no field '${fieldName}' in its own <Fields>` };
  if (field.type !== 'AxDataEntityViewMappedField') {
    return { error: `field '${field.name}' is already ${field.type.replace(/^Ax/, '')}, not a mapped field` };
  }
  const dataField = /<DataField>([^<]+)<\/DataField>/.exec(field.body)?.[1];
  const dataSource = /<DataSource>([^<]+)<\/DataSource>/.exec(field.body)?.[1];
  if (!dataField || !dataSource) return { error: `mapped field '${field.name}' has no DataField/DataSource` };
  return { dataField, dataSource, table: entityDataSourceTable(xml, dataSource) };
}

/** Type of a table field read from the table's XML; system fields from the kernel list. */
export function tableFieldComputedType(tableXml: string | null, fieldName: string): ComputedFieldType | undefined {
  const system = SYSTEM_FIELDS[fieldName.toLowerCase()];
  if (system) return { ...system };
  if (!tableXml) return undefined;
  const re = new RegExp(`<AxTableField\\b[^>]*?i:type="AxTableField([A-Za-z0-9]+)"[^>]*>\\s*<Name>${esc(fieldName)}</Name>([\\s\\S]*?)</AxTableField>`, 'i');
  const m = re.exec(tableXml);
  if (!m) return undefined;
  const baseType = BASE_TYPES.find(t => t.toLowerCase() === m[1].toLowerCase());
  if (!baseType) return undefined;
  const edt = /<ExtendedDataType>([^<]+)<\/ExtendedDataType>/.exec(m[2])?.[1];
  const enumType = /<EnumType>([^<]+)<\/EnumType>/.exec(m[2])?.[1];
  return { baseType, ...(edt ? { edt } : {}), ...(enumType ? { enumType } : {}) };
}

/** True when the field is part of one of the entity's keys (a computed field cannot be). */
function inEntityKey(xml: string, fieldName: string): boolean {
  const keys = /<Keys>([\s\S]*?)<\/Keys>/.exec(xml)?.[1] ?? '';
  return new RegExp(`<AxDataEntityViewKeyField>\\s*<DataField>${esc(fieldName)}</DataField>`, 'i').test(keys);
}

/** Rewrite the mapped field as AxDataEntityViewUnmappedField<Type> with ComputedFieldMethod. */
export function convertEntityFieldToComputed(
  xml: string,
  fieldName: string,
  methodName: string,
  type: ComputedFieldType,
): Result {
  if (!BASE_TYPES.includes(type.baseType)) return { ok: false, message: `unknown field type '${type.baseType}'` };
  const field = entityFieldBlocks(xml).find(f => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!field) return { ok: false, message: `the entity has no field '${fieldName}' in its own <Fields>` };
  if (field.type !== 'AxDataEntityViewMappedField') {
    return { ok: false, message: `field '${field.name}' is ${field.type.replace(/^Ax/, '')}, not a mapped field` };
  }
  if (inEntityKey(xml, field.name)) {
    return { ok: false, message: `field '${field.name}' is part of an entity key, and a computed field cannot be a key field` };
  }
  const lines = field.body.split('\n');
  const at = lines.findIndex(l => /^\s*<DataField>/.test(l));
  if (at < 0) return { ok: false, message: `mapped field '${field.name}' has no <DataField>` };
  const indent = /^(\s*)/.exec(lines[at])![1];
  const added = [
    `${indent}<ComputedFieldMethod>${methodName}</ComputedFieldMethod>`,
    ...(type.edt ? [`${indent}<ExtendedDataType>${type.edt}</ExtendedDataType>`] : []),
    ...(type.enumType && type.baseType === 'Enum' ? [`${indent}<EnumType>${type.enumType}</EnumType>`] : []),
  ];
  const kept = lines.filter((l, i) => i !== at && !/^\s*<DataSource>/.test(l));
  kept.splice(at, 0, ...added);
  const body = kept.join('\n').replace(
    'i:type="AxDataEntityViewMappedField"', `i:type="AxDataEntityViewUnmappedField${type.baseType}"`,
  );
  return { ok: true, xml: xml.slice(0, field.start) + body + xml.slice(field.end) };
}

/** The static method a returnField computed column needs, as add-method writes methods. */
export function returnFieldMethodSource(
  entityName: string,
  methodName: string,
  fieldName: string,
  binding: Required<MappedFieldBinding>,
): string {
  return [
    '/// <summary>',
    `/// Gets the computed column definition of ${fieldName}: ${binding.dataSource}.${binding.dataField}.`,
    '/// </summary>',
    '/// <returns>The SQL definition of the computed column.</returns>',
    `private static str ${methodName}()`,
    '{',
    '    return SysComputedColumn::returnField(',
    `        tableStr(${entityName}),`,
    `        identifierStr(${binding.dataSource}),`,
    `        fieldStr(${binding.table}, ${binding.dataField}));`,
    '}',
  ].join('\n');
}
