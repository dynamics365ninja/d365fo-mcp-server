/**
 * get_knowledge Tool — unified knowledge-lookup entry point.
 *
 * Replaces two knowledge tools with one discriminated by `kind`:
 *   • knowledge → queryable X++ rulebook (patterns, BP rules, migration)
 *   • error     → diagnose a D365FO/X++ compiler or runtime error
 *
 * Both underlying handlers take the request only (no context). Handler files
 * stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { xppKnowledgeTool } from './xppKnowledge.js';
import { d365foErrorHelpTool } from './d365foErrorHelp.js';

export const KNOWLEDGE_KINDS = ['knowledge', 'error'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

const GetKnowledgeArgsSchema = z
  .object({
    kind: z.enum(KNOWLEDGE_KINDS).optional().describe(
      'knowledge → look up an X++ topic/rule; error → diagnose a compiler/runtime error message. ' +
      'Optional — inferred from errorText (→ error) or topic (→ knowledge) when omitted.',
    ),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function getKnowledgeTool(request: CallToolRequest) {
  const parsed = GetKnowledgeArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ get_knowledge: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { kind: explicitKind, ...rest } = parsed.data;
  const kind: KnowledgeKind =
    explicitKind ?? ((rest as any).errorText || (rest as any).errorCode ? 'error' : 'knowledge');
  if (kind === 'error') {
    return d365foErrorHelpTool(subRequest('get_d365fo_error_help', rest));
  }
  return xppKnowledgeTool(subRequest('get_xpp_knowledge', rest));
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
