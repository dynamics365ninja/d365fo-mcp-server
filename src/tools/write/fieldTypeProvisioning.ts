/**
 * Create the EDT or base enum a new table field needs, before the field is written.
 *
 * Microsoft's best practice is that every table field is defined by a type: an
 * extended data type, or a base enum for an enum field. A field with only a
 * primitive type draws BPErrorTableFieldNotDefinedUsingType, and a field that
 * names an EDT or enum that does not exist does not build. Until now the tools
 * wrote the first silently and refused the second (scaffold) or wrote it anyway.
 *
 * This step runs in front of the writes that add fields (d365fo_file create of a
 * table, add-field, generate_object scaffold of a table) and, per field:
 *
 *   - names an EDT that does not exist → creates that EDT, with the base type the
 *     field asked for (or the one its name implies), the field's label, and its
 *     string size;
 *   - names an enum that does not exist → creates that base enum, with the values
 *     passed in `enumValues` (each labelled);
 *   - has only a primitive type → reuses an existing EDT of the same name and base
 *     type, or creates one named after the field (the model's prefix applied);
 *   - has a usable EDT or enum already → nothing.
 *
 * Every create goes through handleCreateD365File, so prefixing, the raw-label →
 * label-file step, .rnrproj registration and the index upsert all apply. The new
 * type carries the label and the field drops its own copy of it: a field label
 * equal to its EDT's or enum's label is BPErrorFieldLabelIsCopyOfExtendedLabel /
 * BPErrorFieldLabelIsCopyOfEnumLabel.
 *
 * Nothing is created when the symbol index cannot be read: without it a standard
 * EDT is indistinguishable from a missing one.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../types/context.js';
import { handleCreateD365File, type CreateOutcome } from './createD365File.js';
import { heuristicEdtBaseType, resolveEdtBaseType } from '../smart/generateSmartTable.js';
import { isKernelEdt } from '../../knowledge/kernelEdts.js';
import { lookupSymbolsNocase } from '../../utils/symbolLookup.js';
import { normalizeObjectName } from '../../utils/objectNaming.js';
import * as debouncedRefresh from '../../bridge/debouncedRefresh.js';

/** One field, as read from whichever write is adding it. Setters write back to that write's arguments. */
export interface FieldTypeSlot {
  fieldName: string;
  edt?: string;
  enumType?: string;
  /** Primitive type the caller gave (String, Integer, Int64, Real, Date, UtcDateTime, Time, Guid, Container). */
  baseType?: string;
  label?: string;
  stringSize?: number;
  enumValues?: unknown;
  setEdt(name: string): void;
  setEnumType(name: string): void;
  /** Remove the field's own label (it moved to the new type). */
  dropLabel(): void;
}

/** The create arguments every provisioned type shares with the write it serves. */
export interface ProvisionBase {
  modelName?: unknown;
  packageName?: unknown;
  packagePath?: unknown;
  addToProject?: unknown;
  projectPath?: unknown;
  solutionPath?: unknown;
  autoCorrect?: unknown;
}

export interface ProvisionResult {
  /** One line per type created or reused. */
  notes: string[];
  /** Set when a create failed: the field write must not run. */
  error?: string;
}

/** Primitive keyword (any spelling) → the base type name used here, or undefined. */
export function primitiveOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const k = raw.trim().replace(/^AxTableField|^AxEdt/i, '').toLowerCase();
  const map: Record<string, string> = {
    string: 'String', str: 'String',
    integer: 'Integer', int: 'Integer',
    int64: 'Int64',
    real: 'Real',
    date: 'Date',
    utcdatetime: 'UtcDateTime', datetime: 'UtcDateTime',
    time: 'Time',
    guid: 'Guid',
    container: 'Container',
  };
  return map[k];
}

/**
 * The create properties of a new EDT. A reference to a record (Int64, name ending
 * in RecId) extends RefRecId: an EDT on RecId itself, or a bare Int64 one, is not
 * how shipped references are typed (BPErrorTypeExtendsRecId).
 */
function edtProperties(name: string, baseType: string, label: string, stringSize?: number): Record<string, unknown> {
  const props: Record<string, unknown> = { edtType: EDT_I_TYPE[baseType] ?? 'AxEdtString', label };
  if (baseType === 'String' && stringSize) props.stringSize = stringSize;
  if (baseType === 'Int64' && /RecId$/i.test(name)) props.extends = 'RefRecId';
  return props;
}

function describeEdt(baseType: string, props: Record<string, unknown>): string {
  return [baseType, props.stringSize ? `size ${props.stringSize}` : '', props.extends ? `extends ${props.extends}` : '']
    .filter(Boolean)
    .join(', ');
}

const EDT_I_TYPE: Record<string, string> = {
  String: 'AxEdtString', Integer: 'AxEdtInt', Int64: 'AxEdtInt64', Real: 'AxEdtReal', Date: 'AxEdtDate',
  UtcDateTime: 'AxEdtUtcDateTime', Time: 'AxEdtTime', Guid: 'AxEdtGuid', Container: 'AxEdtContainer',
};

