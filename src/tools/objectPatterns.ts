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
  // Accept `patternType` / `type` as aliases for the `domain` discriminator —
  // agents frequently reach for these names.
  let domain = (a.domain ?? a.patternType ?? a.type) as string | undefined;

  // Infer the discriminator from form/table-specific params when omitted.
  if (domain !== 'table' && domain !== 'form') {
    const formSignals = ['action', 'pattern', 'recommend', 'formPattern', 'similarTo', 'dataSource', 'xml', 'formName'];
    const tableSignals = ['tableGroup'];
    if (formSignals.some(k => a[k] !== undefined)) {
      domain = 'form';
    } else if (tableSignals.some(k => a[k] !== undefined)) {
      domain = 'table';
    }
  }

  if (domain === 'table') {
    return getTablePatternsTool(request, context);
  }

  if (domain === 'form') {
    // formPatternTool requires `action`; infer it when omitted.
    let action = a.action as string | undefined;
    if (!action) {
      if (a.pattern !== undefined) action = 'spec';
      else if (a.xml !== undefined || a.formName !== undefined || a.filePath !== undefined) action = 'validate';
      else action = 'analyze';
    }
    const formRequest: CallToolRequest = {
      ...request,
      params: { ...request.params, arguments: { ...a, domain, action } },
    };
    return formPatternTool(formRequest, context);
  }

  return err(
    `object_patterns: could not determine domain (got domain/patternType="${a.domain ?? a.patternType ?? a.type ?? ''}"). ` +
    `Pass domain="table" (table field/index/relation patterns) or domain="form" (form-pattern toolkit; with action=analyze|spec|validate). ` +
    `Domain is also inferred from action/pattern/xml/formName (→ form) or tableGroup (→ table).`,
  );
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
