/**
 * Get Method Source Tool
 * Returns the full X++ source code of a method.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * SQLite "did you mean?" kept only on error path.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import type { XppMetadataParser } from '../metadata/xmlParser.js';
import { tryBridgeMethodSource } from '../bridge/bridgeAdapter.js';
import { canonicalSymbolName } from '../utils/symbolLookup.js';

const GetMethodSourceArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method'),
});

/** Object types that can own methods. */
const OBJECT_TYPES = ['class', 'table', 'view', 'data-entity'] as const;
const OBJECT_TYPES_SQL = `(${OBJECT_TYPES.map(t => `'${t}'`).join(', ')})`;

export async function getMethodSourceTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetMethodSourceArgsSchema.parse(request.params.arguments);
    const { methodName } = args;

    // Resolve the caller's casing to the canonical AOT name once, up front.
    // X++ treats AOT identifiers case-insensitively but the index stores the
    // canonical name, and every lookup below (bridge included) matches by exact
    // name — so a casing mismatch would otherwise miss all three layers and
    // report a false "not found" (#686, e.g. WhsrfControlData → WHSRFControlData,
    // whose own filename disagrees with its AOT name).
    const className = resolveClassName(context, args.className);

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeMethodSource(context.bridge, className, methodName);
    if (bridgeResult) return bridgeResult;

    // Fallback: parse XML file from disk (same pattern as classInfo.ts)
    const xmlResult = await tryXmlMethodSource(context, className, methodName);
    if (xmlResult) return xmlResult;

    // Bridge and XML both unavailable — try fuzzy name suggestions from SQLite
    let hint = '';
    try {
      const db = context.symbolIndex.getReadDb();
      const candidates = db.prepare(
        `SELECT name, signature FROM symbols
         WHERE type = 'method' AND parent_name = ? AND name LIKE ?
         ORDER BY name LIMIT 10`
      ).all(className, `%${methodName.replace(/^parm/i, '')}%`) as Array<{ name: string; signature: string | null }>;

      if (candidates.length > 0) {
        hint = '\n\n**Similar methods on this class:**\n' +
          candidates.map(c => `- \`${c.signature || c.name}\``).join('\n');
      } else if (/^parm/i.test(methodName)) {
        const parmMethods = db.prepare(
          `SELECT name, signature FROM symbols
           WHERE type = 'method' AND parent_name = ? AND name LIKE 'parm%'
           ORDER BY name LIMIT 15`
        ).all(className) as Array<{ name: string; signature: string | null }>;
        if (parmMethods.length > 0) {
          hint = '\n\n**Available parm* methods on this class:**\n' +
            parmMethods.map(c => `- \`${c.signature || c.name}\``).join('\n');
        }
      }
    } catch { /* DB not available */ }

    return {
      content: [{
        type: 'text',
        text: `❌ Method **${className}.${methodName}** not found.${hint}\n\nUse \`get_object_info(objectType="class", name="${className}")\` to see all available methods.`,
      }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/**
 * Canonical (as-indexed) casing for a method owner, falling back to the name as
 * given when the index has no match or is unavailable — an unresolved name still
 * flows through to the normal "not found" path.
 *
 * Index-safe by construction: `canonicalSymbolName` probes exact case on
 * idx_name_type first and only falls back to FTS. Matching with
 * `name = ? COLLATE NOCASE` here instead would drop to a scan of every
 * class/table/view row (~86k rows, 4–8 s warm) and the parent_name hint query
 * below would cost ~48 s — past the MCP client timeout. See src/utils/symbolLookup.ts.
 */
function resolveClassName(context: XppServerContext, requested: string): string {
  try {
    return canonicalSymbolName(context.symbolIndex.getReadDb(), requested, OBJECT_TYPES) ?? requested;
  } catch {
    return requested; // DB not available — bridge/XML may still resolve it
  }
}

/**
 * Try XML file parsing for method source.
 * Fallback when C# bridge is unavailable (Azure, Linux, bridge not running).
 * Mirrors the pattern from classInfo.ts: parse XML with timeout guard.
 */
async function tryXmlMethodSource(
  context: XppServerContext,
  className: string,
  methodName: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null> {
  const { parser, symbolIndex } = context;
  if (!parser) return null;

  // Locate the class file path from SQLite. `className` is already canonical
  // (resolveClassName), so this stays a BINARY probe on idx_name_type.
  let classRow: any;
  try {
    const rdb = symbolIndex.getReadDb();
    classRow = rdb.prepare(`
      SELECT file_path, model, type
      FROM symbols
      WHERE type IN ${OBJECT_TYPES_SQL} AND name = ?
      ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END, model
      LIMIT 1
    `).get(className);
  } catch { /* DB not available */ }

  if (!classRow?.file_path) return null;

  try {
    const parseResult = await Promise.race([
      parseByObjectType(parser, classRow.file_path, classRow.model, classRow.type),
      new Promise<{ success: false; error: string }>(resolve =>
        setTimeout(() => resolve({ success: false, error: 'timeout' }), 3000)
      ),
    ]);
    if (!parseResult.success || !parseResult.data) return null;

    const method = parseResult.data.methods.find(
      (m: any) => m.name.toLowerCase() === methodName.toLowerCase()
    );
    if (!method?.source) return null;

    // Detect [SysObsolete] / [Obsolete]
    const obsoleteMatch = method.source.match(/\[\s*SysObsolete\s*\(\s*['"]([^'"]*)['"]/i)
      ?? method.source.match(/\[\s*Obsolete\s*\(\s*['"]([^'"]*)['"]/i);
    const obsoleteWarning = obsoleteMatch
      ? `\n\n> ⚠️ **This method is marked obsolete.** Do NOT generate calls to it.\n> Replacement hint from the attribute: _"${obsoleteMatch[1]}"_\n> Read the hint above and use the stated replacement instead.`
      : '';

    const text =
      `## ${className}.${methodName}\n\n` +
      `_Source: XML file parsing (bridge unavailable)_\n` +
      obsoleteWarning +
      `\n\`\`\`xpp\n${method.source}\n\`\`\``;
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    console.error(`[getMethodSource] XML parse for ${className}.${methodName} failed: ${e}`);
    return null;
  }
}

/**
 * Dispatch to the correct parser based on object type.
 * Tables, views, and data-entities have different XML structures than classes.
 */
function parseByObjectType(
  parser: XppMetadataParser,
  filePath: string,
  modelName: string,
  objectType?: string,
): Promise<{ success: boolean; data?: any; error?: string }> {
  switch (objectType) {
    case 'table':       return parser.parseTableFile(filePath, modelName);
    case 'view':
    case 'data-entity': return parser.parseViewFile(filePath, modelName);
    default:            return parser.parseClassFile(filePath, modelName);
  }
}
