/**
 * Get EDT Info Tool
 * Extract Extended Data Type (EDT) properties from AxEdt metadata
 *
 * Standard mode: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * Hierarchy mode: SQLite (edt_metadata table) — ancestor chain walk + children + field usages.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeEdt } from '../bridge/bridgeAdapter.js';
import { canonicalSymbolName, lookupSymbolNocase } from '../utils/symbolLookup.js';

const GetEdtInfoArgsSchema = z.object({
  edtName: z.string().describe('Name of the Extended Data Type (EDT)'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
  mode: z.enum(['standard', 'hierarchy']).optional().default('standard')
    .describe('standard=normal EDT details, hierarchy=show ancestor chain + children + field usages'),
});

export async function getEdtInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEdtInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { edtName, modelName } = args;

    // Hierarchy mode: ancestor chain + children + field usages (SQLite only)
    if (args.mode === 'hierarchy') {
      return getEdtHierarchy(symbolIndex.getReadDb(), edtName, modelName);
    }

    // Standard mode: C# bridge (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeEdt(context.bridge, edtName);
    if (bridgeResult) return bridgeResult;

    // Bridge returned nothing. That is NOT evidence the EDT is missing — it also
    // happens when the bridge is unavailable, when it errored, or when its
    // provider simply didn't resolve the name (#14: Num / Notes / CustAccount all
    // returned "Bridge returned no data" while the very same EDTs resolved through
    // validate_code(references) and appeared in search). Falling through to the
    // SQLite index is both a real answer and the honest one.
    const sqliteResult = getEdtFromIndex(symbolIndex, edtName, modelName);
    if (sqliteResult) return sqliteResult;

    return {
      content: [{
        type: 'text',
        text:
          `No data available for EDT "${edtName}".\n\n` +
          `Neither source could answer:\n` +
          `  • C# bridge (IMetadataProvider): returned no data — it is either unavailable, ` +
          `or it could not resolve this name.\n` +
          `  • SQLite symbol index (edt_metadata / symbols): no row for this name.\n\n` +
          `⚠️ This is "no data", NOT proof the EDT does not exist. Standard EDTs are routinely ` +
          `resolvable through other paths — before changing working code, cross-check with ` +
          `search(type="edt", query="${edtName}") or validate_code(mode="references").\n` +
          `If the EDT was created in this session, index it first: update_symbol_index(filePath=<AxEdt xml>).`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting EDT info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Standard-mode SQLite fallback (#14).
 *
 * QUERY PLAN: `edt_metadata WHERE edt_name = ?` is an equality probe served by
 * idx_edt_metadata_name (and idx_edt_metadata_unique when a model is given).
 * A differently-cased name is canonicalized through `lookupSymbolNocase`
 * (exact-case probe on idx_name_type + bounded FTS phrase fallback) rather than
 * with `COLLATE NOCASE` / `LIKE`, which would scan the 1.17M-row symbols table.
 *
 * Returns null when the index has nothing, so the caller can say so plainly.
 */
function getEdtFromIndex(symbolIndex: any, edtName: string, modelName?: string) {
  let db: any;
  try {
    db = symbolIndex?.getReadDb?.();
  } catch {
    return null;
  }
  if (!db) return null;

  const readRow = (name: string) => {
    try {
      return db.prepare(
        `SELECT edt_name, extends, enum_type, reference_table, relation_type,
                string_size, database_string_size, display_length, label, model
         FROM edt_metadata WHERE edt_name = ?${modelName ? ' AND model = ?' : ''} LIMIT 1`,
      ).get(...(modelName ? [name, modelName] : [name])) as any;
    } catch {
      return undefined;
    }
  };

  let row = readRow(edtName);
  let resolvedName = edtName;

  if (!row) {
    // Canonicalize the caller's casing through the index-safe symbol lookup.
    const canonical = canonicalSymbolName(db, edtName, ['edt']);
    if (canonical && canonical !== edtName) {
      resolvedName = canonical;
      row = readRow(canonical);
    }
  }

  if (!row) {
    // No edt_metadata row, but the symbols table may still know the EDT exists
    // (e.g. indexed by update_symbol_index before edt_metadata was populated).
    const hit = lookupSymbolNocase(db, edtName, ['edt']);
    if (!hit) return null;
    return {
      content: [{
        type: 'text',
        text:
          `# Extended Data Type: ${hit.name}\n\n` +
          (hit.model ? `**Model:** ${hit.model}\n` : '') +
          `_Source: SQLite symbol index (bridge returned no data)_\n\n` +
          `⚠️ Only the symbol entry is indexed — no \`edt_metadata\` row, so base type / string size / ` +
          `reference table are NOT available from this server. This is missing data, not an empty EDT.\n` +
          (hit.file_path ? `\nFile: ${hit.file_path}\n` : ''),
      }],
    };
  }

  let out = `# Extended Data Type: ${row.edt_name ?? resolvedName}\n\n`;
  if (row.model) out += `**Model:** ${row.model}\n`;
  out += `_Source: SQLite symbol index (edt_metadata) — the C# bridge returned no data_\n\n`;
  out += `## 🔧 Core Properties\n\n`;
  out += `| Property | Value |\n|---|---|\n`;
  out += `| Extends | ${row.extends || '—'} |\n`;
  if (row.enum_type) out += `| Enum Type | ${row.enum_type} |\n`;
  if (row.reference_table) out += `| Reference Table | ${row.reference_table} |\n`;
  if (row.relation_type) out += `| Relation Type | ${row.relation_type} |\n`;
  if (row.string_size) out += `| String Size | ${row.string_size} |\n`;
  if (row.database_string_size) out += `| Database String Size | ${row.database_string_size} |\n`;
  if (row.display_length) out += `| Display Length | ${row.display_length} |\n`;
  if (row.label) out += `| Label | ${row.label} |\n`;
  out += `\nℹ️ Indexed metadata only — properties the extractor does not store ` +
    `(HelpText, FormHelp, ConfigurationKey, Alignment…) are absent here, not absent from the EDT.\n`;

  return { content: [{ type: 'text', text: out }] };
}

