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
      ],
    };
  });

  return server;
}
