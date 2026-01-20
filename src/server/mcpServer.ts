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

  // Register prompts
  registerCodeReviewPrompt(server, context);

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'xpp_search',
          description: 'Search for X++ symbols by name or keyword',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'number', description: 'Maximum results' },
            },
            required: ['query'],
          },
        },
        {
          name: 'xpp_search_extensions',
          description: 'Search for X++ symbols only in custom extensions/ISV models',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              prefix: { type: 'string', description: 'Extension prefix filter (e.g., ISV_, Custom_)' },
              limit: { type: 'number', description: 'Maximum results' },
            },
            required: ['query'],
          },
        },
        {
          name: 'xpp_get_class',
          description: 'Get detailed information about an X++ class',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the class' },
            },
            required: ['className'],
          },
        },
        {
          name: 'xpp_get_table',
          description: 'Get detailed information about an X++ table',
          inputSchema: {
            type: 'object',
            properties: {
              tableName: { type: 'string', description: 'Name of the table' },
            },
            required: ['tableName'],
          },
        },
        {
          name: 'xpp_complete_method',
          description: 'Get method/field completions for a class or table',
          inputSchema: {
            type: 'object',
            properties: {
              objectName: { type: 'string', description: 'Class or table name' },
              prefix: { type: 'string', description: 'Method name prefix' },
            },
            required: ['objectName'],
          },
        },
        {
          name: 'xpp_generate_code',
          description: 'Generate X++ code templates',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { 
                type: 'string', 
                enum: ['class', 'runnable', 'form-handler', 'data-entity', 'batch-job'],
                description: 'Code pattern type' 
              },
              name: { type: 'string', description: 'Element name' },
            },
            required: ['pattern', 'name'],
          },
        },
      ],
    };
  });

  return server;
}
