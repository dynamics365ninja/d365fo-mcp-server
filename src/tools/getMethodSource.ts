/**
 * Get Method Source Tool
 * Returns the full X++ source code of a method stored in the symbols database.
 * Falls back to reading the extracted JSON metadata file when the DB row predates
 * the source column (built before this feature was added).
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { readMethodMetadata } from '../utils/metadataResolver.js';
import { tryBridgeMethodSource } from '../bridge/bridgeAdapter.js';

const GetMethodSourceArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method'),
});

export async function getMethodSourceTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetMethodSourceArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { className, methodName } = args;

    // Try C# bridge first (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeMethodSource(context.bridge, className, methodName);
    if (bridgeResult) return bridgeResult;

    // 1. Look up the symbol row to get model + source
    const row = symbolIndex.db.prepare(`
      SELECT source, signature, model, file_path
      FROM symbols
      WHERE type = 'method'
        AND parent_name = ?
        AND name = ?
      LIMIT 1
    `).get(className, methodName) as { source: string | null; signature: string | null; model: string; file_path: string } | undefined;

    if (!row) {
      // Find similarly-named methods on the same class to help the caller self-correct
      const candidates = symbolIndex.db.prepare(`
        SELECT name, signature
        FROM symbols
        WHERE type = 'method'
          AND parent_name = ?
          AND name LIKE ?
        ORDER BY name
        LIMIT 10
      `).all(className, `%${methodName.replace(/^parm/i, '')}%`) as Array<{ name: string; signature: string | null }>;

      let hint = '';
      if (candidates.length > 0) {
        hint = '\n\n**Similar methods on this class:**\n' +
          candidates.map(c => `- \`${c.signature || c.name}\``).join('\n');
      } else {
        // Broader fallback: list parm* methods if the caller was looking for a parm method
        if (/^parm/i.test(methodName)) {
          const parmMethods = symbolIndex.db.prepare(`
            SELECT name, signature
            FROM symbols
            WHERE type = 'method'
              AND parent_name = ?
              AND name LIKE 'parm%'
            ORDER BY name
            LIMIT 15
          `).all(className) as Array<{ name: string; signature: string | null }>;
          if (parmMethods.length > 0) {
            hint = '\n\n**Available parm* methods on this class:**\n' +
              parmMethods.map(c => `- \`${c.signature || c.name}\``).join('\n');
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Method **${className}.${methodName}** not found in the index.${hint}\n\nUse \`get_class_info\` to see all available methods.`,
        }],
        isError: true,
      };
    }

    let source = row.source ?? null;

    // 2. Fallback: DB built before source column was added → read from JSON
    if (!source) {
      const extracted = await readMethodMetadata(row.model, className, methodName);
      source = extracted?.source ?? null;
    }

    if (!source) {
      return {
        content: [{
          type: 'text',
          text: `⚠️ Source code for **${className}.${methodName}** is not available.\n\nThe database may have been built before source storage was enabled. Re-run \`build-database\` to populate source code.`,
        }],
      };
    }

    // Detect [SysObsolete] / [Obsolete] on the method itself
    const obsoleteMatch = source.match(/\[\s*SysObsolete\s*\(\s*['"]([^'"]*)['"]/i)
      ?? source.match(/\[\s*Obsolete\s*\(\s*['"]([^'"]*)['"]/i);
    const obsoleteWarning = obsoleteMatch
      ? `\n\n> ⚠️ **This method is marked obsolete.** Do NOT generate calls to it.\n> Replacement hint from the attribute: _"${obsoleteMatch[1]}"_\n> Read the hint above and use the stated replacement instead.`
      : '';

    const output = [
      `## ${className}.${methodName}`,
      '',
      row.signature ? `**Signature:** \`${row.signature}\`` : '',
      `**Model:** ${row.model}`,
      obsoleteWarning,
      '',
      '```xpp',
      source,
      '```',
    ].filter(line => line !== undefined).join('\n');

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
