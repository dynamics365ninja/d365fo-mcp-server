/**
 * prepare Tool — unified one-call context aggregator.
 *
 * Replaces prepare_change (extending/modifying an existing object) and
 * prepare_create (a brand-new object) with one tool discriminated by `mode`:
 *   • change → signature + CoC wrappers + eligibility + grounding token
 *   • create → collision/naming/EDT/label aggregation + grounding token
 *
 * Both issue a fresh provenance token, so this tool is excluded from the
 * dedup cache. Handler files stay where they are — only the MCP surface is
 * consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { prepareChangeTool } from './prepareChange.js';
import { prepareCreateTool } from './prepareCreate.js';
import { getConfigManager } from '../../utils/configManager.js';

export const PREPARE_MODES = ['change', 'create'] as const;
export type PrepareMode = (typeof PREPARE_MODES)[number];

const PrepareArgsSchema = z
  .object({
    mode: z
      .enum(PREPARE_MODES)
      .default('change')
      .describe(
        'change (default) → aggregate context for extending/modifying an existing object; ' +
          'create → aggregate context for a brand-new object.',
      ),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

/**
 * Repeat suppression.
 *
 * prepare answers a question about an OBJECT ("what do I need to know to add a field
 * to this table"), but its `goal` is free text, so re-asking the same question in
 * different words looks like a new call. Run f2e7b71a did exactly that: four prepares,
 * then two more that repeated the add-field and add-control ones verbatim except for
 * the goal wording. Each reply is capped at ~5 KB and stays in the transcript for the
 * rest of the session, and every later request pays to resend it.
 *
 * The grounding token from the first call is still valid — it is object-bound with a
 * 30-minute TTL — so the honest answer to a repeat is that token plus a pointer, not
 * another 5 KB of identical context.
 */
const REPEAT_TTL_MS = 30 * 60 * 1000;

interface PriorPrepare {
  token: string;
  at: number;
  goal: string;
}

const recentPrepares = new Map<string, PriorPrepare>();

/**
 * Same question = same (mode, type, operation, object, method, proposedName).
 *
 * `goal` is deliberately excluded — rewording the intent is not a new question.
 * `proposedName` is deliberately INCLUDED, and it was not until the suppression
 * started actually arming (the token moved out of the truncated tail and the cap
 * rose): prepare runs naming validation only when `proposedName` is given, so a
 * second call proposing a DIFFERENT name would have hit the cached answer,
 * skipped the validation entirely, and handed back a grounding token for a name
 * the check would have refused.
 */
function prepareKey(mode: string, args: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
  return [
    mode, s(args['objectType']), s(args['operation']),
    s(args['objectName']), s(args['methodName']), s(args['proposedName']),
  ].join('|');
}

