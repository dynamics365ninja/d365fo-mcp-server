/**
 * Find Method generator — `generate_object(mode="find-methods")`.
 *
 * Ports TRUDUtils "Create Find Method": generates the standard static
 * find()/findRecId()/exists() methods for a table, keyed on the table's primary
 * (unique) index. The method bodies follow Microsoft's shipped convention
 * (selectForUpdate guard, firstonly, key null-guard) so the output compiles and
 * matches BP expectations without manual rewriting.
 *
 * Data source priority mirrors tableInfo: C# bridge (authoritative — gives index
 * + EDT info) → explicit keyFields arg (DB-only environments, where index data
 * is not in the symbol index). Without either, findRecId()/exists-by-RecId are
 * still emitted (RecId always exists) and a note explains how to get key-based
 * finds.
 *
 * Output is text X++; the caller inserts it with d365fo_file(action="modify",
 * add-method) — these methods live on an EXISTING table, so no prefix applies.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { lookupSymbolNocase } from '../../utils/symbolLookup.js';

const FindMethodsArgsSchema = z.object({
  name: z.string().describe('Table name to generate find methods for (e.g. "CustTable").'),
  keyFields: z
    .array(z.string())
    .optional()
    .describe(
      'Explicit key field names for find()/exists(), in order. Overrides index detection. ' +
        'Use this when the bridge is unavailable (the symbol index does not carry index metadata).',
    ),
  includeExists: z.boolean().optional().default(true).describe('Emit exists() (default true).'),
  includeFindRecId: z.boolean().optional().default(true).describe('Emit findRecId() (default true).'),
});

/** Minimal table shape the generator needs — decoupled from the bridge type. */
export interface FindMethodTableShape {
  name: string;
  /** Primary index name, when known (bridge.primaryIndex). */
  primaryIndex?: string;
  fields: Array<{ name: string; extendedDataType?: string; fieldType?: string }>;
  indexes: Array<{ name: string; allowDuplicates: boolean; fields: string[] }>;
}

export interface FindMethodKeyField {
  /** Field name as declared on the table. */
  field: string;
  /** X++ parameter type — the field's EDT, else its base field type, else a safe default. */
  type: string;
}

/** lower-camelCase buffer variable name for a table, e.g. CustTable → custTable. */
export function bufferName(table: string): string {
  return table.length > 0 ? table[0].toLowerCase() + table.slice(1) : table;
}

/**
 * Resolve the key fields find()/exists() should select on. Preference:
 *   1. explicit override
 *   2. the declared primary index
 *   3. the first unique (allowDuplicates=false) index
 * Returns [] when no unique key can be determined.
 */
export function resolveKeyFields(
  table: FindMethodTableShape,
  override?: string[],
): FindMethodKeyField[] {
  const typeOf = (fieldName: string): string => {
    const f = table.fields.find((x) => x.name.toLowerCase() === fieldName.toLowerCase());
    return f?.extendedDataType || f?.fieldType || 'str';
  };
  const toKeys = (names: string[]): FindMethodKeyField[] =>
    names.map((n) => ({ field: n, type: typeOf(n) }));

  if (override && override.length > 0) return toKeys(override);

  if (table.primaryIndex) {
    const pk = table.indexes.find((i) => i.name.toLowerCase() === table.primaryIndex!.toLowerCase());
    if (pk && pk.fields.length > 0) return toKeys(pk.fields);
  }
  const unique = table.indexes.find((i) => !i.allowDuplicates && i.fields.length > 0);
  if (unique) return toKeys(unique.fields);

  return [];
}

/** camelCase parameter name for a key field, e.g. AccountNum → _accountNum. */
function paramName(field: string): string {
  return '_' + field[0].toLowerCase() + field.slice(1);
}

/**
 * Render find()/findRecId()/exists() for a table. Pure — unit-testable without
 * a bridge. When `keys` is empty, key-based find()/exists() are skipped and only
 * findRecId() (always valid via the system RecId field) is produced.
 */
