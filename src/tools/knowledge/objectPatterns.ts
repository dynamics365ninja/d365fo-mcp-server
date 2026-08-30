/**
 * Patterns Tool — unified pattern toolkit.
 *
 * Merges the former get_table_patterns and form_pattern tools into one tool
 * discriminated by `domain`:
 *   • table → field/index/relation patterns for D365FO tables (get_table_patterns)
 *   • form  → form-pattern toolkit with its own `action` (analyze/spec/validate)
 *   • mobile-app → warehouse-app screen recipes, led by the two-framework choice
 *
 * The two underlying handlers read their own fields (table: tableGroup/similarTo/
 * limit; form: action/...) and ignore the `domain` discriminator (no strict
 * schemas), so the request is passed straight through.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../types/context.js';
import { getTablePatternsTool } from './getTablePatterns.js';
import { formPatternTool } from './formPattern.js';
import { getReportPatternsTool } from './getReportPatterns.js';
import { getMobileAppPatternsTool } from './getMobileAppPatterns.js';
import { resolvePatternExact } from '../../knowledge/formPatterns/index.js';
import { resolveReportPattern } from '../../knowledge/reportPatterns/index.js';
import { resolveMobileAppPattern } from '../../knowledge/mobileAppPatterns/index.js';

/** Domains routed below; anything else is inferred or reported. */
function isKnownDomain(d: unknown): boolean {
  return d === 'table' || d === 'form' || d === 'report' || d === 'mobile-app';
}

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
  if (!isKnownDomain(domain) && typeof aliasRaw === 'string') {
    const spec = resolvePatternExact(aliasRaw);
    if (spec) {
      inferredPattern = spec.xmlName;
      domain = 'form';
    } else if (resolveMobileAppPattern(aliasRaw)) {
      inferredPattern = aliasRaw;
      domain = 'mobile-app';
    } else if (resolveReportPattern(aliasRaw)) {
      // A report pattern id (e.g. "PrintMgmtFormLetter") passed as the domain.
      inferredPattern = aliasRaw;
      domain = 'report';
    }
  }

  // A pattern name that only the report catalog recognizes routes to it even
  // when the caller said nothing about domains.
  if (!isKnownDomain(domain)
      && typeof a.pattern === 'string' && !resolvePatternExact(a.pattern) && resolveReportPattern(a.pattern)) {
    domain = 'report';
  }

  // Infer the discriminator from form/table-specific params when omitted.
  if (!isKnownDomain(domain)) {
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

  if (domain === 'mobile-app') {
    const mobileRequest: CallToolRequest = inferredPattern !== undefined && a.pattern === undefined
      ? { ...request, params: { ...request.params, arguments: { ...a, pattern: inferredPattern } } }
      : request;
    return getMobileAppPatternsTool(mobileRequest);
  }

  if (domain === 'report') {
    const reportRequest: CallToolRequest = inferredPattern !== undefined && a.pattern === undefined
      ? { ...request, params: { ...request.params, arguments: { ...a, pattern: inferredPattern } } }
      : request;
    return getReportPatternsTool(reportRequest);
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
    `This tool covers table, form and report patterns — pass domain="table" (field/index/relation patterns), ` +
    `domain="form" (form-pattern toolkit; with action=analyze|spec|validate) ` +
    `domain="report" (SSRS implementation recipes; optional pattern=<id>) ` +
    `or domain="mobile-app" (warehouse-app screens: ProcessGuide vs WHSWorkExecuteDisplay, create and modify). ` +
    `Domain is also inferred from action/pattern/xml/formName (→ form) or tableGroup (→ table).\n\n` +
    `If you were after a feature/concept (e.g. "number-sequence", SysOperation, RunBase, data events), ` +
    `that is a knowledge topic — use get_knowledge(topic="${typeof got === 'string' && got ? got : '<topic>'}") instead.`,
  );
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/objectPatterns.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
