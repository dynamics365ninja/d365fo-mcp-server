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
import { tryBridgeMethodSource } from '../bridge/bridgeAdapter.js';

const GetMethodSourceArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method'),
});

export async function getMethodSourceTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetMethodSourceArgsSchema.parse(request.params.arguments);
    const { className, methodName } = args;

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
        text: `❌ Method **${className}.${methodName}** not found.${hint}\n\nUse \`get_class_info\` to see all available methods.`,
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

  // Locate the class file path from SQLite
  const OBJECT_TYPES = `('class', 'table', 'view', 'data-entity')`;
  let classRow: any;
  try {
    const rdb = symbolIndex.getReadDb();
    classRow = rdb.prepare(`
      SELECT file_path, model, type
      FROM symbols
      WHERE type IN ${OBJECT_TYPES} AND name = ?
      ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END, model
      LIMIT 1
    `).get(className);
  } catch { /* DB not available */ }

  if (!classRow?.file_path) return null;

  try {
    const parseResult = await Promise.race([
      parser.parseClassFile(classRow.file_path, classRow.model),
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
