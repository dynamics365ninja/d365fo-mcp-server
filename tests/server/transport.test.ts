import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createStreamableHttpTransport } from '../../src/server/transport';
import { registerToolHandler } from '../../src/tools/toolHandler';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { RedisCacheService } from '../../src/cache/redisCache';
import supertest from 'supertest';

describe('MCP Server Transport', () => {
  let app: express.Express;
  let server: any;
  let request: ReturnType<typeof supertest>;
  let mockContext: XppServerContext;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    const mcpServer = new Server(
      {
        name: 'd365fo-mcp-server-test',
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

    const mockSymbolIndex: Partial<XppSymbolIndex> = {
      searchSymbols: (query: string, limit?: number) => [
        {
          id: 1,
          name: 'TestClass',
          type: 'class',
          parentName: undefined,
          signature: undefined,
          filePath: '/test.xml',
          model: 'TestModel',
        },
      ],
      getSymbolByName: () => null,
      getClassMethods: () => [],
      getTableFields: () => [],
      getSymbolCount: () => 1,
      close: () => {},
    };

    const mockCache: Partial<RedisCacheService> = {
      get: async () => null,
      getFuzzy: async () => null,
      set: async () => {},
      generateSearchKey: () => 'test-key',
    };

    mockContext = {
      symbolIndex: mockSymbolIndex as XppSymbolIndex,
      cache: mockCache as RedisCacheService,
      parser: {} as any,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      termRelationshipGraph: {} as any,
    };

    // Register tool handler
    registerToolHandler(mcpServer, mockContext);

    // Add health endpoint like in main app
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'd365fo-mcp-server-test',
        version: '1.0.0',
        symbols: mockContext.symbolIndex.getSymbolCount(),
      });
    });

    createStreamableHttpTransport(mcpServer, app, mockContext);

    server = app.listen(3001);
    request = supertest(app);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('should handle initialize request', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      })
      .expect(200);

    expect(response.body.result).toBeDefined();
    expect(response.body.result.protocolVersion).toBe('2025-06-18');
    expect(response.body.result.serverInfo.name).toBe('d365fo-mcp-server-test');
  });

  it('should handle tools/list request', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })
      .expect(200);

    expect(response.body.result).toBeDefined();
    expect(response.body.result.tools).toBeDefined();
    expect(Array.isArray(response.body.result.tools)).toBe(true);
    expect(response.body.result.tools.length).toBeGreaterThan(0);
  });

  it('should handle tools/call request', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: 'test' },
        },
      })
      .expect(200);

    // Debug output
    if (!response.body.result) {
      console.log('Response body:', JSON.stringify(response.body, null, 2));
    }

    expect(response.body.result).toBeDefined();
    expect(response.body.result.content).toBeDefined();
  });

  it('should handle notifications/initialized', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })
      .expect(202); // Notifications return 202 Accepted

    expect(response.body.status).toBe('accepted');
  });

  it('should handle ping request', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'ping',
        params: {},
      })
      .expect(200);

    expect(response.body.result).toBeDefined();
  });

  it('should handle resources/templates/list request', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/templates/list',
        params: {},
      })
      .expect(200);

    expect(response.body.result).toBeDefined();
    expect(response.body.result.resourceTemplates).toBeDefined();
  });

  it('should handle invalid method', async () => {
    const response = await request
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 6,
        method: 'invalid/method',
        params: {},
      })
      .expect(500);

    expect(response.body.error).toBeDefined();
  });

  it('should respond to health endpoint', async () => {
    const response = await request.get('/health').expect(200);

    expect(response.body.status).toBe('healthy');
    expect(response.body.symbols).toBe(1);
  });
});
