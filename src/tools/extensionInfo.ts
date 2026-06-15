/**
 * Extensibility Tool — unified extensibility analyzer.
 *
 * Merges the former find_coc_extensions, find_event_handlers,
 * get_table_extension_info, analyze_extension_points and
 * recommend_extension_strategy tools into one tool discriminated by `mode`.
 * A single `target` parameter replaces the per-tool className/tableName/
 * objectName/targetClass names; the dispatcher remaps it to whatever the
 * underlying handler expects, so the handlers stay untouched.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { findCocExtensionsTool } from './findCocExtensions.js';
import { findEventHandlersTool } from './findEventHandlers.js';
import { tableExtensionInfoTool } from './tableExtensionInfo.js';
import { analyzeExtensionPointsTool } from './analyzeExtensionPoints.js';
import { extensionStrategyAdvisorTool } from './extensionStrategyAdvisor.js';

/** Clone the incoming request with a remapped arguments object. */
function withArgs(request: CallToolRequest, args: Record<string, any>): CallToolRequest {
  return { ...request, params: { ...request.params, arguments: args } } as CallToolRequest;
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function extensionInfoTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const mode = a.mode as string | undefined;
  const target = a.target as string | undefined;

  switch (mode) {
    case 'coc':
      if (!target) return err('extension_info(mode="coc") requires `target` (the base class or table name).');
      return findCocExtensionsTool(withArgs(request, {
        className: target,
        methodName: a.method,
        includeEventHandlers: a.includeEventHandlers,
      }), context);

    case 'events':
      if (!target) return err('extension_info(mode="events") requires `target` (the class or table whose handlers to find).');
      return findEventHandlersTool(withArgs(request, {
        ...(a.objectType === 'table' ? { targetTable: target } : { targetClass: target }),
        eventName: a.method,
        handlerType: a.handlerType,
      }), context);

    case 'table-merge':
      if (!target) return err('extension_info(mode="table-merge") requires `target` (the base table name).');
      return tableExtensionInfoTool(withArgs(request, {
        tableName: target,
        includeEffectiveSchema: a.includeEffectiveSchema,
      }), context);

    case 'points':
      if (!target) return err('extension_info(mode="points") requires `target` (the class, table, or form name).');
      return analyzeExtensionPointsTool(withArgs(request, {
        objectName: target,
        objectType: a.objectType,
        showExistingExtensions: a.showExistingExtensions,
      }), context);

    case 'strategy':
      if (!a.goal) return err('extension_info(mode="strategy") requires `goal`.');
      return extensionStrategyAdvisorTool(withArgs(request, {
        goal: a.goal,
        objectName: target,
        scenario: a.scenario,
      }), context);

    default:
      return err(`extension_info: unknown mode "${mode}". Use one of: coc, events, table-merge, points, strategy.`);
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
