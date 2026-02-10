/**
 * Workspace Resources
 * MCP Resources for exposing workspace context to clients
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { XppServerContext } from '../types/context.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export function registerWorkspaceResources(
  server: Server,
  _context: XppServerContext
): void {
  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'workspace://stats',
          name: 'Workspace Statistics',
          description: 'Get statistics about files in the workspace',
          mimeType: 'application/json',
        },
        {
          uri: 'workspace://files',
          name: 'Workspace Files',
          description: 'List all X++ files in the workspace',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === 'workspace://stats') {
      // Workspace statistics resource
      // Note: Client must provide workspace path via tool arguments
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                message:
                  'To get workspace stats, use the search tool with workspacePath parameter',
                example: {
                  tool: 'search',
                  args: {
                    query: '*',
                    includeWorkspace: true,
                    workspacePath: 'C:\\Your\\Workspace\\Path',
                  },
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (uri === 'workspace://files') {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                message:
                  'To list workspace files, use the search tool with workspacePath parameter',
                example: {
                  tool: 'search',
                  args: {
                    query: '',
                    includeWorkspace: true,
                    workspacePath: 'C:\\Your\\Workspace\\Path',
                  },
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });
}
