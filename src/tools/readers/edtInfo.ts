/**
 * Get EDT Info Tool
 * Extract Extended Data Type (EDT) properties from AxEdt metadata
 *
 * Standard mode: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * Hierarchy mode: SQLite (edt_metadata table) — ancestor chain walk + children + field usages.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { tryBridgeEdt } from '../../bridge/bridgeAdapter.js';
import { canonicalSymbolName, lookupSymbolNocase } from '../../utils/symbolLookup.js';

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
  // A derived EDT usually declares no StringSize, so `string_size` is null for 12 354 of
  // the 25 332 indexed EDTs and this row used to be silently omitted for all of them.
  // The value sits on the nearest ancestor that does declare one.
  const size = resolveIndexedStringSize(db, row);
  if (size) {
    const from = size.inheritedFrom ? ` (inherited from ${size.inheritedFrom})` : '';
    const shown = size.value === '-1' ? '-1 (memo, unlimited)' : size.value;
    out += `| String Size | ${shown}${from} |\n`;
  }
  if (row.database_string_size) out += `| Database String Size | ${row.database_string_size} |\n`;
  if (row.display_length) out += `| Display Length | ${row.display_length} |\n`;
  if (row.label) out += `| Label | ${row.label} |\n`;
  out += `\nℹ️ Indexed metadata only — properties the extractor does not store ` +
    `(HelpText, FormHelp, ConfigurationKey, Alignment…) are absent here, not absent from the EDT.\n`;

  return { content: [{ type: 'text', text: out }] };
}

/**
 * The string size an indexed EDT really has, plus the ancestor it came from.
 *
 * A derived EDT usually declares no StringSize, leaving `edt_metadata.string_size` empty for
 * 12 354 of the 25 332 indexed EDTs -- and this row used to be omitted for all of them even
 * though the value sits an `extends` hop or two away. So: use the EDT's own size when it has
 * one, otherwise walk `extends` to the nearest ancestor that stores one. Guards against a
 * cycle and against a dangling `extends` (AmountMST names MoneyMST, which ships no AxEdt
 * file).
 *
 * A child MAY declare its own size -- 228 do, permitted when the base carries
 * StringSizeIsExtensible = Yes -- so a stored value is authoritative here and is not
 * overridden.
 *
 * Known limitation of this path: `edt_metadata` does not store StringSizeIsExtensible, so it
 * cannot tell when a declared size is overridden by an ancestor's. Where StringSizeIsExtensible
 * is not Yes and the declared value is smaller than the nearest declaring ancestor's, the
 * platform uses the ancestor's -- PartyName declares 100 under DirPartyName's 160 and really is
 * 160, and this path reports the declared 100. That affects 4 EDTs in the shipped corpus, and
 * only here: the bridge, which is the normal source, defers to Microsoft's resolver.
 */
function resolveIndexedStringSize(
  db: any,
  row: any,
): { value: string; inheritedFrom?: string } | null {
  if (row.string_size) return { value: String(row.string_size) };

  const seen = new Set<string>([String(row.edt_name ?? '').toLowerCase()]);
  let next: string | undefined = row.extends || undefined;

  while (next && !seen.has(next.toLowerCase())) {
    seen.add(next.toLowerCase());
    let ancestor: any;
    try {
      ancestor = db.prepare(
        'SELECT edt_name, extends, string_size FROM edt_metadata WHERE edt_name = ? LIMIT 1',
      ).get(next);
    } catch {
      return null;
    }
    if (!ancestor) return null;
    if (ancestor.string_size) {
      return { value: String(ancestor.string_size), inheritedFrom: ancestor.edt_name };
    }
    next = ancestor.extends || undefined;
  }
  return null;
}

/** True when edt_metadata holds a row for exactly this spelling. */
function probeEdtRow(db: any, name: string, modelName?: string): boolean {
  try {
    return !!db.prepare(
      `SELECT 1 FROM edt_metadata WHERE edt_name = ?${modelName ? ' AND model = ?' : ''} LIMIT 1`
    ).get(...(modelName ? [name, modelName] : [name]));
  } catch {
    return false;
  }
}

/**
 * Fields whose declared type is `edtName`.
 *
 * For a `type='field'` row, `signature` holds the field's type name, so this is
 * an equality question, not a substring one. It used to be asked as
 * `signature LIKE '%edtName%'`, which was wrong in both directions:
 *
 *  - Correctness: asking for AmountMST also reported fields typed
 *    QuotationAmountMST, AdjustAmountMST, BaseAmountMST, PaymAmountMST…
 *  - Performance: an unindexed LIKE over the 360 K `field` rows, and the
 *    ORDER BY forced every match to be read and sorted before LIMIT 50 could
 *    apply. Measured on the 2 GB index: 63 s for a name that exists — a
 *    synchronous call that blocks the whole server while it runs.
 *
 * The FTS pre-filter narrows to the handful of rows whose signature contains
 * the name as a token, and the equality test then decides. Because FTS5 stores
 * the signature token case-insensitively, and the comparison is COLLATE NOCASE,
 * every case variant X++ considers the same type is kept — measured recall
 * against a case-insensitive full scan is 100 %, at 22–41 ms instead of 63 s.
 *
 * Falls back to the exact-equality scan when the index predates symbols_fts.
 */
function findFieldsTypedAs(db: any, edtName: string): any[] {
  const safe = edtName.replace(/["\(\)\\]/g, '').trim();
  if (safe) {
    try {
      return db.prepare(
        `SELECT parent_name, name, model FROM symbols
          WHERE type = 'field'
            AND id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)
            AND signature = ? COLLATE NOCASE
          ORDER BY model, parent_name LIMIT 50`
      ).all(`{signature} : "${safe}"`, edtName) as any[];
    } catch {
      // No FTS table (older index) — fall through to the plain scan.
    }
  }
  try {
    return db.prepare(
      `SELECT parent_name, name, model FROM symbols
        WHERE type = 'field' AND signature = ? COLLATE NOCASE
        ORDER BY model, parent_name LIMIT 50`
    ).all(edtName) as any[];
  } catch {
    return [];
  }
}

/**
 * Hierarchy mode: walk ancestor chain, find children, and show field usages
 */
function getEdtHierarchy(db: any, edtName: string, modelName?: string) {
  // X++ identifiers are case-insensitive, and edt_metadata.edt_name is probed by
  // equality. Basic mode already canonicalizes the caller's casing through the
  // index-safe lookup; hierarchy mode did not, so `amountmst` reported the EDT as
  // missing while `AmountMST` returned it. Canonicalize here too, using the same
  // helper, so the two modes agree on what exists.
  const startName = probeEdtRow(db, edtName, modelName)
    ? edtName
    : (canonicalSymbolName(db, edtName, ['edt']) ?? edtName);

  // Ancestor chain walk
  const chain: Array<{ name: string; model: string; extends?: string; label?: string; stringSize?: string }> = [];
  let current = startName;
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

  // Field usages (fields whose type IS this EDT)
  const fieldUsages = findFieldsTypedAs(db, edtName);

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

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