/**
 * Hierarchy mode: walk ancestor chain, find children, and show field usages
 */
function getEdtHierarchy(db: any, edtName: string, modelName?: string) {
  // Ancestor chain walk
  const chain: Array<{ name: string; model: string; extends?: string; label?: string; stringSize?: string }> = [];
  let current = edtName;
  const visited = new Set<string>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const row = db.prepare(`
      SELECT edt_name, model, extends, label, string_size
      FROM edt_metadata WHERE edt_name = ?
      ${modelName ? 'AND model = ?' : ''}
      LIMIT 1
    `).get(...(modelName ? [current, modelName] : [current])) as any;

    if (!row) break;
    chain.push({ name: row.edt_name, model: row.model, extends: row.extends, label: row.label, stringSize: row.string_size });
    current = row.extends;
  }

  if (chain.length === 0) {
    return { content: [{ type: 'text', text: `EDT not found in edt_metadata: ${edtName}\n\nRun extract-metadata to index EDT metadata.` }], isError: true };
  }

  // Direct children (EDTs that extend this one)
  const children = db.prepare(
    `SELECT edt_name, model, label FROM edt_metadata WHERE extends = ? ORDER BY model, edt_name`
  ).all(edtName) as any[];

  // Field usages (fields using this EDT by name)
  const fieldUsages = db.prepare(
    `SELECT parent_name, name, model FROM symbols WHERE type = 'field' AND signature LIKE ? ORDER BY model, parent_name LIMIT 50`
  ).all(`%${edtName}%`) as any[];

  let output = `EDT Hierarchy: ${edtName}\n\n`;

  // Ancestor chain
  output += `Ancestor Chain (${chain.length} level(s)):\n`;
  output += `  ${chain.map(e => e.name).join(' → ')}\n\n`;

  for (const e of chain) {
    output += `  ${e.name.padEnd(35)} Model: ${e.model}`;
    if (e.label) output += `, Label: ${e.label}`;
    if (e.stringSize) output += `, StringSize: ${e.stringSize}`;
    if (e.extends) output += ` [extends ${e.extends}]`;
    output += '\n';
  }

  // Children
  output += `\nDirect Children (${children.length} EDT(s) extending ${edtName}):\n`;
  if (children.length === 0) {
    output += `  (none)\n`;
  } else {
    for (const c of children.slice(0, 20)) {
      output += `  ${c.edt_name} [${c.model}]`;
      if (c.label) output += ` — ${c.label}`;
      output += '\n';
    }
    if (children.length > 20) output += `  ... and ${children.length - 20} more\n`;
  }

  // Field usages
  output += `\nField Usages (top ${Math.min(fieldUsages.length, 50)}):\n`;
  if (fieldUsages.length === 0) {
    output += `  No fields indexed with this EDT name in signature\n`;
  } else {
    for (const f of fieldUsages.slice(0, 10)) {
      output += `  ${f.parent_name}.${f.name} [${f.model}]\n`;
    }
    if (fieldUsages.length > 10) output += `  ... and ${fieldUsages.length - 10} more (${fieldUsages.length} total)\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
