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
import { getConfigManager } from '../utils/configManager.js';
import { buildProgressMessage } from '../utils/toolProgressMessage.js';

/**
 * Per-request timeout for the HTTP transport (ms).
 * Azure App Service + SQLite over SMB storage can be significantly slower than
 * local SSD. batch_search may run 10 parallel FTS5 queries which compounds the
 * latency. Default 120 s is generous but still well below Azure's 230 s limit.
 */
const TOOL_TIMEOUT_MS = Math.max(10_000,
  parseInt(process.env.MCP_TOOL_TIMEOUT_MS || '120000', 10) || 120_000
);

/**
 * Extract workspace folder path from GitHub Copilot MCP request.
 * Copilot can pass workspace info via HTTP headers or _meta in params.
 * Returns a local file-system path (converts file:// URI → path).
 */
function extractWorkspaceFromRequest(req: Request, requestBody: JSONRPCRequest): string | null {
  // 1. Check known VS Code / GitHub Copilot HTTP headers
  const headerCandidates = [
    req.headers['x-vscode-workspace-folder-uris'],
    req.headers['x-vscode-workspace-folder'],
    req.headers['x-github-copilot-workspace'],
    req.headers['x-workspace-folder'],
    req.headers['x-workspace'],
  ];
  for (const h of headerCandidates) {
    const val = Array.isArray(h) ? h[0] : h;
    if (val) {
      const path = fileUriToPath(val.split(',')[0].trim());
      if (path) return path;
    }
  }

  // 2. Check params._meta for workspace folder URIs (tool calls and initialize)
  const meta = (requestBody as any).params?._meta;
  if (meta) {
    // Array form: workspaceFolders / workspaceFolderUris
    for (const key of ['workspaceFolders', 'workspaceFolderUris', 'roots']) {
      const val = meta[key];
      if (Array.isArray(val) && val.length > 0) {
        const first = typeof val[0] === 'string' ? val[0] : val[0]?.uri;
        const path = fileUriToPath(first);
        if (path) return path;
      }
    }
    // Single string form
    for (const key of ['workspaceFolderUri', 'workspaceFolder', 'workspacePath']) {
      const val = meta[key];
      if (typeof val === 'string') {
        const path = fileUriToPath(val);
        if (path) return path;
      }
    }
  }

  return null;
}

/** Convert file:// URI to a local path, or return the string as-is if not a URI */
function fileUriToPath(uri: string | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('file:///')) {
    // file:///K:/VSProjects/... → K:/VSProjects/...
    const decoded = decodeURIComponent(uri.slice('file:///'.length));
    // Normalize Windows path separators
    return decoded.replace(/\//g, '\\');
  }
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.slice('file://'.length)).replace(/\//g, '\\');
  }
  // Already a local path
  if (uri.length > 2 && (uri[1] === ':' || uri.startsWith('\\\\'))) {
    return uri;
  }
  return null;
}

