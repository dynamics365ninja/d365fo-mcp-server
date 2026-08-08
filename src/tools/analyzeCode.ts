/**
 * analyze_code Tool — unified "learn from the existing codebase" entry point.
 *
 * Replaces four analysis tools with one discriminated by `mode`:
 *   • patterns        → common classes/methods/dependencies for a scenario
 *   • implementations → real implementations of a similar method
 *   • completeness    → missing standard methods on a class
 *   • api-usage       → how an API is initialized and called
 *
 * Handler files stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { analyzeCodePatternsTool } from './analyzePatterns.js';
import { suggestMethodImplementationTool } from './suggestImplementation.js';
import { analyzeClassCompletenessTool } from './analyzeCompleteness.js';
import { getApiUsagePatternsTool } from './apiUsagePatterns.js';

export const ANALYZE_MODES = ['patterns', 'implementations', 'completeness', 'api-usage'] as const;
export type AnalyzeMode = (typeof ANALYZE_MODES)[number];

type AnalyzeTool = (request: CallToolRequest, context: XppServerContext) => Promise<any>;

const ANALYZE_DISPATCH: Record<AnalyzeMode, { tool: AnalyzeTool; toolName: string }> = {
  patterns:        { tool: analyzeCodePatternsTool,        toolName: 'analyze_code_patterns' },
  implementations: { tool: suggestMethodImplementationTool, toolName: 'suggest_method_implementation' },
  completeness:    { tool: analyzeClassCompletenessTool,    toolName: 'analyze_class_completeness' },
  'api-usage':     { tool: getApiUsagePatternsTool,         toolName: 'get_api_usage_patterns' },
};

const AnalyzeCodeArgsSchema = z
  .object({
    mode: z.enum(ANALYZE_MODES).describe(
      'patterns (scenario → common classes/methods), implementations (className+methodName → real examples), ' +
      'completeness (className → missing standard methods), api-usage (apiName → init/call patterns).',
    ),
  })
  .passthrough();

export async function analyzeCodeTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = AnalyzeCodeArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ analyze_code: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { mode, ...rest } = parsed.data;

  // api-usage accepts className/class/api as aliases for apiName since the "API" is often a class.
  if (mode === 'api-usage') {
    const r = rest as Record<string, unknown>;
    if (r.apiName === undefined) {
      const alt = r.className ?? r.class ?? r.api;
      if (typeof alt === 'string') r.apiName = alt;
    }
  }

  const dispatch = ANALYZE_DISPATCH[mode as AnalyzeMode];
  if (!dispatch) {
    return {
      content: [{ type: 'text', text: `❌ analyze_code: unsupported mode "${mode}".` }],
      isError: true,
    };
  }

  const subRequest: CallToolRequest = {
    method: 'tools/call',
    params: { name: dispatch.toolName, arguments: rest },
  };
  return dispatch.tool(subRequest, context);
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/analyzeCode.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