/** "ClaimExportDate" → "Claim export date": the raw label text the create turns into a label. */
export function labelTextFor(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/);
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

type Db = Parameters<typeof lookupSymbolsNocase>[0];

function exists(db: Db, name: string, type: 'edt' | 'enum'): boolean {
  if (type === 'edt' && isKernelEdt(name)) return true;
  try {
    return lookupSymbolsNocase(db, name, { types: [type], limit: 1 }).length > 0;
  } catch {
    return true; // cannot tell: never create a duplicate
  }
}

function sameBase(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && primitiveOf(a) === primitiveOf(b);
}

/** Enum values as the enum create takes them, each with a label. */
function enumValueSpecs(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(v => (typeof v === 'string' ? { name: v } : v && typeof v === 'object' ? { ...(v as Record<string, unknown>) } : null))
    .filter((v): v is Record<string, unknown> => !!v && typeof v.name === 'string' && !!v.name)
    .map(v => ({ ...v, label: v.label ?? labelTextFor(v.name as string) }));
}

function request(args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name: 'create_d365fo_file', arguments: args } };
}

function textOf(r: { content?: Array<{ text?: string }> } | undefined): string {
  return (r?.content ?? []).map(c => c.text ?? '').join('\n');
}

/**
 * Create the EDTs and enums `fields` need, and point each field at its type.
 * Runs the creates one at a time; the first failure stops it with `error`.
 */
export async function provisionFieldTypes(
  fields: FieldTypeSlot[],
  base: ProvisionBase,
  context: Pick<XppServerContext, 'symbolIndex' | 'bridge'>,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { notes: [] };
  if (fields.length === 0) return result;
  let db: Db | undefined;
  try { db = context.symbolIndex?.getReadDb?.() as Db | undefined; } catch { db = undefined; }
  if (!db) return result;
  // An index without a single EDT (not built yet, or a write-only companion) is no index for
  // this purpose: every standard EDT would look missing and get a duplicate in the model.
  try {
    if (!db.prepare(`SELECT 1 FROM symbols WHERE type = 'edt' LIMIT 1`).get()) return result;
  } catch {
    return result;
  }

  const model = typeof base.modelName === 'string' ? base.modelName : undefined;
  const createdNow = new Map<string, string>(); // requested name (lower) → written name
  let createdAny = false;

  const create = async (
    objectType: 'edt' | 'enum',
    objectName: string,
    properties: Record<string, unknown>,
  ): Promise<{ name?: string; existed?: boolean; error?: string }> => {
    const key = `${objectType}:${objectName.toLowerCase()}`;
    const done = createdNow.get(key);
    if (done) return { name: done, existed: true };
    const outcome: CreateOutcome = {};
    const created = await handleCreateD365File(
      request({
        objectType,
        objectName,
        properties,
        modelName: base.modelName,
        packageName: base.packageName,
        packagePath: base.packagePath,
        addToProject: base.addToProject,
        projectPath: base.projectPath,
        solutionPath: base.solutionPath,
        autoCorrect: base.autoCorrect,
      }),
      context,
      outcome,
    );
    if (outcome.alreadyExisted && outcome.finalObjectName) {
      createdNow.set(key, outcome.finalObjectName);
      return { name: outcome.finalObjectName, existed: true };
    }
    if (created?.isError || !outcome.finalObjectName) {
      return { error: textOf(created).split('\n').find(l => l.trim()) ?? 'the create failed' };
    }
    createdNow.set(key, outcome.finalObjectName);
    createdAny = true;
    return { name: outcome.finalObjectName };
  };

  for (const f of fields) {
    const label = f.label && f.label.trim() ? f.label : labelTextFor(f.fieldName);

    // ── An enum the field names ──
    if (f.enumType) {
      if (exists(db, f.enumType, 'enum')) continue;
      const values = enumValueSpecs(f.enumValues);
      const r = await create('enum', f.enumType, { label, enumValues: values });
      if (r.error) return { ...result, error: `Creating enum ${f.enumType} for field ${f.fieldName} failed: ${r.error}` };
      f.setEnumType(r.name!);
      if (r.existed) continue;
      f.dropLabel();
      result.notes.push(
        `Created base enum ${r.name} for field ${f.fieldName} (label "${label}"` +
        (values.length > 0
          ? `, values ${values.map(v => v.name).join(', ')}).`
          : `, no values yet: add them with add-enum-value, or pass enumValues).`),
      );
      continue;
    }

    // ── An EDT the field names ──
    if (f.edt) {
      if (exists(db, f.edt, 'edt') || exists(db, f.edt, 'enum')) continue;
      const baseType = primitiveOf(f.baseType) ?? heuristicEdtBaseType(f.edt) ?? 'String';
      const props = edtProperties(f.edt, baseType, label, f.stringSize);
      const r = await create('edt', f.edt, props);
      if (r.error) return { ...result, error: `Creating EDT ${f.edt} for field ${f.fieldName} failed: ${r.error}` };
      f.setEdt(r.name!);
      if (r.existed) continue;
      f.dropLabel();
      result.notes.push(
        `Created EDT ${r.name} (${describeEdt(baseType, props)}, label "${label}") for field ${f.fieldName}.`,
      );
      continue;
    }

    // ── Only a primitive type: the field needs an EDT of its own ──
    const baseType = primitiveOf(f.baseType);
    if (!baseType) continue;
    const predicted = normalizeObjectName(f.fieldName, 'edt', model);
    const reuse = [predicted, f.fieldName].find(
      n => exists(db!, n, 'edt') && sameBase(resolveEdtBaseType(n, db) ?? heuristicEdtBaseType(n), baseType),
    );
    if (reuse) {
      f.setEdt(reuse);
      result.notes.push(`Field ${f.fieldName} uses the existing EDT ${reuse} (${baseType}) instead of a bare ${baseType}.`);
      continue;
    }
    if (exists(db, predicted, 'edt')) {
      return {
        ...result,
        error:
          `Field ${f.fieldName} needs an EDT, and ${predicted} exists with another base type than ${baseType}. ` +
          `Name the EDT to use (or a new one) in the field's edt.`,
      };
    }
    const props = edtProperties(f.fieldName, baseType, label, f.stringSize);
    const r = await create('edt', f.fieldName, props);
    if (r.error) return { ...result, error: `Creating EDT ${f.fieldName} for field ${f.fieldName} failed: ${r.error}` };
    f.setEdt(r.name!);
    if (r.existed) continue;
    f.dropLabel();
    result.notes.push(
      `Created EDT ${r.name} (${describeEdt(baseType, props)}, label "${label}") ` +
      `for field ${f.fieldName}, which had only the primitive type ${baseType} (BPErrorTableFieldNotDefinedUsingType).`,
    );
  }

  // The field write that follows reads the provider: let it see the new types.
  if (createdAny && context.bridge) {
    void debouncedRefresh.refresh(context.bridge);
    await debouncedRefresh.flush();
  }
  return result;
}

