/**
 * get_knowledge Tool — unified knowledge-lookup entry point.
 *
 * Four kinds behind one tool (KNOWLEDGE_KINDS below is the authority); the
 * first two absorbed the retired standalone knowledge tools:
 *   • knowledge  → queryable X++ rulebook (patterns, BP rules, migration)
 *   • error      → diagnose a D365FO/X++ compiler or runtime error
 *   • op-spec    → parameter contract for one d365fo_file operation/objectType
 *                  or one generate_object mode (issue #825: these no longer ship
 *                  inline in those tools' wire schemas)
 *   • bp-moniker → validate/search a BP-check diagnostic moniker, or render a
 *                  _BPSuppressions.xml block (src/knowledge/bpMonikers/)
 *
 * The knowledge/error handlers take the request only (no context). Handler files
 * stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { xppKnowledgeTool } from './xppKnowledge.js';
import { d365foErrorHelpTool } from './d365foErrorHelp.js';
import { bpMonikerHelpTool } from './bpMonikerHelp.js';
import { lookupOpSpec } from '../specs/opSpecs.js';

export const KNOWLEDGE_KINDS = ['knowledge', 'error', 'op-spec', 'bp-moniker'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

const GetKnowledgeArgsSchema = z
  .object({
    kind: z.enum(KNOWLEDGE_KINDS).optional().describe(
      'knowledge → look up an X++ topic/rule; error → diagnose a compiler/runtime error message; ' +
      'op-spec → parameter contract for a d365fo_file operation/objectType or a generate_object mode; ' +
      'bp-moniker → validate/search a BP-check diagnostic moniker or render a _BPSuppressions.xml block. ' +
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
  // A run picks 4-8 different operations and fetched each contract in its own
  // call: get_knowledge was 40 of 273 tool calls in the sampled sessions, 38 of
  // them op-spec, with 8 back-to-back pairs. topics[] answers them in one.
  const topics = normalizeTopics((rest as Record<string, unknown>).topics);
  delete (rest as Record<string, unknown>).topics;
  const kind: KnowledgeKind =
    explicitKind ?? ((rest as any).errorText || (rest as any).errorCode ? 'error' : 'knowledge');
  if (kind === 'error') {
    return d365foErrorHelpTool(subRequest('get_d365fo_error_help', rest));
  }

  if (kind === 'bp-moniker') {
    // The wire schema doesn't publish a separate `query` field for the search
    // action (budget) — it reuses `topic`, same alias trick as the knowledge
    // kind below.
    const bpArgs = rest as Record<string, unknown>;
    if (bpArgs.query == null && bpArgs.topic != null) bpArgs.query = bpArgs.topic;
    return bpMonikerHelpTool(subRequest('bp_moniker', bpArgs));
  }

  // op-spec: the topic is an operation / objectType / mode name. Models reach
  // for the parameter's own name (`operation`, `objectType`, `mode`) at least as
  // often as `topic`, so all four are accepted — the alternative is a lookup that
  // fails on the first try and teaches the agent not to use it.
  if (kind === 'op-spec') {
    const r = rest as Record<string, unknown>;
    if (topics) {
      // Purely a table lookup, so the batch costs no more than the loop did.
      return {
        content: [{ type: 'text', text: topics.map(t => lookupOpSpec(t)).join(SPEC_SEPARATOR) }],
      };
    }
    const topic = r.topic ?? r.operation ?? r.objectType ?? r.mode ?? r.query;
    return {
      content: [{ type: 'text', text: lookupOpSpec(topic == null ? undefined : String(topic)) }],
    };
  }

  // The underlying xppKnowledge handler expects `topic`. Models commonly guess
  // `query`/`q`/`search` instead — remap those to `topic` so the call doesn't
  // fail with a misleading "expected string, received undefined" zod error.
  const knowledgeArgs = { ...rest } as Record<string, unknown>;
  if (topics) {
    const answers = await Promise.all(
      topics.map(t => xppKnowledgeTool(subRequest('get_xpp_knowledge', { ...knowledgeArgs, topic: t }))),
    );
    return {
      content: [{
        type: 'text',
        text: answers
          .map((a, i) => `## ${topics[i]}\n${textOf(a)}`)
          .join(SPEC_SEPARATOR),
      }],
    };
  }
  if (knowledgeArgs.topic == null) {
    const alias = knowledgeArgs.query ?? knowledgeArgs.q ?? knowledgeArgs.search;
    if (alias != null) knowledgeArgs.topic = alias;
  }
  return xppKnowledgeTool(subRequest('get_xpp_knowledge', knowledgeArgs));
}

/** Cap: the point is to save round trips, not to let one call return everything. */
export const MAX_TOPICS = 10;

const SPEC_SEPARATOR = '\n\n---\n\n';

/**
 * topics[] accepted as an array; anything else (including a bare string, which
 * belongs in `topic`) falls through to the single-topic path rather than
 * erroring — a rejected batch just becomes the loop it was meant to replace.
 */
function normalizeTopics(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter(t => typeof t === 'string' && t.trim() !== '').map(t => String(t).trim());
  return list.length > 0 ? list.slice(0, MAX_TOPICS) : null;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.map(c => c?.text ?? '').join('\n') ?? '';
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/getKnowledge.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