function extractToken(result: unknown): string | undefined {
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  return /\*\*Grounding token:\*\*\s*`([^`]+)`/.exec(text)?.[1];
}

/** Exported for tests — a long-lived process must not accumulate dead keys. */
export function pruneRecentPrepares(now = Date.now()): void {
  for (const [key, prior] of recentPrepares.entries()) {
    if (now - prior.at > REPEAT_TTL_MS) recentPrepares.delete(key);
  }
}

/**
 * Drop every remembered prepare. Called by d365fo_file after a successful write:
 * once the AOT changes, the aggregated context describes a state that no longer
 * exists, and answering a repeat from it would be worse than re-aggregating —
 * "add-field" prepared before the field existed is exactly the wrong answer after.
 *
 * Deliberately a full clear rather than a targeted eviction: a write to a table
 * invalidates the form context that referenced its fields too, and getting that
 * dependency graph wrong fails silently.
 */
export function resetRecentPrepares(): void {
  recentPrepares.clear();
}

/**
 * Where the writes will land, stated once per process.
 *
 * get_workspace_info was the FIRST call in 10 of 10 sampled sessions, and every
 * one of those replies was the same ~1.4 KB. What the opening call is actually
 * for is the target model and where it writes — four lines. prepare is the tool
 * that starts real work, so it carries them, once: repeating them on all 17
 * prepares in those sessions would cost more than the call it removes.
 *
 * Deliberately NOT a substitute for get_workspace_info: that tool still answers
 * project tables, roots, the stdio handshake and diagnostics=true. This is the
 * subset an agent needs before its first write.
 */
let workspaceHeaderSent = false;

/** Exported for tests — the flag is process-lifetime state. */
export function resetWorkspaceHeader(): void {
  workspaceHeaderSent = false;
}

function workspaceHeader(): string {
  if (workspaceHeaderSent) return '';
  workspaceHeaderSent = true;
  try {
    const { modelName, source, projectPath, workspacePath } = getConfigManager().getDetectionSummary();
    const lines = [
      `**Workspace** — model ${modelName ?? '(not detected)'} (via ${source})`,
      projectPath  ? `Project: ${projectPath}`   : 'Project: (none resolved — pass projectPath to add files to a VS project)',
    ];
    if (workspacePath) lines.push(`Workspace: ${workspacePath}`);
    lines.push('(get_workspace_info has the full picture: project table, roots, diagnostics.)');
    return lines.join('\n') + '\n\n---\n\n';
  } catch {
    // Never let a config read failure turn a good prepare into an error.
    return '';
  }
}

/** Put the once-per-process header in front of a successful reply. */
function withWorkspaceHeader(result: unknown): unknown {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (r?.isError) return result;
  const first = r?.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;
  const header = workspaceHeader();
  if (!header) return result;
  return { ...r, content: [{ ...first, text: header + first.text }, ...r.content!.slice(1)] };
}

export async function prepareTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = PrepareArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const modeArg = args['mode'];
    const modeMsg =
      modeArg === undefined
        ? `❌ prepare: missing required parameter "mode".\n\nUsage:\n  prepare(mode="change", objectName="...", methodName="...")  — extend/modify an existing object\n  prepare(mode="create", objectName="...", objectType="...")   — plan a new object`
        : `❌ prepare: invalid mode "${modeArg}". Valid values: "change", "create".\n\n  prepare(mode="change", objectName="...", methodName="...")  — extend/modify an existing object\n  prepare(mode="create", objectName="...", objectType="...")   — plan a new object`;
    return {
      content: [{ type: 'text', text: modeMsg }],
      isError: true,
    };
  }

  const { mode, ...rest } = parsed.data;

  pruneRecentPrepares();
  const key = prepareKey(mode, rest);
  const prior = recentPrepares.get(key);
  if (prior) {
    const goal = typeof rest['goal'] === 'string' ? rest['goal'] : '';
    const minutes = Math.max(1, Math.round((Date.now() - prior.at) / 60000));
    return {
      content: [
        {
          type: 'text',
          text:
            `ℹ️ Already prepared — this is the same request as ${minutes} min ago ` +
            `(same mode/objectType/operation/objectName${rest['methodName'] ? '/methodName' : ''}), ` +
            'so the context has not changed and is not repeated here.\n\n' +
            `**Grounding token:** \`${prior.token}\`\n\n` +
            `Earlier goal: ${prior.goal || '(none given)'}\n` +
            (goal && goal !== prior.goal ? `This goal:    ${goal}\n` : '') +
            '\nThe token above is still valid (30-min TTL, bound to this object) — pass it to ' +
            '`d365fo_file(action="create"/"modify")` or `generate_object(mode="pattern")` and proceed. ' +
            'Scroll up for the full context if you need it again; to force a fresh aggregation, ' +
            'change the object, operation or method you are asking about.',
        },
      ],
    };
  }

  const result =
    mode === 'create'
      ? await prepareCreateTool(subRequest('prepare_create', rest), context)
      : await prepareChangeTool(subRequest('prepare_change', rest), context);

  // Only a call that actually issued a token is worth suppressing: an error reply has
  // no context to reuse, and repeating it is how the caller retries after fixing args.
  const token = extractToken(result);
  if (token && !(result as { isError?: boolean }).isError) {
    recentPrepares.set(key, {
      token,
      at: Date.now(),
      goal: typeof rest['goal'] === 'string' ? rest['goal'] : '',
    });
  }
  return withWorkspaceHeader(result);
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/prepare.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
