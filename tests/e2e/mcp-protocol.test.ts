/**
 * MCP Protocol End-to-End Tests
 * Tests complete user workflows with real MCP protocol communication
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createStreamableHttpTransport } from '../../src/server/transport';
import { registerToolHandler } from '../../src/tools/toolHandler';
import type { XppServerContext } from '../../src/types/context';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { RedisCacheService } from '../../src/cache/redisCache';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import supertest from 'supertest';
import path from 'path';

describe('MCP Protocol E2E Tests', () => {
  let app: express.Express;
  let server: any;
  let request: ReturnType<typeof supertest>;
  let context: XppServerContext;
  let symbolIndex: XppSymbolIndex;
  let hasData = false;

  beforeAll(async () => {
    // Use real DB if available, otherwise fall back to an empty in-memory-like DB
    // so the server still starts and structural tests can run (data tests skip).
    const dbPath = path.join(process.cwd(), 'data', 'xpp-metadata.db');
    const labelsDbPath = path.join(process.cwd(), 'data', 'xpp-metadata-labels.db');

    // Initialize real components (XppSymbolIndex creates an empty DB if file doesn't exist)
    symbolIndex = new XppSymbolIndex(dbPath, labelsDbPath);
    const cache = new RedisCacheService(); // Disable Redis for e2e tests
    const parser = new XppMetadataParser();

    context = {
      symbolIndex,
      cache,
      parser,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      termRelationshipGraph: {} as any,
    };

    // Create Express app
    app = express();
    app.use(express.json());

    // Create MCP server
    const mcpServer = new Server(
      {
        name: 'd365fo-mcp-server-e2e-test',
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

    // Register tools
    registerToolHandler(mcpServer, context);

    // Health endpoint
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'd365fo-mcp-server-e2e-test',
        version: '1.0.0',
        symbols: symbolIndex.getSymbolCount(),
      });
    });

    // Add MCP transport
    createStreamableHttpTransport(mcpServer, app, context);

    // Check if the database actually has data
    hasData = symbolIndex.getSymbolCount() > 0;

    // Start server
    server = app.listen(3002);
    request = supertest(app);

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll((done) => {
    symbolIndex.close();
    server.close(done);
  });

  describe('MCP Protocol Basics', () => {
    it('should initialize MCP connection', async () => {
      const response = await request
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'github-copilot', version: '1.0.0' },
          },
        })
        .expect(200);

      expect(response.body.result).toBeDefined();
      expect(response.body.result.protocolVersion).toBe('2025-06-18');
      expect(response.body.result.serverInfo.name).toBe('d365fo-mcp-server-e2e-test');
      expect(response.body.result.capabilities).toBeDefined();
    });

    it('should handle health check', async (ctx) => {
      if (!hasData) ctx.skip();
      const response = await request.get('/health').expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.symbols).toBeGreaterThan(0);
    });
  });

  describe('Real-World User Scenarios', () => {
    describe('Scenario 1: Find methods on table', () => {
      it('should search for CustTable and return results', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 100,
            method: 'tools/call',
            params: {
              name: 'search',
              arguments: {
                query: 'CustTable',
                type: 'table',
                limit: 5,
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        expect(response.body.result.content).toHaveLength(1);
        expect(response.body.result.content[0].type).toBe('text');
        expect(response.body.result.content[0].text).toContain('CustTable');
      });

      it('should get table info with fields and methods', async (ctx) => {
        if (!hasData) ctx.skip();
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 101,
            method: 'tools/call',
            params: {
              name: 'get_table_info',
              arguments: {
                tableName: 'CustTable',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('CustTable');
        expect(text).toContain('Field'); // Should show fields
      });
    });

    describe('Scenario 2: Search and analyze class', () => {
      it('should search for SalesTable class', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 200,
            method: 'tools/call',
            params: {
              name: 'search',
              arguments: {
                query: 'SalesFormLetter',
                type: 'class',
                limit: 5,
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('SalesFormLetter');
      });

      it('should get class info with methods', async (ctx) => {
        if (!hasData) ctx.skip();
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 201,
            method: 'tools/call',
            params: {
              name: 'get_class_info',
              arguments: {
                className: 'SalesFormLetter',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('SalesFormLetter');
        expect(text).toContain('Method'); // Should show methods
      });
    });

    describe('Scenario 2b: Get EDT info over MCP', () => {
      it('should call get_edt_info and return core EDT properties', async (ctx) => {
        if (!hasData) ctx.skip();

        const edtRow = symbolIndex.db
          .prepare(`SELECT name, model FROM symbols WHERE type = 'edt' ORDER BY model, name LIMIT 1`)
          .get() as { name: string; model: string } | undefined;

        if (!edtRow) {
          ctx.skip();
          return;
        }

        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 250,
            method: 'tools/call',
            params: {
              name: 'get_edt_info',
              arguments: {
                edtName: edtRow.name,
                modelName: edtRow.model,
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('# Extended Data Type:');
        expect(text).toContain(`**Model:** ${edtRow.model}`);
        expect(text).toContain('## 🔧 Core Properties');
        expect(text).toContain('| Property | Value |');
      });
    });

    describe('Scenario 3: Code generation workflow', () => {
      it('should generate class code', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 300,
            method: 'tools/call',
            params: {
              name: 'generate_code',
              arguments: {
                pattern: 'class',
                name: 'MyTestHelper',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('MyTestHelper');
        expect(text).toContain('class');
        expect(text).toContain('```xpp');
      });

      it('should generate batch job code', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 301,
            method: 'tools/call',
            params: {
              name: 'generate_code',
              arguments: {
                pattern: 'batch-job',
                name: 'ProcessOrdersBatch',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('ProcessOrdersBatch');
        expect(text).toContain('batch');
      });
    });

    describe('Scenario 4: Multi-step workflow - CoC extension', () => {
      it('Step 1: Search for base class', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 400,
            method: 'tools/call',
            params: {
              name: 'search',
              arguments: {
                query: 'SalesFormLetter',
                type: 'class',
              },
            },
          })
          .expect(200);

        expect(response.body.result.content[0].text).toContain('SalesFormLetter');
      });

      it('Step 2: Get method signature', async (ctx) => {
        if (!hasData) ctx.skip();
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 401,
            method: 'tools/call',
            params: {
              name: 'get_method_signature',
              arguments: {
                className: 'SalesFormLetter',
                methodName: 'run',
              },
            },
          })
          .expect(200);

        const text = response.body.result.content[0].text;
        expect(text).toContain('run');
        expect(text).toContain('void');
      });

      it('Step 3: Generate extension class', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 402,
            method: 'tools/call',
            params: {
              name: 'generate_code',
              arguments: {
                pattern: 'class',
                name: 'SalesFormLetter_Extension',
              },
            },
          })
          .expect(200);

        const text = response.body.result.content[0].text;
        expect(text).toContain('SalesFormLetter_Extension');
        expect(text).toContain('class');
      });
    });

    describe('Scenario 5: Intelligent pattern analysis', () => {
      it('should analyze code patterns for scenario', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 500,
            method: 'tools/call',
            params: {
              name: 'analyze_code_patterns',
              arguments: {
                scenario: 'ledger journal creation',
                limit: 10,
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('Pattern Analysis');
      });

      it('should suggest method implementation', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 501,
            method: 'tools/call',
            params: {
              name: 'suggest_method_implementation',
              arguments: {
                className: 'MyHelper',
                methodName: 'validate',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('validate');
      });
    });

    describe('Scenario 6: Label management workflow', () => {
      it('should search for existing labels', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 600,
            method: 'tools/call',
            params: {
              name: 'search_labels',
              arguments: {
                query: 'customer',
                language: 'en-US',
                limit: 5,
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('label');
      });

      it('should get label info with all translations', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 601,
            method: 'tools/call',
            params: {
              name: 'get_label_info',
              arguments: {
                labelId: 'Customer',
                model: 'ApplicationSuite',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
      });
    });

    describe('Scenario 7: Find references workflow', () => {
      it('should find where CustTable is used', async () => {
        const response = await request
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 700,
            method: 'tools/call',
            params: {
              name: 'find_references',
              arguments: {
                targetName: 'CustTable',
                targetType: 'table',
              },
            },
          })
          .expect(200);

        expect(response.body.result).toBeDefined();
        const text = response.body.result.content[0].text;
        expect(text).toContain('reference');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid tool name', async () => {
      const response = await request
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 800,
          method: 'tools/call',
          params: {
            name: 'invalid_tool_name',
            arguments: {},
          },
        })
        .expect(200);

      // Server returns error message in result.content
      expect(response.body.result).toBeDefined();
      expect(response.body.result.content).toBeDefined();
      const text = response.body.result.content[0].text;
      expect(text).toContain('Unknown tool');
    });

    it('should handle missing required parameters', async () => {
      const response = await request
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 801,
          method: 'tools/call',
          params: {
            name: 'search',
            arguments: {}, // Missing 'query'
          },
        })
        .expect(200);

      expect(response.body.error || response.body.result.isError).toBeTruthy();
    });

    it('should handle non-existent class', async () => {
      const response = await request
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 802,
          method: 'tools/call',
          params: {
            name: 'get_class_info',
            arguments: {
              className: 'NonExistentClass12345',
            },
          },
        })
        .expect(200);

      expect(response.body.result).toBeDefined();
      const text = response.body.result.content[0].text;
      expect(text).toContain('not found');
    });
  });

  describe('Performance Tests', () => {
    it('should handle search within 2 seconds', async () => {
      const start = Date.now();
      
      await request
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 900,
          method: 'tools/call',
          params: {
            name: 'search',
            arguments: {
              query: 'Sales',
              limit: 20,
            },
          },
        })
        .expect(200);

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(2000);
    });

    it('should handle batch search efficiently', async () => {
      const start = Date.now();
      
      await request
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 901,
          method: 'tools/call',
          params: {
            name: 'batch_search',
            arguments: {
              queries: [
                { query: 'CustTable', type: 'table' },
                { query: 'VendTable', type: 'table' },
                { query: 'SalesTable', type: 'table' },
              ],
            },
          },
        })
        .expect(200);

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(3000);
    });
  });
});
