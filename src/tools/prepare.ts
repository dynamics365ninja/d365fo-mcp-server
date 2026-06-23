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
import type { XppServerContext } from '../types/context.js';
import { prepareChangeTool } from './prepareChange.js';
import { prepareCreateTool } from './prepareCreate.js';

export const PREPARE_MODES = ['change', 'create'] as const;
export type PrepareMode = (typeof PREPARE_MODES)[number];

const PrepareArgsSchema = z
  .object({
    mode: z.enum(PREPARE_MODES).default('change').describe(
      'change (default) → aggregate context for extending/modifying an existing object; ' +
      'create → aggregate context for a brand-new object.',
    ),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function prepareTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = PrepareArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const modeArg = args['mode'];
    const modeMsg = modeArg === undefined
      ? `❌ prepare: missing required parameter "mode".\n\nUsage:\n  prepare(mode="change", objectName="...", methodName="...")  — extend/modify an existing object\n  prepare(mode="create", objectName="...", objectType="...")   — plan a new object`
      : `❌ prepare: invalid mode "${modeArg}". Valid values: "change", "create".\n\n  prepare(mode="change", objectName="...", methodName="...")  — extend/modify an existing object\n  prepare(mode="create", objectName="...", objectType="...")   — plan a new object`;
    return {
      content: [{ type: 'text', text: modeMsg }],
      isError: true,
    };
  }

  const { mode, ...rest } = parsed.data;
  if (mode === 'create') {
    return prepareCreateTool(subRequest('prepare_create', rest), context);
  }
  return prepareChangeTool(subRequest('prepare_change', rest), context);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
