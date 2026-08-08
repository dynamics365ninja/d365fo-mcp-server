/**
 * Create Table Relation — `generate_object(mode="table-relation")`.
 *
 * Ports TRUDUtils "Create Table Relation": for a field whose EDT carries an
 * implicit reference to another table, generate the explicit <AxTableRelation>
 * D365FO now requires (EDT relations must be migrated to table relations —
 * BPErrorEDTNotMigrated). The reference table comes from the indexed
 * edt_metadata.reference_table, so this works in DB-only/Azure environments too.
 *
 * This is the inverse of mode="relation-xpp" (which turns existing relations
 * into X++). Output is text; insert the fragments with d365fo_file.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { lookupSymbolNocase } from '../../utils/symbolLookup.js';

const TableRelationArgsSchema = z.object({
  name: z.string().describe('Table whose fields to generate relations for (e.g. "MyOrderLine").'),
  // Accept plain field names or the shared {name,...} field-spec form (the
  // generate_object `fields` array is shared with other modes).
  fields: z
    .array(z.union([z.string(), z.object({ name: z.string() }).passthrough()]))
    .optional()
    .describe('Specific field names to generate relations for. Omit to scan all EDT-referencing fields.'),
});

/** Normalize the tolerant `fields` arg to a list of field-name strings. */
function fieldNames(fields: TableRelationArgs['fields']): string[] | undefined {
  if (!fields || fields.length === 0) return undefined;
  return fields.map((f) => (typeof f === 'string' ? f : f.name));
}

type TableRelationArgs = z.infer<typeof TableRelationArgsSchema>;

export interface TableRelationSpec {
  name: string;
  relatedTable: string;
  constraints: Array<{ field: string; relatedField: string }>;
  cardinality?: string;
  relatedTableCardinality?: string;
  relationshipType?: string;
}

/** Render one <AxTableRelation> fragment (matches createD365File / smartXmlBuilder format). */
export function buildTableRelationXml(rel: TableRelationSpec): string {
  const cardinality = rel.cardinality ?? 'ZeroMore';
  const relatedCardinality = rel.relatedTableCardinality ?? 'ExactlyOne';
  const relationshipType = rel.relationshipType ?? 'Association';

  let xml = `<AxTableRelation>\n`;
  xml += `\t<Name>${rel.name}</Name>\n`;
  xml += `\t<Cardinality>${cardinality}</Cardinality>\n`;
  xml += `\t<RelatedTable>${rel.relatedTable}</RelatedTable>\n`;
  xml += `\t<RelatedTableCardinality>${relatedCardinality}</RelatedTableCardinality>\n`;
  xml += `\t<RelationshipType>${relationshipType}</RelationshipType>\n`;
  if (rel.constraints.length === 0) {
    xml += `\t<Constraints />\n`;
  } else {
    xml += `\t<Constraints>\n`;
    for (const c of rel.constraints) {
      xml += `\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">\n`;
      xml += `\t\t\t<Name>${c.field}</Name>\n`;
      xml += `\t\t\t<Field>${c.field}</Field>\n`;
      xml += `\t\t\t<RelatedField>${c.relatedField}</RelatedField>\n`;
      xml += `\t\t</AxTableRelationConstraint>\n`;
    }
    xml += `\t</Constraints>\n`;
  }
  xml += `</AxTableRelation>`;
  return xml;
}

/** A table field with its resolved EDT. */
interface FieldEdt {
  name: string;
  edt?: string;
}

const SYSTEM_FIELDS = new Set(['recid', 'recversion', 'dataareaid', 'partition', 'createdby', 'createddatetime', 'modifiedby', 'modifieddatetime']);

function text(s: string, isError = false) {
  return { content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) };
}

