/**
 * Streamable HTTP Transport Layer
 * Handles Express.js routes and session management for MCP protocol
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { apiRateLimiter } from '../middleware/rateLimiter.js';
import type { XppServerContext } from '../types/context.js';
import { searchTool } from '../tools/search.js';
import { classInfoTool } from '../tools/classInfo.js';
import { tableInfoTool } from '../tools/tableInfo.js';
import { completionTool } from '../tools/completion.js';
import { codeGenTool } from '../tools/codeGen.js';
import { extensionSearchTool } from '../tools/extensionSearch.js';

interface McpSession {
  id: string;
  createdAt: Date;
  lastActivity: Date;
}

export class StreamableHttpTransport {
  private sessions = new Map<string, McpSession>();
  private readonly sessionTimeout = 30 * 60 * 1000; // 30 minutes

  constructor(
    _server: Server,
    private app: Express,
    private context: XppServerContext
  ) {
    this.setupRoutes();
    this.startSessionCleanup();
  }

  private setupRoutes(): void {
    // Apply rate limiting to MCP endpoints
    this.app.use('/mcp', apiRateLimiter);

    // POST handler - main MCP endpoint for tool calls
    this.app.post('/mcp', async (req: Request, res: Response) => {
      const sessionId = (req.headers['mcp-session-id'] as string) || this.createSession();

      try {
        // Update session activity
        const session = this.sessions.get(sessionId);
        if (session) {
          session.lastActivity = new Date();
        }

        // Process MCP request
        const result = await this.handleMcpRequest(req.body, sessionId);

        res.setHeader('Mcp-Session-Id', sessionId);
        res.json(result);
      } catch (error) {
        console.error('MCP request error:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal server error',
          },
          id: req.body.id || null,
        });
      }
    });

    // GET handler - SSE stream for notifications (optional)
    this.app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string;

      if (!sessionId || !this.sessions.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Mcp-Session-Id', sessionId);

      // Send keepalive
      const keepalive = setInterval(() => {
        res.write(':keepalive\n\n');
      }, 15000);

      req.on('close', () => {
        clearInterval(keepalive);
      });
    });

    // DELETE handler - terminate session
    this.app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string;

      if (sessionId && this.sessions.has(sessionId)) {
        this.sessions.delete(sessionId);
        res.status(200).send('Session terminated');
      } else {
        res.status(404).send('Session not found');
      }
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        sessions: this.sessions.size,
        timestamp: new Date().toISOString(),
      });
    });
  }

  private createSession(): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
    });
    return sessionId;
  }

  private async handleMcpRequest(body: any, sessionId: string): Promise<any> {
    // Basic JSON-RPC 2.0 validation
    if (!body.jsonrpc || body.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC version');
    }

    if (!body.method) {
      throw new Error('Missing method');
    }

    // Route to appropriate handler based on method
    switch (body.method) {
      case 'initialize':
        return this.handleInitialize(body, sessionId);
      case 'notifications/initialized':
        // Client confirms initialization - no response needed for notifications
        return { jsonrpc: '2.0', result: {}, id: body.id };
      case 'ping':
        return { jsonrpc: '2.0', result: {}, id: body.id };
      case 'tools/list':
        return this.handleListTools(body);
      case 'tools/call':
        return this.handleCallTool(body);
      case 'resources/list':
        return this.handleListResources(body);
      case 'resources/templates/list':
        return this.handleListResourceTemplates(body);
      case 'resources/read':
        return this.handleReadResource(body);
      case 'prompts/list':
        return this.handleListPrompts(body);
      case 'prompts/get':
        return this.handleGetPrompt(body);
      default:
        throw new Error(`Unknown method: ${body.method}`);
    }
  }

  private async handleInitialize(body: any, sessionId: string): Promise<any> {
    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: 'xpp-code-completion-server',
          version: '1.0.0',
        },
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        instructions: 'X++ code completion server for D365 Finance & Operations',
        sessionId,
      },
      id: body.id,
    };
  }

  private async handleListTools(body: any): Promise<any> {
    return {
      jsonrpc: '2.0',
      result: {
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
            name: 'xpp_completion',
            description: 'Get method/field completions for a class or table',
            inputSchema: {
              type: 'object',
              properties: {
                className: { type: 'string', description: 'Class or table name' },
                prefix: { type: 'string', description: 'Method name prefix' },
              },
              required: ['className'],
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
      },
      id: body.id,
    };
  }

  private async handleCallTool(body: any): Promise<any> {
    try {
      const { name, arguments: args } = body.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };

      // Log tool invocation
      console.log(`[MCP] Tool called: ${name} with args:`, JSON.stringify(args));

      // Build the CallToolRequest
      const request: CallToolRequest = {
        method: "tools/call",
        params: {
          name,
          arguments: args || {},
        },
      };

      // Route to the appropriate tool handler
      let result: any;
      switch (name) {
        case "xpp_search":
          result = await searchTool(request, this.context);
          break;
        case "xpp_get_class":
          result = await classInfoTool(request, this.context);
          break;
        case "xpp_get_table":
          result = await tableInfoTool(request, this.context);
          break;
        case "xpp_completion":
          result = await completionTool(request, this.context);
          break;
        case "xpp_generate_code":
          result = await codeGenTool(request);
          break;
        case "xpp_search_extensions":
          result = await extensionSearchTool(request, this.context);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Log the result
      console.log(`[MCP] Tool ${name} returned:`, JSON.stringify(result).substring(0, 500));

      return {
        jsonrpc: "2.0",
        result,
        id: body.id,
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Tool call failed',
        },
        id: body.id,
      };
    }
  }

  private async handleListResources(body: any): Promise<any> {
    // TODO: This is a stub - actual resource listing is handled by MCP SDK handlers in mcpServer.ts
    return {
      jsonrpc: '2.0',
      result: {
        resources: [],
      },
      id: body.id,
    };
  }

  private async handleListResourceTemplates(body: any): Promise<any> {
    return {
      jsonrpc: '2.0',
      result: {
        resourceTemplates: [],
      },
      id: body.id,
    };
  }

  private async handleReadResource(body: any): Promise<any> {
    const { uri } = body.params;
    // TODO: This is a stub - actual resource reading is handled by MCP SDK handlers in classResource.ts
    throw new Error(`Resource not found: ${uri}`);
  }

  private async handleListPrompts(body: any): Promise<any> {
    // TODO: This is a stub - actual prompt listing is handled by MCP SDK handlers in codeReview.ts
    return {
      jsonrpc: '2.0',
      result: {
        prompts: [],
      },
      id: body.id,
    };
  }

  private async handleGetPrompt(body: any): Promise<any> {
    const { name } = body.params;
    // TODO: This is a stub - actual prompt retrieval is handled by MCP SDK handlers in codeReview.ts
    throw new Error(`Prompt not found: ${name}`);
  }

  private startSessionCleanup(): void {
    // Clean up expired sessions every 5 minutes
    setInterval(() => {
      const now = new Date();
      for (const [sessionId, session] of this.sessions.entries()) {
        const elapsed = now.getTime() - session.lastActivity.getTime();
        if (elapsed > this.sessionTimeout) {
          console.log(`Cleaning up expired session: ${sessionId}`);
          this.sessions.delete(sessionId);
        }
      }
    }, 5 * 60 * 1000);
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }
}

// Export factory function for easier consumption
export function createStreamableHttpTransport(
  server: Server, 
  app: Express, 
  context: XppServerContext
): StreamableHttpTransport {
  return new StreamableHttpTransport(server, app, context);
}
