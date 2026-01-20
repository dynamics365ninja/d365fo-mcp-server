import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { searchTool } from './search.js';
import { classInfoTool } from './classInfo.js';
import { tableInfoTool } from './tableInfo.js';
import { completionTool } from './completion.js';
import { codeGenTool } from './codeGen.js';
import { extensionSearchTool } from './extensionSearch.js';

/**
 * Centralized tool handler that dispatches to individual tool implementations
 */
export function registerToolHandler(server: Server, context: XppServerContext): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    switch (toolName) {
      case 'xpp_search':
        return searchTool(request, context);
      case 'xpp_search_extensions':
        return extensionSearchTool(request, context);
      case 'xpp_get_class':
        return classInfoTool(request, context);
      case 'xpp_get_table':
        return tableInfoTool(request, context);
      case 'xpp_complete_method':
        return completionTool(request, context);
      case 'xpp_generate_code':
        return codeGenTool(request);
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