/** The reply block for the notes, or ''. */
export function renderProvisionNotes(r: ProvisionResult): string {
  if (r.notes.length === 0) return '';
  return `\n\n🧩 Types for the new fields:\n${r.notes.map(n => `   • ${n}`).join('\n')}`;
}

// ── Adapters: the field shapes of the three writes ──────────────────────────

/** `properties.fields[]` of a table create, or `fields[]` of a scaffold. */
export function slotsFromFieldSpecs(fields: unknown): FieldTypeSlot[] {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as any).name === 'string')
    .map(f => {
      const typeRaw = f.type ?? f.fieldType;
      const primitive = primitiveOf(typeRaw);
      const named = (f.edt ?? f.extendedDataType) as string | undefined;
      const enumField = !!f.enumType || /^(AxTableField)?Enum$/i.test(String(typeRaw ?? ''));
      return {
        fieldName: f.name as string,
        edt: named || undefined,
        enumType: (f.enumType as string | undefined) || undefined,
        baseType: enumField ? undefined : primitive,
        label: typeof f.label === 'string' ? f.label : undefined,
        stringSize: typeof f.stringSize === 'number' ? f.stringSize : undefined,
        enumValues: f.enumValues,
        setEdt(name: string) {
          if (f.extendedDataType !== undefined && f.edt === undefined) f.extendedDataType = name;
          else f.edt = name;
        },
        setEnumType(name: string) { f.enumType = name; },
        dropLabel() { delete f.label; },
      };
    });
}

/** One add-field operation's arguments (table / table-extension). */
export function slotFromAddField(op: Record<string, unknown>): FieldTypeSlot | undefined {
  if (op.operation !== 'add-field' || typeof op.fieldName !== 'string') return undefined;
  const fieldType = typeof op.fieldType === 'string' && op.fieldType ? op.fieldType : undefined;
  // fieldType is the EDT name here; a primitive keyword passed there is a base type.
  const primitive = primitiveOf(op.fieldBaseType) ?? primitiveOf(fieldType);
  return {
    fieldName: op.fieldName,
    edt: fieldType && !primitiveOf(fieldType) ? fieldType : undefined,
    enumType: typeof op.fieldEnumType === 'string' && op.fieldEnumType ? op.fieldEnumType : undefined,
    baseType: primitive,
    label: typeof op.fieldLabel === 'string' ? op.fieldLabel : undefined,
    stringSize: typeof op.fieldStringSize === 'number' ? op.fieldStringSize : undefined,
    enumValues: op.fieldEnumValues,
    setEdt(name: string) { op.fieldType = name; delete op.fieldBaseType; },
    setEnumType(name: string) { op.fieldEnumType = name; },
    dropLabel() { delete op.fieldLabel; },
  };
}
