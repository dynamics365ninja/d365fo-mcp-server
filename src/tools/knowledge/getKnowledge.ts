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
  const rawTopics = (rest as Record<string, unknown>).topics;
  const topics = normalizeTopics(rawTopics);
  delete (rest as Record<string, unknown>).topics;
  // `topics` was given but is not usable, and there is no `topic` to fall back on:
  // say so in words. Letting it through produced a raw zod dump naming a parameter
  // the caller never passed.
  if (rawTopics !== undefined && !topics && (rest as Record<string, unknown>).topic == null) {
    return {
      content: [{ type: 'text' as const, text: describeTopicsShape(rawTopics) }],
      isError: true,
    };
  }
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
        content: [{
          type: 'text',
          text: renderTopicBatch(topics.map(t => ({ topic: t, text: lookupOpSpec(t) })), 'op-spec'),
        }],
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
        text: renderTopicBatch(
          topics.map((t, i) => ({ topic: t, text: `## ${t}\n${textOf(answers[i])}` })),
          'knowledge',
        ),
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
 * Character budget this renderer spends on a multi-topic batch.
 *
 * Sits deliberately BELOW get_knowledge's response cap in toolHandler.ts (16,000),
 * so on a batch that overruns it is THIS code that decides where to stop, not the
 * generic capper. The difference matters: the capper cuts on a block boundary
 * anywhere in the text, which on a topics[] batch means the last topic arrives
 * half-written — an X++ rule truncated mid-sentence is worse than an absent one,
 * because the caller cannot tell it is incomplete. Whole topics only, and a named
 * list of what did not fit so the follow-up call is one topic, not a re-guess.
 *
 * Background: knowledge topics measure 8–12 KB, so under the old 5,000-char
 * default a single one was already halved — which is why topics[] was used 0
 * times in 1,400 sampled calls while op-spec was fetched 186 times one at a time.
 */
export const TOPIC_BATCH_BUDGET = 14_000;

/**
 * Join rendered topics whole, stopping at the budget and saying what was left out.
 *
 * The first topic is always included even when it alone exceeds the budget: an
 * answer that is only a "did not fit" note is never the useful reply, and the
 * response cap remains the backstop for that case.
 */
export function renderTopicBatch(
  entries: Array<{ topic: string; text: string }>,
  kind: 'knowledge' | 'op-spec',
  budget = TOPIC_BATCH_BUDGET,
): string {
  const kept: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const cost = entry.text.length + (kept.length > 0 ? SPEC_SEPARATOR.length : 0);
    if (kept.length > 0 && used + cost > budget) {
      dropped.push(entry.topic);
      continue;
    }
    kept.push(entry.text);
    used += cost;
  }
  if (dropped.length === 0) return kept.join(SPEC_SEPARATOR);
  return (
    kept.join(SPEC_SEPARATOR) +
    SPEC_SEPARATOR +
    `⚠️ ${dropped.length} topic${dropped.length === 1 ? '' : 's'} NOT included — the ` +
    `${budget}-char budget for one call was spent on the ${kept.length} above (whole topics only, ` +
    'never a topic cut in half).\n' +
    `Not included: ${dropped.join(', ')}\n` +
    `Fetch them with: get_knowledge(kind="${kind}", topics: [${dropped.map(t => `"${t}"`).join(', ')}])`
  );
}

/**
 * topics[] accepted as an array of non-empty strings; anything else returns null
 * and the caller falls through to the single-topic path.
 *
 * That fallback is only a graceful one when a `topic` was ALSO supplied. It was
 * not: `topics: "CoC"` with no `topic` reached xppKnowledgeTool with topic
 * undefined and came back as a raw zod dump —
 *   Error in get_knowledge(kind="knowledge"): [ { "expected": "string",
 *     "code": "invalid_type", "path": [ "topic" ] … } ]
 * — the same unusable shape #937 fixed for d365fo_file. The comment here used to
 * claim the loop simply resumed; it did not. describeTopicsShape() below is what
 * makes the claim true.
 */
function normalizeTopics(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter(t => typeof t === 'string' && t.trim() !== '').map(t => String(t).trim());
  return list.length > 0 ? list.slice(0, MAX_TOPICS) : null;
}

/**
 * The complaint to make when `topics` was supplied but unusable, and no `topic`
 * can stand in for it. Names the shape and how many entries were dropped, instead
 * of handing back a serialized validator object.
 */
function describeTopicsShape(raw: unknown): string {
  const shape = Array.isArray(raw)
    ? `an array of ${raw.length} entr${raw.length === 1 ? 'y' : 'ies'}, none of them a non-empty string`
    : `a ${typeof raw}`;
  return (
    `❌ get_knowledge: \`topics\` must be an array of non-empty strings — got ${shape}.\n` +
    `  Several topics: topics: ["select-statement", "coc-authoring"]  (max ${MAX_TOPICS})\n` +
    `  One topic:      topic: "select-statement"`
  );
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.map(c => c?.text ?? '').join('\n') ?? '';
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/getKnowledge.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
