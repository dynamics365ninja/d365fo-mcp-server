/**
 * Validate Tool — unified static validator for generated X++/XML.
 *
 * Merges the former validate_xpp and resolve_references tools into one tool
 * discriminated by `mode`:
 *   • syntax     → offline best-practice/BP rule validation (validate_xpp)
 *   • references → semantic symbol resolution against the index (resolve_references)
 *
 * Both underlying handlers read `code`/`context` from request.params.arguments
 * and ignore the extra `mode` key (no strict schemas), so the request is passed
 * straight through.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { validateXppTool } from './validateXpp.js';
import { resolveReferencesTool } from './resolveReferences.js';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function validateCodeTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const mode = (a.mode as string | undefined) ?? 'syntax';

  if (!a.code) return err('validate_code requires `code` (the X++/XML text to check).');

  switch (mode) {
    case 'syntax':
      return validateXppTool(request, context);
    case 'references':
      return resolveReferencesTool(request, context);
    default:
      return err(`validate_code: unknown mode "${mode}". Use "syntax" (BP/best-practice rules) or "references" (symbol resolution).`);
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
