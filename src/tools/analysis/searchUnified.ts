/**
 * search Tool — unified search entry point.
 *
 * Replaces three search tools with one:
 *   • plain search (default) — name/keyword query across the whole index
 *   • batch — pass `queries[]` to run up to 10 searches in parallel
 *   • scope=extensions — restrict to custom/ISV models only
 *
 * Dispatch is by shape: `queries[]` → batch; else `scope:"extensions"` →
 * extension search; else a single search. Handler files stay where they are —
 * only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { searchTool } from './search.js';
import { batchSearchTool } from './batchSearch.js';
import { extensionSearchTool } from './extensionSearch.js';

const SearchArgsSchema = z
  .object({
    scope: z.enum(['all', 'extensions']).optional().default('all'),
    queries: z.array(z.any()).optional(),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function searchUnifiedTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = SearchArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ search: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { scope, queries, ...rest } = parsed.data;

  // Batch mode: queries[] forwarded verbatim to batch_search.
  if (Array.isArray(queries) && queries.length > 0) {
    return batchSearchTool(subRequest('batch_search', { queries, ...rest }), context);
  }

  // Extensions-only single search.
  if (scope === 'extensions') {
    return extensionSearchTool(subRequest('search_extensions', rest), context);
  }

  // Default: single full-index search.
  return searchTool(subRequest('search', rest), context);
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
