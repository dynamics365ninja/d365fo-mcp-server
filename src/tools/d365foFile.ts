/**
 * d365fo_file Tool — unified file/metadata-operation entry point.
 *
 * Replaces three tools with one discriminated by `action`:
 *   • generate → produce AOT XML as TEXT only (Azure/Linux fallback, no write)
 *   • create   → write a NEW AOT object file into PackagesLocalDirectory (write)
 *   • modify   → edit an EXISTING object via IMetadataProvider (write)
 *
 * Like `labels`, this mixes a read-capable action (generate works on Azure
 * read-only) with write actions that need local Windows-VM filesystem access;
 * it therefore lives in ALWAYS_TOOLS and the underlying create/modify handlers
 * return a clear error when the local filesystem is not reachable. Handler
 * files stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { handleGenerateD365Xml } from './generateD365Xml.js';
import { handleCreateD365File } from './createD365File.js';
import { modifyD365FileTool } from './modifyD365File.js';

export const D365_FILE_ACTIONS = ['generate', 'create', 'modify'] as const;
export type D365FileAction = (typeof D365_FILE_ACTIONS)[number];

const D365FileArgsSchema = z
  .object({
    action: z.enum(D365_FILE_ACTIONS).describe(
      'generate → XML text only (no file written, Azure/Linux fallback); ' +
      'create → write a NEW object file (Windows); modify → edit an EXISTING object (Windows).',
    ),
    // Operation-specific parameters may arrive nested in `params` (the published
    // schema advertises only this object) — they are flattened before dispatch.
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function d365foFileTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = D365FileArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ d365fo_file: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { action, params, ...flat } = parsed.data;

  // Back-compat merge: op-specific values may come nested in `params` (the
  // published schema shape) or flat at top level (legacy callers). Nested
  // values win on key collision; the `params` wrapper itself is not forwarded.
  const rest: Record<string, unknown> =
    params && typeof params === 'object' && !Array.isArray(params)
      ? { ...flat, ...params }
      : flat;

  if (action === 'create') {
    return handleCreateD365File(subRequest('create_d365fo_file', rest), context);
  }
  if (action === 'modify') {
    return modifyD365FileTool(subRequest('modify_d365fo_file', rest), context);
  }
  // generate: handler takes the request only (no context).
  return handleGenerateD365Xml(subRequest('generate_d365fo_xml', rest));
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/d365foFile.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
