/**
 * form_pattern Tool — unified form-pattern entry point.
 *
 * Replaces the three form-pattern tools with one discriminated by `action`:
 *   • analyze  → pattern advisor + usage analysis (recommend / formPattern /
 *                dataSource / similarTo) — the old get_form_patterns
 *   • validate → structural validator of AxForm XML (FP001-FP010)
 *   • spec     → full spec of a pattern / sub-pattern (structure, references)
 *
 * Typical lifecycle: analyze (pick a pattern) → spec (get the structure) →
 * build → validate. Handler files stay where they are — only the MCP surface
 * is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { getFormPatternsTool } from './getFormPatterns.js';
import { validateFormPatternTool } from './validateFormPattern.js';
import { getFormPatternSpecTool } from './getFormPatternSpec.js';

export const FORM_PATTERN_ACTIONS = ['analyze', 'validate', 'spec'] as const;
export type FormPatternAction = (typeof FORM_PATTERN_ACTIONS)[number];

const FormPatternArgsSchema = z
  .object({
    action: z.enum(FORM_PATTERN_ACTIONS).describe(
      'analyze (recommend/inspect form patterns), validate (check AxForm XML structure), ' +
      'spec (full structure spec of a pattern or sub-pattern).',
    ),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function formPatternTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = FormPatternArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ form_pattern: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { action, ...rest } = parsed.data;

  if (action === 'validate') {
    return validateFormPatternTool(subRequest('validate_form_pattern', rest), context);
  }
  if (action === 'spec') {
    return getFormPatternSpecTool(subRequest('get_form_pattern_spec', rest), context);
  }

  return getFormPatternsTool(subRequest('get_form_patterns', rest), context);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