export function buildFindMethods(
  table: FindMethodTableShape,
  keys: FindMethodKeyField[],
  opts: { includeExists?: boolean; includeFindRecId?: boolean } = {},
): string {
  const { includeExists = true, includeFindRecId = true } = opts;
  const buf = bufferName(table.name);
  const blocks: string[] = [];

  if (keys.length > 0) {
    const params = keys.map((k) => `${k.type} ${paramName(k.field)}`).join(', ');
    const guard = keys.map((k) => paramName(k.field)).join(' && ');
    const whereClause = keys
      .map((k, i) => `${i === 0 ? '' : '\n           && '}${buf}.${k.field} == ${paramName(k.field)}`)
      .join('');

    blocks.push(
      `/// <summary>\n` +
        `/// Finds the <c>${table.name}</c> record matching the supplied key.\n` +
        `/// </summary>\n` +
        `public static ${table.name} find(${params}, boolean _forUpdate = false)\n` +
        `{\n` +
        `    ${table.name} ${buf};\n\n` +
        `    if (${guard})\n` +
        `    {\n` +
        `        ${buf}.selectForUpdate(_forUpdate);\n\n` +
        `        select firstonly ${buf}\n` +
        `            where ${whereClause};\n` +
        `    }\n\n` +
        `    return ${buf};\n` +
        `}`,
    );

    if (includeExists) {
      const existsWhere = keys
        .map((k, i) => `${i === 0 ? '' : '\n               && '}${buf}.${k.field} == ${paramName(k.field)}`)
        .join('');
      blocks.push(
        `/// <summary>\n` +
          `/// Determines whether a <c>${table.name}</c> record exists for the supplied key.\n` +
          `/// </summary>\n` +
          `public static boolean exists(${params})\n` +
          `{\n` +
          `    return ${guard}\n` +
          `        && (select firstonly RecId from ${buf}\n` +
          `               where ${existsWhere}).RecId != 0;\n` +
          `}`,
      );
    }
  }

  if (includeFindRecId) {
    blocks.push(
      `/// <summary>\n` +
        `/// Finds the <c>${table.name}</c> record with the supplied <c>RecId</c>.\n` +
        `/// </summary>\n` +
        `public static ${table.name} findRecId(RefRecId _recId, boolean _forUpdate = false)\n` +
        `{\n` +
        `    ${table.name} ${buf};\n\n` +
        `    if (_recId)\n` +
        `    {\n` +
        `        ${buf}.selectForUpdate(_forUpdate);\n\n` +
        `        select firstonly ${buf}\n` +
        `            where ${buf}.RecId == _recId;\n` +
        `    }\n\n` +
        `    return ${buf};\n` +
        `}`,
    );
  }

  return blocks.join('\n\n');
}

function text(s: string, isError = false) {
  return { content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) };
}

export async function generateFindMethodsTool(
  request: CallToolRequest,
  context: XppServerContext,
) {
  let args: z.infer<typeof FindMethodsArgsSchema>;
  try {
    args = FindMethodsArgsSchema.parse(request.params.arguments);
  } catch (e) {
    return text(`❌ Invalid arguments: ${e instanceof Error ? e.message : String(e)}`, true);
  }

  const { name, keyFields, includeExists, includeFindRecId } = args;

  // 1. Bridge — authoritative; carries index + EDT info the symbol index lacks.
  let table: FindMethodTableShape | undefined;
  const bridge = context.bridge;
  if (bridge?.isReady && bridge.metadataAvailable) {
    try {
      const t = await bridge.readTable(name);
      if (t) {
        table = {
          name: t.name,
          primaryIndex: t.primaryIndex,
          fields: t.fields.map((f) => ({
            name: f.name,
            extendedDataType: f.extendedDataType,
            fieldType: f.fieldType,
          })),
          indexes: t.indexes.map((i) => ({
            name: i.name,
            allowDuplicates: i.allowDuplicates,
            fields: i.fields,
          })),
        };
      }
    } catch {
      /* fall through to DB-backed shape */
    }
  }

  // 2. DB fallback — fields only (no index metadata). Key-based finds then
  //    require an explicit keyFields arg.
  if (!table) {
    try {
      const db = context.symbolIndex.getReadDb();
      // Canonicalize first — `parent_name = ? COLLATE NOCASE` cannot use
      // idx_parent_type_name and scans all 360k field rows (180 s cold).
      const canonical = lookupSymbolNocase(db, name)?.name ?? name;
      const rows = db
        .prepare(
          `SELECT name, signature FROM symbols WHERE type = 'field' AND parent_name = ? ORDER BY name`,
        )
        .all(canonical) as Array<{ name: string; signature: string | null }>;
      if (rows.length === 0) {
        return text(
          `❌ Table "${name}" not found via bridge or symbol index.\n\n` +
            `If it was just created, call update_symbol_index first, then retry.`,
          true,
        );
      }
      table = {
        name,
        fields: rows.map((r) => ({ name: r.name, fieldType: r.signature ?? undefined })),
        indexes: [],
      };
    } catch {
      return text(`❌ Could not read table "${name}" (no bridge and symbol index unavailable).`, true);
    }
  }

  const keys = resolveKeyFields(table, keyFields);
  const noKeyNote =
    keys.length === 0
      ? `\n\n> ⚠️ No unique key could be determined for **${name}** ` +
        `${table.indexes.length === 0 ? '(index metadata unavailable — running without the C# bridge)' : '(no unique index found)'}. ` +
        `Only \`findRecId()\` was generated. Pass \`keyFields: ["Field1", ...]\` to also generate key-based \`find()\`/\`exists()\`.`
      : '';

  if (keys.length === 0 && !includeFindRecId) {
    return text(
      `❌ Nothing to generate for "${name}": no key fields resolved and includeFindRecId=false.` +
        `\n\nPass keyFields explicitly, or enable findRecId.`,
      true,
    );
  }

  const code = buildFindMethods(table, keys, { includeExists, includeFindRecId });
  const keySummary =
    keys.length > 0 ? `Keyed on: ${keys.map((k) => k.field).join(', ')}` : 'RecId only';

  return text(
    `✅ Find methods for **${name}** (${keySummary})\n\n` +
      `Insert each method with \`d365fo_file(action="modify", objectType="table", objectName="${name}", ...)\` ` +
      `add-method, or add to the table's class declaration.${noKeyNote}\n\n` +
      `\`\`\`xpp\n${code}\n\`\`\``,
  );
}