export async function generateTableRelationTool(
  request: CallToolRequest,
  context: XppServerContext,
) {
  let args: z.infer<typeof TableRelationArgsSchema>;
  try {
    args = TableRelationArgsSchema.parse(request.params.arguments);
  } catch (e) {
    return text(`❌ Invalid arguments: ${e instanceof Error ? e.message : String(e)}`, true);
  }

  const { name } = args;
  const fieldFilter = fieldNames(args.fields);

  // Resolve the table's fields + EDTs. Bridge is authoritative; DB fallback uses
  // the field row's signature (which carries the EDT name for table fields).
  let tableFields: FieldEdt[] | undefined;
  const bridge = context.bridge;
  if (bridge?.isReady && bridge.metadataAvailable) {
    try {
      const t = await bridge.readTable(name);
      if (t) tableFields = t.fields.map((f) => ({ name: f.name, edt: f.extendedDataType }));
    } catch {
      /* fall through to DB */
    }
  }

  const db = (() => {
    try {
      return context.symbolIndex.getReadDb();
    } catch {
      return null;
    }
  })();

  if (!tableFields) {
    if (!db) {
      return text(`❌ Could not read table "${name}" (no bridge and symbol index unavailable).`, true);
    }
    // Canonicalize first — `parent_name = ? COLLATE NOCASE` cannot use
    // idx_parent_type_name and scans all 360k field rows (180 s cold).
    const canonical = lookupSymbolNocase(db, name)?.name ?? name;
    const rows = db
      .prepare(`SELECT name, signature FROM symbols WHERE type = 'field' AND parent_name = ? ORDER BY name`)
      .all(canonical) as Array<{ name: string; signature: string | null }>;
    if (rows.length === 0) {
      return text(
        `❌ Table "${name}" not found via bridge or symbol index.\n\nIf it was just created, call update_symbol_index first.`,
        true,
      );
    }
    tableFields = rows.map((r) => ({ name: r.name, edt: r.signature ?? undefined }));
  }

  if (!db) {
    return text(
      `❌ table-relation needs the symbol index (edt_metadata) to resolve EDT reference tables. Build/refresh the index, then retry.`,
      true,
    );
  }

  const wanted = fieldFilter && fieldFilter.length > 0
    ? new Set(fieldFilter.map((f) => f.toLowerCase()))
    : null;

  const refStmt = db.prepare(
    `SELECT reference_table FROM edt_metadata WHERE edt_name = ? AND reference_table IS NOT NULL AND reference_table != '' LIMIT 1`,
  );

  const relations: TableRelationSpec[] = [];
  const skipped: string[] = [];
  for (const f of tableFields) {
    if (SYSTEM_FIELDS.has(f.name.toLowerCase())) continue;
    if (wanted && !wanted.has(f.name.toLowerCase())) continue;
    if (!f.edt) {
      if (wanted) skipped.push(`${f.name}: no EDT on the field`);
      continue;
    }
    const row = refStmt.get(f.edt) as { reference_table: string } | undefined;
    if (!row?.reference_table) {
      if (wanted) skipped.push(`${f.name} (${f.edt}): EDT carries no reference table`);
      continue;
    }
    // The EDT name is the canonical PK field name on the target table
    // (e.g. ItemId → InventTable.ItemId, WHSZoneId → WHSZone.WHSZoneId).
    relations.push({
      name: f.name,
      relatedTable: row.reference_table,
      constraints: [{ field: f.name, relatedField: f.edt }],
    });
  }

  if (relations.length === 0) {
    const detail = skipped.length > 0 ? `\n\n${skipped.map((s) => `  • ${s}`).join('\n')}` : '';
    return text(
      `ℹ️ No EDT-backed table relations found for **${name}**.${detail}\n\n` +
        `Only fields whose EDT declares a reference table (edt_metadata.reference_table) produce a relation.`,
      true,
    );
  }

  const fragments = relations.map(buildTableRelationXml).join('\n');
  const summary = relations
    .map((r) => `  • ${r.name} → ${r.relatedTable}.${r.constraints[0].relatedField}`)
    .join('\n');

  const parts = [
    `✅ ${relations.length} table relation(s) for **${name}**:`,
    summary,
  ];
  if (skipped.length > 0) parts.push('', 'Skipped:', ...skipped.map((s) => `  • ${s}`));
  parts.push(
    '',
    `Insert each relation with \`d365fo_file(action="modify", objectType="table", objectName="${name}", ...)\`, ` +
      `or add to the table's <Relations> block.`,
    '',
    '```xml',
    fragments,
    '```',
  );
  return text(parts.join('\n'));
}
