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
  private pendingRequests = new Map<string | number, (message: JSONRPCMessage) => void>();

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
    process.stdout.write('🔌 Connecting MCP Server to CustomHttpTransport...\n');
    await this.server.connect(this);
    process.stdout.write('✅ MCP Server connected to CustomHttpTransport\n');
  }

  // Transport interface methods
  async start(): Promise<void> {
    // HTTP transport doesn't need explicit start
  }

  async close(): Promise<void> {
    this.currentResponse = null;
    this.pendingRequests.clear();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Called by MCP server when it has a response
    process.stdout.write(`🔵 Transport.send() called: ${JSON.stringify(message).substring(0, 200)}\n`);
    
    // If this is a response to a request (has id), resolve the pending promise
    if ('id' in message && message.id !== undefined && message.id !== null) {
      process.stdout.write(`✅ Resolving request ID: ${message.id}\n`);
      const resolver = this.pendingRequests.get(message.id);
      if (resolver) {
        resolver(message);
        this.pendingRequests.delete(message.id);
        return;
      }
      process.stdout.write(`⚠️ No resolver found for ID: ${message.id}\n`);
    } else {
      process.stdout.write(`📢 Notification/message without ID: ${(message as any).method || 'unknown'}\n`);
    }
    
    // Fallback: send via currentResponse if available
    if (this.currentResponse && !this.currentResponse.headersSent) {
      process.stdout.write(`📤 Sending via currentResponse (fallback)\n`);
      this.currentResponse.json(message);
      this.currentResponse = null;
    } else {
      process.stdout.write(`⚠️ No currentResponse available or headers already sent\n`);
    }
  }

  private setupRoutes(): void {
    // Apply rate limiting
    this.app.use('/mcp', apiRateLimiter);

    // MCP endpoint - direct JSON-RPC
    this.app.post('/mcp', async (req: Request, res: Response): Promise<void> => {
      try {
        // Disable Keep-Alive to close connection after each response
        res.setHeader('Connection', 'close');
        
        const request = req.body as JSONRPCRequest;
        process.stdout.write(`\n📥 Incoming request: ${JSON.stringify(request).substring(0, 200)}\n`);
        
        if (!request.jsonrpc || !request.method) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32600,
              message: 'Invalid Request: missing jsonrpc or method',
            },
            id: null,
          });
          process.stdout.write(`❌ Invalid request, closing connection\n`);
          return;
        }

        // Store response object for send() method
        this.currentResponse = res;

        // Handle notifications (no response expected)
        if (!('id' in request)) {
          process.stdout.write(`📢 Notification received (no ID): ${(request as any).method}\n`);
          
          // Handle special notifications
          if ((request as any).method === 'notifications/cancelled' || 
              (request as any).method === 'cancelled' ||
              (request as any).method === 'shutdown') {
            process.stdout.write(`🛑 Session termination notification received\n`);
            // Send 202 and signal completion
            res.status(202).json({ status: 'accepted', completed: true });
            this.currentResponse = null;
            
            // Trigger cleanup after response is sent
            setImmediate(() => {
              if (this.onclose) {
                process.stdout.write(`🔚 Calling onclose handler\n`);
                this.onclose();
              }
            });
            return;
          }
          
          if (this.onmessage) {
            this.onmessage(request);
          }
          res.status(202).json({ status: 'accepted' });
          process.stdout.write(`✅ Notification acknowledged with 202\n`);
          this.currentResponse = null;
          return;
        }

        // Handle requests - send to MCP server via onmessage
        // Wait for response via Promise
        if (this.onmessage) {
          process.stdout.write(`⏳ Creating promise for request ID: ${request.id}\n`);
          const responsePromise = new Promise<JSONRPCMessage>((resolve, reject) => {
            this.pendingRequests.set(request.id, resolve);
            process.stdout.write(`📋 Registered resolver for ID: ${request.id}, pending count: ${this.pendingRequests.size}\n`);
            
            // Timeout after 30 seconds
            setTimeout(() => {
              if (this.pendingRequests.has(request.id)) {
                this.pendingRequests.delete(request.id);
                process.stdout.write(`⏰ TIMEOUT for request ID: ${request.id}\n`);
                reject(new Error('Request timeout'));
              }
            }, 30000);
          });

          // Send request to MCP server
          process.stdout.write(`📤 Calling onmessage() for request ID: ${request.id}\n`);
          this.onmessage(request);
          process.stdout.write(`⏳ Awaiting response for ID: ${request.id}...\n`);
          
          // Wait for response from send()
          const response = await responsePromise;
          process.stdout.write(`✅ Response received for ID: ${request.id}, sending to client\n`);
          process.stdout.write(`📨 Response: ${JSON.stringify(response).substring(0, 300)}...\n`);
          res.json(response);
          process.stdout.write(`✅ HTTP response sent for ID: ${request.id}, connection will close\n`);
          this.currentResponse = null;
        } else {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Transport not connected',
            },
            id: request.id,
          });
        }
      } catch (error) {
        const requestId = 'id' in (req.body as any) ? (req.body as any).id : 'unknown';
        process.stderr.write(`❌ MCP transport error for request ID ${requestId}: ${error}\n`);
        if (error instanceof Error) {
          process.stderr.write(`   Stack: ${error.stack}\n`);
        }
        this.currentResponse = null;
        
        // Clean up pending request if it exists
        if ('id' in (req.body as any)) {
          this.pendingRequests.delete((req.body as any).id);
          process.stdout.write(`🧹 Cleaned up pending request ID: ${requestId}\n`);
        }
        
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

