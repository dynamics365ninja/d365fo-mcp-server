/**
 * Batch Get Info Tool
 *
 * Fetches detailed metadata for N objects in a single request — the read-side
 * counterpart of batch_search. Each object dispatches to its existing
 * get_*_info tool and all lookups run in parallel (same pattern as
 * prepare_change), eliminating one round trip per object.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { READER_DISPATCH, BATCH_INFO_TYPES, withNotFoundGuidance } from './objectInfoRegistry.js';

export const BatchGetInfoArgsSchema = z.object({
  objects: z.array(z.object({
    name: z.string().describe('Exact object name (use search/search(queries=[...]) first if unsure)'),
    type: z.enum(BATCH_INFO_TYPES).describe('Object type — selects the underlying reader'),
  })).min(1).max(10).describe('Objects to fetch in parallel (max 10)'),
});

export async function batchGetInfoTool(request: CallToolRequest, context: XppServerContext) {
  const startTime = Date.now();
  const parsed = BatchGetInfoArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ batch_get_info: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const results = await Promise.all(
    parsed.data.objects.map(async (obj) => {
      const dispatch = READER_DISPATCH[obj.type];
      const subRequest: CallToolRequest = {
        method: 'tools/call',
        params: { name: dispatch.toolName, arguments: dispatch.buildArgs(obj.name) },
      };
      try {
        const result = withNotFoundGuidance(await dispatch.tool(subRequest, context), obj.name, obj.type);
        return { ...obj, success: !result.isError, text: result.content?.[0]?.text ?? 'No content' };
      } catch (err) {
        return { ...obj, success: false, text: `Error: ${err instanceof Error ? err.message : err}` };
      }
    }),
  );

  const okCount = results.filter(r => r.success).length;
  const sections = results.map((r, i) =>
    `## ${i + 1}. ${r.name} [${r.type.toUpperCase()}] ${r.success ? '' : '❌'}\n\n${r.text}`,
  );

  const header =
    `# Batch Get Info\n\n` +
    `Fetched: ${results.length} object(s) in parallel | Success: ${okCount}/${results.length} | ` +
    `Time: ${Date.now() - startTime}ms\n\n---\n\n`;

  return {
    content: [{ type: 'text', text: header + sections.join('\n\n---\n\n') }],
    isError: okCount === 0,
  };
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
