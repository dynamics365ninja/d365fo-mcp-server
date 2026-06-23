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
import { resolvePatternExact } from '../knowledge/formPatterns/index.js';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function objectPatternsTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  // Accept `patternType` / `type` / `objectType` as aliases for the `domain`
  // discriminator — agents frequently reach for these names.
  const aliasRaw = a.domain ?? a.patternType ?? a.type ?? a.objectType;
  let domain = aliasRaw as string | undefined;

  // A recognized FORM PATTERN NAME (e.g. "SimpleList", "DetailsMaster") passed
  // via patternType/type/objectType is not a domain — agents conflate "which
  // pattern" with the table/form discriminator. Route it to the form toolkit and
  // spec out that pattern. resolvePatternExact only matches real id/xmlName/alias
  // (exact, case-insensitive), so concept nouns like "number-sequence" still fall
  // through to the get_knowledge redirect below.
  let inferredPattern: string | undefined;
  if (domain !== 'table' && domain !== 'form' && typeof aliasRaw === 'string') {
    const spec = resolvePatternExact(aliasRaw);
    if (spec) {
      inferredPattern = spec.xmlName;
      domain = 'form';
    }
  }

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
    const pattern = a.pattern ?? inferredPattern;
    let action = a.action as string | undefined;
    if (!action) {
      if (pattern !== undefined) action = 'spec';
      else if (a.xml !== undefined || a.formName !== undefined || a.filePath !== undefined) action = 'validate';
      else action = 'analyze';
    }
    const formRequest: CallToolRequest = {
      ...request,
      params: {
        ...request.params,
        arguments: { ...a, domain, action, ...(pattern !== undefined ? { pattern } : {}) },
      },
    };
    return formPatternTool(formRequest, context);
  }

  const got = a.domain ?? a.patternType ?? a.type ?? a.objectType ?? '';
  return err(
    `object_patterns: could not determine domain (got domain/objectType="${got}"). ` +
    `This tool only covers table and form patterns — pass domain="table" (table field/index/relation patterns) ` +
    `or domain="form" (form-pattern toolkit; with action=analyze|spec|validate). ` +
    `Domain is also inferred from action/pattern/xml/formName (→ form) or tableGroup (→ table).\n\n` +
    `If you were after a feature/concept (e.g. "number-sequence", SysOperation, RunBase, data events), ` +
    `that is a knowledge topic — use get_knowledge(topic="${typeof got === 'string' && got ? got : '<topic>'}") instead.`,
  );
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
