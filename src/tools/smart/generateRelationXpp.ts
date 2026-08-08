/**
 * Relation-to-X++ generator — `generate_object(mode="relation-xpp")`.
 *
 * Ports TRUDUtils "Relation to Xpp": turns a table's relation(s) into ready-to-use
 * X++ — a `select` statement that joins the related table, and an equivalent
 * QueryBuildDataSource/addRange snippet. Field/value constraints are honoured
 * (field == relatedField, and fixed-value constraints become literal ranges).
 *
 * Data source priority mirrors tableInfo: C# bridge (authoritative for relation
 * metadata) → error if unavailable (the symbol index does not carry relations).
 * Output is text X++ the caller pastes into a method body.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { bufferName } from './generateFindMethods.js';

const RelationXppArgsSchema = z.object({
  name: z.string().describe('Table name whose relations to convert (e.g. "SalesLine").'),
  relationName: z
    .string()
    .optional()
    .describe('Optional: a single relation to convert. Omit to convert all relations.'),
  style: z
    .enum(['select', 'query', 'both'])
    .optional()
    .default('both')
    .describe('Output form: "select" statement, "query" (QueryBuildRange), or "both" (default).'),
});

export interface RelationConstraintShape {
  field?: string;
  relatedField?: string;
  value?: string;
}

export interface RelationShape {
  name: string;
  relatedTable: string;
  constraints: RelationConstraintShape[];
}

/**
 * Render a `select` statement that fetches the related record for one relation.
 * `sourceBuf` is the buffer name of the table that owns the relation.
 */
export function buildRelationSelect(sourceTable: string, rel: RelationShape): string {
  const sourceBuf = bufferName(sourceTable);
  const relBuf = bufferName(rel.relatedTable);
  const conds = rel.constraints
    .filter((c) => c.relatedField)
    .map((c) =>
      c.field
        ? `${relBuf}.${c.relatedField} == ${sourceBuf}.${c.field}`
        : `${relBuf}.${c.relatedField} == ${c.value ?? '/* value */'}`,
    );

  const where =
    conds.length > 0
      ? conds.map((c, i) => `${i === 0 ? '' : '\n           && '}${c}`).join('')
      : '/* TODO: no field constraints on this relation */ true';

  return (
    `${rel.relatedTable} ${relBuf};\n` +
    `select firstonly ${relBuf}\n` +
    `    where ${where};`
  );
}

/**
 * Render a QueryBuildDataSource + addRange snippet for one relation. Field
 * constraints become ranges driven by the source buffer; fixed-value constraints
 * become literal ranges.
 */
export function buildRelationQuery(sourceTable: string, rel: RelationShape): string {
  const sourceBuf = bufferName(sourceTable);
  const qbdsVar = `qbds${rel.relatedTable}`;

  const ranges = rel.constraints
    .filter((c) => c.relatedField)
    .map((c) => {
      const fieldRef = `fieldNum(${rel.relatedTable}, ${c.relatedField})`;
      if (c.field) {
        return (
          `${qbdsVar}.addRange(${fieldRef})\n` +
          `    .value(queryValue(${sourceBuf}.${c.field}));`
        );
      }
      return `${qbdsVar}.addRange(${fieldRef})\n    .value(queryValue(${c.value ?? '/* value */'}));`;
    });

  return (
    `QueryBuildDataSource ${qbdsVar} = query.addDataSource(tableNum(${rel.relatedTable}));\n` +
    (ranges.length > 0
      ? ranges.join('\n')
      : `// TODO: relation "${rel.name}" has no field constraints`)
  );
}

/** Render the requested style(s) for one relation, with a heading comment. */
export function buildRelationXpp(
  sourceTable: string,
  rel: RelationShape,
  style: 'select' | 'query' | 'both',
): string {
  const parts: string[] = [`// Relation: ${rel.name} → ${rel.relatedTable}`];
  if (style === 'select' || style === 'both') {
    parts.push(buildRelationSelect(sourceTable, rel));
  }
  if (style === 'query' || style === 'both') {
    if (style === 'both') parts.push('// As a query range:');
    parts.push(buildRelationQuery(sourceTable, rel));
  }
  return parts.join('\n');
}

function text(s: string, isError = false) {
  return { content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) };
}

export async function generateRelationXppTool(
  request: CallToolRequest,
  context: XppServerContext,
) {
  let args: z.infer<typeof RelationXppArgsSchema>;
  try {
    args = RelationXppArgsSchema.parse(request.params.arguments);
  } catch (e) {
    return text(`❌ Invalid arguments: ${e instanceof Error ? e.message : String(e)}`, true);
  }

  const { name, relationName, style } = args;

  const bridge = context.bridge;
  if (!bridge?.isReady || !bridge.metadataAvailable) {
    return text(
      `❌ relation-xpp needs the C# metadata bridge — relation metadata is not stored in the symbol index.\n\n` +
        `Run on the Windows VM with the bridge built (bridge\\D365MetadataBridge), then retry.`,
      true,
    );
  }

  let t;
  try {
    t = await bridge.readTable(name);
  } catch (e) {
    return text(`❌ Bridge readTable("${name}") failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (!t) {
    return text(`❌ Table "${name}" not found via the bridge.`, true);
  }

  let relations: RelationShape[] = t.relations.map((r) => ({
    name: r.name,
    relatedTable: r.relatedTable,
    constraints: r.constraints,
  }));

  if (relationName) {
    const match = relations.find((r) => r.name.toLowerCase() === relationName.toLowerCase());
    if (!match) {
      const available = relations.map((r) => r.name).join(', ') || '(none)';
      return text(
        `❌ Relation "${relationName}" not found on "${name}".\n\nAvailable relations: ${available}`,
        true,
      );
    }
    relations = [match];
  }

  if (relations.length === 0) {
    return text(`ℹ️ Table "${name}" has no relations to convert.`);
  }

  const code = relations.map((r) => buildRelationXpp(name, r, style)).join('\n\n');

  return text(
    `✅ X++ for ${relations.length} relation(s) on **${name}** (style: ${style})\n\n` +
      `\`\`\`xpp\n${code}\n\`\`\``,
  );
}
