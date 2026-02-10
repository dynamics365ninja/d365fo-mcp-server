/**
 * MCP Server Configuration and Setup
 * Registers tools, resources, and prompts for X++ code completion
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerToolHandler } from '../tools/toolHandler.js';
import { registerClassResource } from '../resources/classResource.js';
import { registerWorkspaceResources } from '../resources/workspaceResource.js';
import { registerCodeReviewPrompt } from '../prompts/codeReview.js';
import type { XppServerContext } from '../types/context.js';

export type { XppServerContext };

export function createXppMcpServer(context: XppServerContext): Server {
  const server = new Server(
    {
      name: 'xpp-code-completion-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // Register centralized tool handler
  registerToolHandler(server, context);

  // Register resources
  registerClassResource(server, context);
  registerWorkspaceResources(server, context);

  // Register prompts (includes system instructions)
  registerCodeReviewPrompt(server, context);

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'search',
          description: 'Search for X++ classes, tables, methods, and fields by name or keyword',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (class name, method name, table name, etc.)' },
              type: { 
                type: 'string', 
                enum: ['class', 'table', 'field', 'method', 'enum', 'all'],
                description: 'Filter by object type (class=AxClass, table=AxTable, enum=AxEnum, all=no filter)',
                default: 'all'
              },
              limit: { type: 'number', description: 'Maximum results to return', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'batch_search',
          description: `Execute multiple X++ symbol searches in parallel within a single request.

This tool enables efficient exploration by running independent searches concurrently,
reducing HTTP round-trip overhead and total execution time.

Use cases:
- Exploring multiple related concepts simultaneously (e.g., "dimension", "helper", "validation")
- Comparing different search queries at once
- Reducing workflow time for exploratory searches

Performance:
- 3 sequential searches: ~150ms (3 HTTP requests)
- 3 parallel searches: ~50ms (1 HTTP request) → 3x faster

Workspace-aware: Each query can optionally include workspace files by specifying
workspacePath and includeWorkspace parameters.`,
          inputSchema: {
            type: 'object',
            properties: {
              queries: {
                type: 'array',
                description: 'Array of search queries to execute in parallel (max 10 queries)',
                minItems: 1,
                maxItems: 10,
                items: {
                  type: 'object',
                  properties: {
                    query: {
                      type: 'string',
                      description: 'Search query (class name, method name, etc.)',
                    },
                    type: {
                      type: 'string',
                      enum: ['class', 'table', 'field', 'method', 'enum', 'all'],
                      default: 'all',
                      description: 'Filter by object type',
                    },
                    limit: {
                      type: 'number',
                      default: 10,
                      description: 'Maximum results to return for this query',
                    },
                    workspacePath: {
                      type: 'string',
                      description: 'Optional workspace path to search local files',
                    },
                    includeWorkspace: {
                      type: 'boolean',
                      default: false,
                      description: 'Whether to include workspace files in results',
                    },
                  },
                  required: ['query'],
                },
              },
            },
            required: ['queries'],
          },
        },
        {
          name: 'search_extensions',
          description: 'Search for symbols only in custom extensions/ISV models',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (class name, method name, etc.)' },
              prefix: { type: 'string', description: 'Extension prefix filter (e.g., ISV_, Custom_)' },
              limit: { type: 'number', description: 'Maximum results to return', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_class_info',
          description: 'Get detailed information about an X++ class including its methods',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the X++ class' },
            },
            required: ['className'],
          },
        },
        {
          name: 'get_table_info',
          description: 'Get detailed information about an X++ table including fields, indexes, and relations',
          inputSchema: {
            type: 'object',
            properties: {
              tableName: { type: 'string', description: 'Name of the X++ table' },
            },
            required: ['tableName'],
          },
        },
        {
          name: 'code_completion',
          description: 'Get method and field completions for classes or tables - provides IntelliSense-like code completion',
          inputSchema: {
            type: 'object',
            properties: {
              objectName: { type: 'string', description: 'Class or table name' },
              prefix: { type: 'string', description: 'Method/field name prefix to filter', default: '' },
            },
            required: ['objectName'],
          },
        },
        {
          name: 'generate_code',
          description: 'Generate X++ code templates for common patterns',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { 
                type: 'string', 
                enum: ['class', 'runnable', 'form-handler', 'data-entity', 'batch-job'],
                description: 'Code pattern to generate' 
              },
              name: { type: 'string', description: 'Name for the generated element' },
            },
            required: ['pattern', 'name'],
          },
        },
        {
          name: 'analyze_code_patterns',
          description: 'Analyze existing codebase for similar code patterns. Essential for creating code based on real D365FO patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              scenario: { type: 'string', description: 'Description of the scenario or functionality to analyze (e.g., "financial dimensions", "inventory transactions")' },
              classPattern: { type: 'string', description: 'Optional class name pattern to filter results (e.g., "Helper", "Service")' },
              limit: { type: 'number', description: 'Maximum number of pattern examples to return', default: 5 },
            },
            required: ['scenario'],
          },
        },
        {
          name: 'suggest_method_implementation',
          description: 'Suggest method body implementation based on similar methods in the codebase. Provides real examples from actual D365FO code.',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the class containing the method' },
              methodName: { type: 'string', description: 'Name of the method to implement' },
              parameters: { type: 'string', description: 'Optional method parameters to help find similar methods' },
            },
            required: ['className', 'methodName'],
          },
        },
        {
          name: 'analyze_class_completeness',
          description: 'Analyze a class and suggest missing methods based on similar classes. Helps identify methods to follow common patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the class to analyze' },
            },
            required: ['className'],
          },
        },
        {
          name: 'get_api_usage_patterns',
          description: 'Get common usage patterns for a specific API or class. Shows initialization patterns and method call sequences.',
          inputSchema: {
            type: 'object',
            properties: {
              apiName: { type: 'string', description: 'Name of the API/class to get usage patterns for' },
              context: { type: 'string', description: 'Optional context to filter patterns (e.g., "initialization", "validation")' },
            },
            required: ['apiName'],
          },
        },
      ],
    };
  });

  return server;
}
