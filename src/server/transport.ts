/**
 * Custom HTTP Transport for MCP over Azure Web Service
 * Implements direct JSON responses (not SSE streaming) for Azure orchestrator compatibility
 * CRITICAL: Includes server.connect() call for proper MCP protocol lifecycle
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { apiRateLimiter } from '../middleware/rateLimiter.js';
import type { XppServerContext } from '../types/context.js';

export class CustomHttpTransport implements Transport {
  private server: Server;
  private app: Express;
  private context: XppServerContext;
  private currentResponse: Response | null = null;

  // Transport interface properties
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(server: Server, app: Express, context: XppServerContext) {
    this.server = server;
    this.app = app;
    this.context = context;
    
    this.setupRoutes();
    
    // Connect server immediately (must be done before handling requests)
    this.connectServer().catch(err => {
      process.stderr.write(`Failed to connect server: ${err}\n`);
    });
  }

  /**
   * Connects MCP server to this transport
   * CRITICAL: Must be called for proper protocol lifecycle and completion signaling
   */
  async connectServer(): Promise<void> {
    await this.server.connect(this);
    process.stdout.write('✅ MCP Server connected to CustomHttpTransport\n');
  }

  // Transport interface methods
  async start(): Promise<void> {
    // HTTP transport doesn't need explicit start
  }

  async close(): Promise<void> {
    this.currentResponse = null;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Called by MCP server when it has a response - send it via HTTP
    if (this.currentResponse && !this.currentResponse.headersSent) {
      this.currentResponse.json(message);
      this.currentResponse = null;
    }
  }

  private setupRoutes(): void {
    // Apply rate limiting
    this.app.use('/mcp', apiRateLimiter);

    // MCP endpoint - direct JSON-RPC
    this.app.post('/mcp', async (req: Request, res: Response): Promise<void> => {
      try {
        const request = req.body as JSONRPCRequest;
        
        if (!request.jsonrpc || !request.method) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32600,
              message: 'Invalid Request: missing jsonrpc or method',
            },
            id: null,
          });
          return;
        }

        // Store response object for send() method
        this.currentResponse = res;

        // Handle notifications (no response expected)
        if (!('id' in request)) {
          if (this.onmessage) {
            this.onmessage(request);
          }
          res.status(202).json({ status: 'accepted' });
          this.currentResponse = null;
          return;
        }

        // Handle requests - send to MCP server via onmessage
        // Server will call send() with the response
        if (this.onmessage) {
          this.onmessage(request);
        } else {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Transport not connected',
            },
            id: request.id,
          });
          this.currentResponse = null;
        }
      } catch (error) {
        process.stderr.write(`MCP transport error: ${error}\n`);
        this.currentResponse = null;
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal error',
            },
            id: null,
          });
        }
      }
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        symbols: this.context.symbolIndex.getSymbolCount(),
      });
    });
  }
}

// Factory function
export function createStreamableHttpTransport(
  server: Server,
  app: Express,
  context: XppServerContext
): CustomHttpTransport {
  return new CustomHttpTransport(server, app, context);
}

