/**
 * Patterns Tool — unified pattern toolkit.
 *
 * Merges the former get_table_patterns and form_pattern tools into one tool
 * discriminated by `domain`:
 *   • table → field/index/relation patterns for D365FO tables (get_table_patterns)
 *   • form  → form-pattern toolkit with its own `action` (analyze/spec/validate)
 *
 * The two underlying handlers read their own fields (table: tableGroup/similarTo/
 * limit; form: action/...) and ignore the `domain` discriminator (no strict
 * schemas), so the request is passed straight through.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { getTablePatternsTool } from './getTablePatterns.js';
import { formPatternTool } from './formPattern.js';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function objectPatternsTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const domain = a.domain as string | undefined;

  switch (domain) {
    case 'table':
      return getTablePatternsTool(request, context);
    case 'form':
      return formPatternTool(request, context);
    default:
      return err(`object_patterns: unknown domain "${domain}". Use "table" (table field/index/relation patterns) or "form" (form-pattern toolkit; pass action=analyze|spec|validate).`);
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
