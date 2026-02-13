import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { searchTool } from './search.js';
import { batchSearchTool } from './batchSearch.js';
import { classInfoTool } from './classInfo.js';
import { tableInfoTool } from './tableInfo.js';
import { completionTool } from './completion.js';
import { codeGenTool } from './codeGen.js';
import { extensionSearchTool } from './extensionSearch.js';
import { analyzeCodePatternsTool } from './analyzePatterns.js';
import { suggestMethodImplementationTool } from './suggestImplementation.js';
import { analyzeClassCompletenessTool } from './analyzeCompleteness.js';
import { getApiUsagePatternsTool } from './apiUsagePatterns.js';
import { handleCreateD365File } from './createD365File.js';

/**
 * Centralized tool handler that dispatches to individual tool implementations
 */
export function registerToolHandler(server: Server, context: XppServerContext): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    switch (toolName) {
      case 'search':
        return searchTool(request, context);
      case 'batch_search':
        return batchSearchTool(request, context);
      case 'search_extensions':
        return extensionSearchTool(request, context);
      case 'get_class_info':
        return classInfoTool(request, context);
      case 'get_table_info':
        return tableInfoTool(request, context);
      case 'code_completion':
        return completionTool(request, context);
      case 'generate_code':
        return codeGenTool(request);
      case 'analyze_code_patterns':
        return analyzeCodePatternsTool(request, context);
      case 'suggest_method_implementation':
        return suggestMethodImplementationTool(request, context);
      case 'analyze_class_completeness':
        return analyzeClassCompletenessTool(request, context);
      case 'get_api_usage_patterns':
        return getApiUsagePatternsTool(request, context);
      case 'create_d365fo_file':
        return handleCreateD365File(request);
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${toolName}`,
            },
          ],
          isError: true,
        };
    }
  });
}
