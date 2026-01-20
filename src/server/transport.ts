/**
 * Streamable HTTP Transport Layer
 * Handles Express.js routes and session management for MCP protocol
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { apiRateLimiter } from '../middleware/rateLimiter.js';

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
    private app: Express
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
      case 'tools/list':
        return this.handleListTools(body);
      case 'tools/call':
        return this.handleCallTool(body);
      case 'resources/list':
        return this.handleListResources(body);
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
        protocolVersion: '2025-11-25',
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
    // TODO: This is a stub - actual tool listing is handled by MCP SDK handlers in mcpServer.ts
    // Tools will be registered by individual tool modules
    return {
      jsonrpc: '2.0',
      result: {
        tools: [],
      },
      id: body.id,
    };
  }

  private async handleCallTool(body: any): Promise<any> {
    const { name, arguments: args } = body.params;

    // TODO: This is a stub - actual tool calls are routed by the centralized tool handler in toolHandler.ts
    // Tool calls will be routed by individual tool handlers
    return {
      jsonrpc: '2.0',
      result: {
        content: [{ type: 'text', text: `Tool ${name} called with args: ${JSON.stringify(args)}` }],
      },
      id: body.id,
    };
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
export function createStreamableHttpTransport(server: Server, app: Express): StreamableHttpTransport {
  return new StreamableHttpTransport(server, app);
}
