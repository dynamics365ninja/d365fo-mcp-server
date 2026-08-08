/**
 * Fields Builder — `generate_object(mode="fields")`.
 *
 * Ports TRUDUtils "Fields Builder": turn a plain list of field names (or an
 * Excel-style paste) into ready-to-insert AxTableField XML, with the EDT for
 * each field auto-resolved from the indexed metadata, the correct AxTableField
 * i:type derived from that EDT's base type (so Real/Date/Int64/enum fields don't
 * all collapse to String), and an optional field-group fragment listing them.
 *
 * Pure EDT/type resolution is reused from generateSmartTable so behaviour stays
 * consistent with whole-table scaffolding. Output is text; the caller inserts
 * the fields with d365fo_file(action="modify") add-field on the existing table.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import {
  resolveBestEdt,
  resolveEdtBaseType,
  heuristicEdtBaseType,
  isEnumName,
} from './generateSmartTable.js';
import { axTableFieldElement, baseTypeFromEdtName, normalizeFieldBaseType } from '../utils/axFieldTypes.js';

const FieldSpecSchema = z.object({
  name: z.string().describe('Field name (e.g. "AccountNum").'),
  edt: z.string().optional().describe('Explicit EDT. Omit to auto-resolve from the field name.'),
  enumType: z.string().optional().describe('Enum name for an enum-backed field (sets AxTableFieldEnum).'),
  type: z.string().optional().describe('Explicit base type (String/Integer/Int64/Real/Date/UtcDateTime/Guid).'),
  label: z.string().optional().describe('Field label.'),
  mandatory: z.boolean().optional().describe('Mark the field Mandatory=Yes.'),
});

const TableFieldsArgsSchema = z.object({
  name: z.string().describe('Table the fields belong to (used for context/messaging).'),
  fields: z.array(FieldSpecSchema).optional().describe('Structured field specs. Takes priority over fieldsHint.'),
  fieldsHint: z
    .string()
    .optional()
    .describe('Comma- or newline-separated field names (Excel paste friendly). EDTs auto-resolved.'),
  fieldGroup: z
    .string()
    .optional()
    .describe('Optional field-group name. When set, also emits an AxTableFieldGroup fragment listing the new fields.'),
});

export interface ResolvedField {
  name: string;
  edt?: string;
  enumType?: string;
  type?: string;
  label?: string;
  mandatory?: boolean;
}

/** Map an EDT/base-type pair to the AxTableField i:type, via the one canonical map. */
export function axTableFieldType(edt?: string, type?: string, enumType?: string): string {
  if (enumType) return 'AxTableFieldEnum';
  const explicit = normalizeFieldBaseType(type);
  if (explicit) return axTableFieldElement(explicit);
  const heuristic = baseTypeFromEdtName(edt);
  return heuristic ? axTableFieldElement(heuristic) : 'AxTableFieldString';
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render one <AxTableField> fragment (D365FO generic i:type format). */
export function buildFieldXml(f: ResolvedField): string {
  const iType = axTableFieldType(f.edt, f.type, f.enumType);
  let xml = `<AxTableField xmlns="" i:type="${iType}">\n`;
  xml += `\t<Name>${f.name}</Name>\n`;
  if (f.enumType) xml += `\t<EnumType>${f.enumType}</EnumType>\n`;
  else if (f.edt) xml += `\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
  if (f.mandatory) xml += `\t<Mandatory>Yes</Mandatory>\n`;
  if (f.label) xml += `\t<Label>${escapeXml(f.label)}</Label>\n`;
  xml += `</AxTableField>`;
  return xml;
}

/** Render an <AxTableFieldGroup> fragment listing the given fields. */
export function buildFieldGroupXml(groupName: string, fieldNames: string[]): string {
  let xml = `<AxTableFieldGroup>\n`;
  xml += `\t<Name>${groupName}</Name>\n`;
  xml += `\t<Fields>\n`;
  for (const n of fieldNames) {
    xml += `\t\t<AxTableFieldGroupField>\n\t\t\t<DataField>${n}</DataField>\n\t\t</AxTableFieldGroupField>\n`;
  }
  xml += `\t</Fields>\n`;
  xml += `</AxTableFieldGroup>`;
  return xml;
}

/** Parse a comma/newline-separated hint into field-name tokens. */
export function parseFieldsHint(hint: string): string[] {
  return hint
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve EDT, enum and base type for one field. `db` is the read-only symbol
 * index handle; when null (no index) only explicit values + name heuristics are
 * used. Returns the resolved field plus an optional warning string.
 */
export function resolveField(
  input: ResolvedField,
  db: any,
): { field: ResolvedField; warning?: string } {
  const field: ResolvedField = { ...input };
  let warning: string | undefined;

  if (!field.edt && !field.enumType) {
    field.edt = db ? resolveBestEdt(field.name, db) : field.name;
  }

  // An EDT that is actually an enum → switch to enum-backed field.
  if (field.edt && !field.enumType && db && isEnumName(field.edt, db)) {
    field.enumType = field.edt;
    field.edt = undefined;
  }

  if (field.edt && !field.type) {
    field.type = (db ? resolveEdtBaseType(field.edt, db) : undefined) ?? heuristicEdtBaseType(field.edt);
  }

  return { field, warning };
}

function text(s: string, isError = false) {
  return { content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) };
}

export async function generateTableFieldsTool(
  request: CallToolRequest,
  context: XppServerContext,
) {
  let args: z.infer<typeof TableFieldsArgsSchema>;
  try {
    args = TableFieldsArgsSchema.parse(request.params.arguments);
  } catch (e) {
    return text(`❌ Invalid arguments: ${e instanceof Error ? e.message : String(e)}`, true);
  }

  const { name, fields, fieldsHint, fieldGroup } = args;

  const inputs: ResolvedField[] =
    fields && fields.length > 0
      ? fields
      : fieldsHint
        ? parseFieldsHint(fieldsHint).map((n) => ({ name: n }))
        : [];

  if (inputs.length === 0) {
    return text(`❌ No fields given. Pass \`fields\` (structured) or \`fieldsHint\` (comma/newline list).`, true);
  }

  let db: any = null;
  try {
    db = context.symbolIndex.getReadDb();
  } catch {
    /* index unavailable — resolution falls back to heuristics */
  }

  const resolved: ResolvedField[] = [];
  const warnings: string[] = [];
  for (const input of inputs) {
    const { field, warning } = resolveField(input, db);
    resolved.push(field);
    if (warning) warnings.push(warning);
  }

  const fieldFragments = resolved.map(buildFieldXml).join('\n');
  const groupFragment = fieldGroup ? buildFieldGroupXml(fieldGroup, resolved.map((f) => f.name)) : '';

  const summary = resolved
    .map((f) => `  • ${f.name} → ${f.enumType ? `enum ${f.enumType}` : f.edt ?? '(String)'} (${axTableFieldType(f.edt, f.type, f.enumType)})`)
    .join('\n');

  const parts: string[] = [
    `✅ ${resolved.length} field(s) resolved for table **${name}**:`,
    summary,
  ];
  if (warnings.length > 0) parts.push('', ...warnings);
  parts.push(
    '',
    `Insert each field with \`d365fo_file(action="modify", objectType="table", objectName="${name}", ...)\` add-field.`,
    '',
    '```xml',
    fieldFragments,
    '```',
  );
  if (groupFragment) {
    parts.push('', `Field group **${fieldGroup}**:`, '```xml', groupFragment, '```');
  }

  return text(parts.join('\n'));
}
