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

const GetMethodSourceArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method'),
});

export async function getMethodSourceTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetMethodSourceArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { className, methodName } = args;

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
      return {
        content: [{
          type: 'text',
          text: `❌ Method **${className}.${methodName}** not found in the index.\n\nMake sure the class name and method name are correct. Use \`search\` or \`get_class_info\` to discover available methods.`,
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

    const output = [
      `## ${className}.${methodName}`,
      '',
      row.signature ? `**Signature:** \`${row.signature}\`` : '',
      `**Model:** ${row.model}`,
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
