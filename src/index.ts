/**
 * X++ MCP Code Completion Server
 * Main entry point
 */

import 'dotenv/config';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createXppMcpServer } from './server/mcpServer.js';
import { createStreamableHttpTransport } from './server/transport.js';
import { XppSymbolIndex } from './metadata/symbolIndex.js';
import { XppMetadataParser } from './metadata/xmlParser.js';
import { RedisCacheService } from './cache/redisCache.js';
import { downloadDatabaseFromBlob } from './database/download.js';
import * as fs from 'fs/promises';

const PORT = parseInt(process.env.PORT || '8080');
const DB_PATH = process.env.DB_PATH || './data/xpp-metadata.db';
const METADATA_PATH = process.env.METADATA_PATH || './metadata';

// Detect if running in stdio mode (launched by MCP client)
const isStdioMode = !process.stdin.isTTY;

async function main() {
  console.error('🚀 Starting X++ MCP Code Completion Server...');
  console.error(`📡 Mode: ${isStdioMode ? 'STDIO' : 'HTTP'}`);

  // Initialize cache service
  console.error('💾 Initializing cache service...');
  const cache = new RedisCacheService();
  
  // Wait for Redis connection
  const isConnected = await cache.waitForConnection();
  if (isConnected) {
    const stats = await cache.getStats();
    console.error(`✅ Redis cache enabled (${stats.keyCount || 0} keys, ${stats.memory || 'unknown'} memory)`);
  } else {
    console.error('⚠️  Redis cache disabled - running without cache');
  }

  // Download database from blob storage if configured
  if (process.env.AZURE_STORAGE_CONNECTION_STRING && process.env.BLOB_CONTAINER_NAME) {
    try {
      await downloadDatabaseFromBlob();
    } catch (error) {
      console.error('⚠️  Failed to download database from blob storage:', error);
      console.error('   Attempting to use existing local database...');
    }
  }

  // Initialize symbol index and parser
  console.error(`📚 Loading metadata from: ${DB_PATH}`);
  const symbolIndex = new XppSymbolIndex(DB_PATH);
  const parser = new XppMetadataParser();
  
  // Check if database needs indexing
  const symbolCount = symbolIndex.getSymbolCount();
  if (symbolCount === 0) {
    console.error('⚠️  No symbols found in database. Run indexing first:');
    console.error('   npm run index-metadata');
    console.error('   or set METADATA_PATH and the server will index on startup');
    
    // If metadata path exists, index it
    try {
      await fs.access(METADATA_PATH);
      console.error(`📖 Indexing metadata from: ${METADATA_PATH}`);
      const modelNamesStr = process.env.CUSTOM_MODELS || 'CustomModel';
      const modelNames = modelNamesStr.split(',').map(m => m.trim()).filter(Boolean);
      console.error(`📦 Using model names: ${modelNames.join(', ')}`);
      
      for (const modelName of modelNames) {
        console.error(`   Indexing ${modelName}...`);
        await symbolIndex.indexMetadataDirectory(METADATA_PATH, modelName);
      }
      
      console.error(`✅ Indexed ${symbolIndex.getSymbolCount()} symbols from ${modelNames.length} model(s)`);
    } catch (error) {
      console.error('⚠️  Metadata path not accessible, starting with empty index');
    }
  } else {
    console.error(`✅ Loaded ${symbolCount} symbols from database`);
  }

  // Create MCP server with symbol index, parser, and cache
  const mcpServer = createXppMcpServer({ symbolIndex, parser, cache });
  console.error('✅ MCP Server initialized');

  if (isStdioMode) {
    // Use stdio transport for MCP client integration (VS Code, Visual Studio, etc.)
    console.error('📡 Using stdio transport for MCP client');
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error('✅ Stdio transport connected');
    console.error('🎯 Registered 10 X++ MCP tools (6 basic + 4 intelligent)');
  } else {
    // Use HTTP transport for standalone server mode
    console.error('📡 Using HTTP transport for standalone server');
    
    // Create Express app with transport
    const app = express();
    
    // Trust proxy - required for Azure App Service (behind reverse proxy)
    app.set('trust proxy', 1);
    
    app.use(express.json());

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'd365fo-mcp-server',
        version: '1.0.0',
        symbols: symbolIndex.getSymbolCount(),
      });
    });

    // MCP endpoints
    createStreamableHttpTransport(mcpServer, app, { symbolIndex, parser, cache });

    // Start server on 0.0.0.0 for Azure App Service
    const host = process.env.HOST || '0.0.0.0';
    app.listen(PORT, host, () => {
      console.error(`āś… D365 F&O MCP Server listening on ${host}:${PORT}`);
      console.error(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
      console.error(`🏥 Health check: http://localhost:${PORT}/health`);
      console.error('');
      console.error('🎯 Available tools:');
      console.error('   Basic Discovery:');
      console.error('   - search: Search for X++ classes, tables, methods, and fields');
      console.error('   - search_extensions: Search for symbols in custom extensions/ISV models');
      console.error('   - get_class_info: Get detailed class information');
      console.error('   - get_table_info: Get detailed table information');
      console.error('   - code_completion: Get method and field completions (IntelliSense)');
      console.error('   - generate_code: Generate X++ code templates');
      console.error('');
      console.error('   🧠 Intelligent Code Generation:');
      console.error('   - analyze_code_patterns: Analyze codebase for similar patterns');
      console.error('   - suggest_method_implementation: Get implementation examples from codebase');
      console.error('   - analyze_class_completeness: Find missing methods in classes');
      console.error('   - get_api_usage_patterns: See how APIs are used in codebase');
    });
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
