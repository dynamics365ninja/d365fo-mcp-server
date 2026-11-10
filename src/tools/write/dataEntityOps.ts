/**
 * Dispatch glue for what the bridge cannot do on a data entity, and for the table-field
 * properties written to the XML (AllowEdit / IgnoreEDTRelation). Lives here because modifyD365File.ts is held to a line budget
 * (tests/utils/layering.test.ts); the writers are in directXmlWriters.ts.
 */

import * as fs from 'fs/promises';
import {
  directXmlAddDataEntityDataSource, directXmlAddDataEntityField, directXmlSetTableFieldProperties,
  directXmlMakeEntityFieldComputed, viaXmlFallback,
} from './directXmlWriters.js';
import { renderOpSpec } from '../specs/d365foFileOpSpecs.js';
import { z } from 'zod';
import { bridgeModifyField } from '../../bridge/index.js';
import { findBaseObjectXml } from '../../utils/baseObjectXml.js';
import { xppMethodSourceForXml } from '../../utils/xppFormat.js';
import { ensureXppDocComment } from '../../utils/xppDocGen.js';
import {
  entityMappedFieldBinding, tableFieldComputedType, returnFieldMethodSource,
} from '../xml/entityComputedField.js';

type Args = Record<string, any>;
export type OpResult = { success: boolean; message: string; viaXmlFallback?: boolean } | null;

/** add-data-source on a data-entity: an embedded, joined query datasource. */
export async function entityAddDataSource(filePath: string, args: Args): Promise<OpResult> {
  if (!args.dataSourceName || !args.dataSourceTable) return null;
  const mode = String(args.linkType ?? '').trim();
  // The form vocabulary (ExistJoin/NotExistJoin) is accepted for the query's ExistsJoin/NoExistsJoin.
  const joinMode = /^exist(s)?join$/i.test(mode) ? 'ExistsJoin'
    : /^notexist(s)?join$/i.test(mode) ? 'NoExistsJoin' : (mode || undefined);
  const r = await directXmlAddDataEntityDataSource(filePath, {
    name: args.dataSourceName,
    table: args.dataSourceTable,
    joinSource: args.joinSource,
    joinMode,
    joinField: args.joinField,
    relatedField: args.relatedField,
    readOnly: args.dataSourceReadOnly === true,
  });
  return r ? viaXmlFallback(r) : null;
}

/** add-field on a data-entity: the refusal text when the binding is half-given, else null. */
export function entityAddFieldBindingError(args: Args): string | null {
  if (args.dataField && args.dataSource) return null;
  return (
    `❌ add-field on a data-entity needs BOTH dataField and dataSource — nothing was written.\n` +
    `An entity field is a mapped field: fieldName is the entity-facing name, dataField the ` +
    `field on dataSource, which must be a datasource of the entity's own query ` +
    `(add it first with add-data-source).\n\n${renderOpSpec('add-field')}`
  );
}

/** add-field on a data-entity: one mapped field bound to an entity datasource. */
export async function entityAddField(filePath: string, args: Args): Promise<OpResult> {
  const r = await directXmlAddDataEntityField(filePath, {
    name: args.fieldName,
    dataField: args.dataField,
    dataSource: args.dataSource,
    label: args.fieldLabel,
    mandatory: args.fieldMandatory === undefined ? undefined : String(args.fieldMandatory),
  });
  return r ? viaXmlFallback(r) : null;
}

/** modify-field properties written to the XML (AllowEdit / IgnoreEDTRelation), as XML property → value. */
export function xmlOnlyFieldProps(args: Args): Record<string, string> {
  const out: Record<string, string> = {};
  if (args.fieldAllowEdit !== undefined) out.AllowEdit = args.fieldAllowEdit ? 'Yes' : 'No';
  if (args.fieldIgnoreEdtRelation !== undefined) out.IgnoreEDTRelation = args.fieldIgnoreEdtRelation ? 'Yes' : 'No';
  return out;
}

/** Apply those properties; joins the bridge's message when it also changed something. */
export async function applyXmlOnlyFieldProps(
  filePath: string,
  fieldName: string,
  props: Record<string, string>,
  bridgeResult: OpResult,
  bridgeChangedSomething: boolean,
): Promise<OpResult> {
  const r = await directXmlSetTableFieldProperties(filePath, fieldName, props);
  if (!r) return bridgeResult;
  return viaXmlFallback(bridgeResult?.success && bridgeChangedSomething
    ? { success: r.success, message: `${bridgeResult.message}\n${r.message}` }
    : r);
}

/**
 * modify-field: the other field params go through the bridge; AllowEdit / IgnoreEDTRelation are
 * written to the XML afterwards (the bridge reads allowEdit but not IgnoreEDTRelation, and the
 * XML path also works without it). `bridge` is the context's bridge client.
 */