export class CustomHttpTransport implements Transport {
  private server: Server;
  private app: Express;
  private context: XppServerContext;
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
    await this.server.connect(this);
  }

  // Transport interface methods
  async start(): Promise<void> {
    // HTTP transport doesn't need explicit start
  }

  async close(): Promise<void> {
    this.pendingRequests.clear();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Route response to the correct pending request by id
    if ('id' in message && message.id !== undefined && message.id !== null) {
      const resolver = this.pendingRequests.get(message.id);
      if (resolver) {
        resolver(message);
        this.pendingRequests.delete(message.id);
        return;
      }
    }
    // Notifications / server-initiated messages with no id — nothing to route
  }

  private setupRoutes(): void {
    // Apply rate limiting
    this.app.use('/mcp', apiRateLimiter);

    // MCP endpoint - direct JSON-RPC
    this.app.post('/mcp', async (req: Request, res: Response): Promise<void> => {
      // Declare here so the catch block can clean it up regardless of where an error fires
      let internalId: string | undefined;
      try {
        // Set response headers (keep-alive enabled for performance)
        res.setHeader('Content-Type', 'application/json');
        
        const request = req.body as JSONRPCRequest;

        // Extract GitHub Copilot workspace path for per-request isolation.
        // We no longer mutate the global ConfigManager singleton — instead both
        // onmessage call-sites below run inside runWithRequestContext so concurrent
        // requests from different users never bleed their workspacePath through
        // the shared runtimeContext.
        const workspacePath = extractWorkspaceFromRequest(req, request);
        const requestCtx = workspacePath ? { workspacePath } : {};

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

        // Handle notifications (no response expected)
        if (!('id' in request)) {
          // Handle special notifications
          if ((request as any).method === 'notifications/cancelled' || 
              (request as any).method === 'cancelled' ||
              (request as any).method === 'shutdown') {
            // Send 202 and signal completion
            res.status(202).json({ status: 'accepted', completed: true });
            
            // Trigger cleanup after response is sent
            setImmediate(() => {
              if (this.onclose) {
                this.onclose();
              }
            });
            return;
          }
          
          if (this.onmessage) {
            // Notifications don't need response routing, but they DO need the correct
            // per-request workspacePath context so tool dispatch is consistent.
            getConfigManager().runWithRequestContext(requestCtx, () => {
              this.onmessage!(request);
              return Promise.resolve();
            }).catch(() => {});
          }
          res.status(202).json({ status: 'accepted' });
          return;
        }

        // Handle requests - send to MCP server via onmessage
        // Wait for response via Promise
        if (this.onmessage) {
          // MCP capability-probe methods that always return "Method not found" — log silently
          const SILENT_PROBES = new Set([
            'resources/templates/list',
            'resources/list',
            'prompts/list',
            'logging/setLevel',
            'completion/complete',
          ]);
          const isSilentProbe = SILENT_PROBES.has(request.method);

          // Log incoming request (skip silent probes)
          const toolName = (request as any).params?.name || request.method;
          const args = (request as any).params?.arguments;
          const argsSummary = args ? ` (${Object.keys(args).join(', ')})` : '';
          // Short request ID tag for disambiguating concurrent requests in the log
          const reqId = String(request.id).slice(-4);
          const tag = `[${reqId}]`;
          if (!isSilentProbe) {
            process.stdout.write(`\n→ ${tag} ${toolName}${argsSummary}\n`);
          }

          const responsePromise = new Promise<JSONRPCMessage>((resolve, reject) => {
            // Use a unique internal key so concurrent requests from different clients
            // with identical JSON-RPC ids (e.g. both sending id=1) never collide.
            // We swap the request.id to this unique key before handing it to the MCP
            // server, so the response comes back with the same unique key and we can
            // route it back to the correct resolver. The original client id is restored
            // in the response before it is sent to the HTTP client.
            internalId = `__t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const originalId = request.id;
            (request as any).id = internalId;

            const timeoutId = setTimeout(() => {
              if (this.pendingRequests.has(internalId!)) {
                this.pendingRequests.delete(internalId!);
                (request as any).id = originalId; // restore on timeout
                process.stderr.write(`← ${tag} ⏱️ ${toolName} timed out after ${TOOL_TIMEOUT_MS / 1000}s\n`);
                reject(new Error(`Request timeout: ${toolName} did not complete within ${TOOL_TIMEOUT_MS / 1000}s`));
              }
            }, TOOL_TIMEOUT_MS);

            this.pendingRequests.set(internalId, (message) => {
              clearTimeout(timeoutId);
              // Restore the original client id before resolving
              if ('id' in message) (message as any).id = originalId;
              resolve(message);
            });
          });

          // Send request to MCP server and await response — both inside the
          // per-request AsyncLocalStorage context so tool handlers see the correct
          // workspacePath for this specific user's request.
          const response = await getConfigManager().runWithRequestContext(requestCtx, async () => {
            this.onmessage!(request);
            return await responsePromise;
          });
          
          // In HTTP mode the server cannot push notifications before a response
          // (request-response only — no SSE). As a workaround we prepend the same
          // progress description as the first line of the tool result so the user
          // can see what was processed when expanding the "ran <tool>" detail in VS2026.
          if (!isSilentProbe && 'result' in response) {
            const progressText = buildProgressMessage(toolName, args);
            const resultContent = (response as any).result?.content;
            if (Array.isArray(resultContent) && resultContent.length > 0) {
              const first = resultContent[0];
              if (first?.type === 'text' && typeof first.text === 'string') {
                first.text = `${progressText}\n\n${first.text}`;
              }
            }
          }

          // Log response (skip silent probes)
          if (!isSilentProbe) {
            if ('result' in response) {
              const content = (response as any).result?.content?.[0]?.text;
              const isError = (response as any).result?.isError === true;
              if (content) {
                const lines = content.split('\n').filter((l: string) => l.trim());
                if (isError) {
                  // For errors show up to 4 lines so type-mismatch hints are visible
                  const preview = lines.slice(0, 4).map((l: string) => l.substring(0, 100)).join(' | ');
                  process.stdout.write(`← ${tag} ❌ ${preview}\n`);
                } else {
                  const firstLine = lines[0].substring(0, 100);
                  // For file-creation tools also append the path/warning line so it's visible
                  const extraLine = lines.find((l: string) =>
                    l.startsWith('📁 Path:') || l.startsWith('⚠️ addToProject'));
                  const extra = extraLine ? ` | ${extraLine.substring(0, 100)}` : '';
                  process.stdout.write(`← ${tag} ${firstLine}${extra}\n`);
                }
              } else {
                process.stdout.write(`← ${tag} ✓ Success\n`);
              }
            } else if ('error' in response) {
              const errorMsg = (response as any).error?.message || 'Unknown error';
              process.stdout.write(`← ${tag} ❌ ${errorMsg.substring(0, 100)}\n`);
            }
          }
          
          // Send JSON response and explicitly close to signal completion
          res.status(200)
            .setHeader('Content-Type', 'application/json')
            .send(JSON.stringify(response))
            .end();
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`← Transport error: ${errorMsg}\n`);
        
        // Clean up the pending request using internalId (the Map key after the id swap)
        if (internalId) {
          this.pendingRequests.delete(internalId);
        }
        
        if (!res.headersSent) {
          // Use request.id (restored to originalId by the timeout handler) so
          // the client can correlate this error with the original request.
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal error',
            },
            id: request.id ?? null,
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

