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

    // Bridge returned nothing — try fuzzy name suggestions from SQLite
    let hint = '';
    try {
      const db = context.symbolIndex.db;
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
