/**
 * get_knowledge Tool — unified knowledge-lookup entry point.
 *
 * Three kinds behind one tool (KNOWLEDGE_KINDS below is the authority); the
 * first two absorbed the retired standalone knowledge tools:
 *   • knowledge → queryable X++ rulebook (patterns, BP rules, migration)
 *   • error     → diagnose a D365FO/X++ compiler or runtime error
 *   • op-spec   → parameter contract for one d365fo_file operation/objectType
 *                 or one generate_object mode (issue #825: these no longer ship
 *                 inline in those tools' wire schemas)
 *
 * The knowledge/error handlers take the request only (no context). Handler files
 * stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { xppKnowledgeTool } from './xppKnowledge.js';
import { d365foErrorHelpTool } from './d365foErrorHelp.js';
import { lookupOpSpec } from './opSpecs.js';

export const KNOWLEDGE_KINDS = ['knowledge', 'error', 'op-spec'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

const GetKnowledgeArgsSchema = z
  .object({
    kind: z.enum(KNOWLEDGE_KINDS).optional().describe(
      'knowledge → look up an X++ topic/rule; error → diagnose a compiler/runtime error message; ' +
      'op-spec → parameter contract for a d365fo_file operation/objectType or a generate_object mode. ' +
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

  // op-spec: the topic is an operation / objectType / mode name. Models reach
  // for the parameter's own name (`operation`, `objectType`, `mode`) at least as
  // often as `topic`, so all four are accepted — the alternative is a lookup that
  // fails on the first try and teaches the agent not to use it.
  if (kind === 'op-spec') {
    const r = rest as Record<string, unknown>;
    const topic = r.topic ?? r.operation ?? r.objectType ?? r.mode ?? r.query;
    return {
      content: [{ type: 'text', text: lookupOpSpec(topic == null ? undefined : String(topic)) }],
    };
  }

  // The underlying xppKnowledge handler expects `topic`. Models commonly guess
  // `query`/`q`/`search` instead — remap those to `topic` so the call doesn't
  // fail with a misleading "expected string, received undefined" zod error.
  const knowledgeArgs = { ...rest } as Record<string, unknown>;
  if (knowledgeArgs.topic == null) {
    const alias = knowledgeArgs.query ?? knowledgeArgs.q ?? knowledgeArgs.search;
    if (alias != null) knowledgeArgs.topic = alias;
  }
  return xppKnowledgeTool(subRequest('get_xpp_knowledge', knowledgeArgs));
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/getKnowledge.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