export async function modifyFieldOp(
  bridge: Parameters<typeof bridgeModifyField>[0],
  objectName: string,
  filePath: string,
  args: Args,
  symbolIndex?: unknown,
): Promise<OpResult> {
  if (args.computedFieldMethod) return entityFieldToComputed(objectName, filePath, args, symbolIndex);
  // Map the field-* params onto the bare prop keys the bridge expects.
  const fieldProps: Record<string, string> = {};
  if (args.fieldLabel) fieldProps.label = args.fieldLabel;
  if (args.fieldHelpText) fieldProps.helpText = args.fieldHelpText;
  if (args.fieldMandatory !== undefined) fieldProps.mandatory = String(args.fieldMandatory);
  if (args.fieldType) fieldProps.edt = args.fieldType;
  if (args.fieldEnumType) fieldProps.enumType = args.fieldEnumType;
  if (args.fieldStringSize) fieldProps.stringSize = String(args.fieldStringSize);
  const xmlOnly = xmlOnlyFieldProps(args);
  const hasXmlOnly = Object.keys(xmlOnly).length > 0;
  const bridgeHasWork = Object.keys(fieldProps).length > 0;
  let result: OpResult = null;
  if (bridgeHasWork || !hasXmlOnly) {
    result = await bridgeModifyField(bridge, objectName, args.fieldName, bridgeHasWork ? fieldProps : undefined);
  }
  // Only when the bridge half was not needed or worked: else a lost change hides behind the XML success.
  if (hasXmlOnly && (!bridgeHasWork || result?.success)) {
    result = await applyXmlOnlyFieldProps(filePath, args.fieldName, xmlOnly, result, bridgeHasWork);
  }
  return result;
}

/**
 * modify-field computedFieldMethod on a data-entity: the entity's own mapped field becomes a
 * computed (unmapped) field of the source field's type, and its static method is written in
 * the same edit — sourceCode when given, else an existing method of that name, else a
 * SysComputedColumn::returnField over the field it was mapped to.
 */
async function entityFieldToComputed(objectName: string, filePath: string, args: Args, symbolIndex: unknown): Promise<OpResult> {
  const fail = (why: string): OpResult => ({ success: false, message: `❌ modify-field computedFieldMethod: ${why} — nothing was written.` });
  const method = String(args.computedFieldMethod).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) return fail(`'${method}' is not a method name`);
  let xml: string;
  try { xml = (await fs.readFile(filePath, 'utf-8')).replace(/\r\n/g, '\n'); } catch { return null; }
  if (!/<AxDataEntityView[\s>]/.test(xml)) return fail('computedFieldMethod applies to a data-entity field only');
  const binding = entityMappedFieldBinding(xml, String(args.fieldName));
  if ('error' in binding) return fail(binding.error);
  // A system field is typed without its table: no lookup, which without an index walks every package.
  let type = tableFieldComputedType(null, binding.dataField);
  if (!type && binding.table) {
    type = tableFieldComputedType(await findBaseObjectXml('table', binding.table, symbolIndex).catch(() => null), binding.dataField);
  }
  if (!type) {
    return fail(
      `could not read the type of ${binding.table ?? `datasource ${binding.dataSource}`}.${binding.dataField} ` +
      `(${binding.table ? 'table XML not found or field not in it' : 'the datasource names no table'})`,
    );
  }
  if (args.fieldType) type.edt = String(args.fieldType);
  const methodExists = new RegExp(`<Method>\\s*<Name>${method}</Name>`, 'i').test(xml);
  let source: string | null = null;
  if (args.sourceCode) source = String(args.sourceCode);
  else if (!methodExists) {
    if (!binding.table) return fail(`datasource '${binding.dataSource}' names no table; pass the method as sourceCode`);
    source = returnFieldMethodSource(objectName, method, String(args.fieldName), binding as Required<typeof binding>);
  }
  const r = await directXmlMakeEntityFieldComputed(filePath, {
    fieldName: String(args.fieldName), methodName: method, type,
    source: source === null ? null : xppMethodSourceForXml(ensureXppDocComment(source)),
  });
  const ignored = ['fieldLabel', 'fieldHelpText', 'fieldMandatory', 'fieldEnumType', 'fieldStringSize', 'fieldAllowEdit', 'fieldIgnoreEdtRelation']
    .filter(k => args[k] !== undefined);
  if (r?.success && ignored.length) {
    r.message += `\n⚠️ Not applied together with computedFieldMethod: ${ignored.join(', ')}. Run modify-field again for them.`;
  }
  return r ? viaXmlFallback(r) : null;
}

/** Zod members for the parameters these operations add (spread into the modify schema). */
export const ENTITY_AND_FIELD_ZOD_PARAMS = {
  fieldAllowEdit: z.boolean().optional().describe('modify-field: false writes <AllowEdit>No</AllowEdit> (staging key fields; clears BPErrorTablePrimaryKeyEditable).'),
  fieldIgnoreEdtRelation: z.boolean().optional().describe('modify-field: true writes <IgnoreEDTRelation>Yes</IgnoreEDTRelation> (EDT with a relation; clears BPErrorEDTNotMigrated).'),
  joinField: z.string().optional().describe('add-data-source on a data-entity: field of the JOIN (parent) datasource the relation starts from. Required with relatedField.'),
  relatedField: z.string().optional().describe("add-data-source on a data-entity: field of the NEW datasource's table it joins to. Required with joinField."),
  computedFieldMethod: z.string().optional().describe('modify-field on a data-entity: turn the mapped field into a computed field whose ComputedFieldMethod is this static method (sourceCode, an existing method, or a generated SysComputedColumn::returnField).'),
  dataSourceReadOnly: z.boolean().optional().describe('add-data-source on a data-entity: write IsReadOnly=Yes on the new datasource.'),
};
