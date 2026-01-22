/**
 * X++ MCP Code Completion Server
 * Main entry point
 */

import 'dotenv/config';
import express from 'express';
import { createXppMcpServer } from './server/mcpServer.js';
import { createStreamableHttpTransport } from './server/transport.js';
import { XppSymbolIndex } from './metadata/symbolIndex.js';
import { XppMetadataParser } from './metadata/xmlParser.js';
import { RedisCacheService } from './cache/redisCache.js';

const PORT = parseInt(process.env.PORT || '8080');
const DB_PATH = process.env.DB_PATH || './data/xpp-metadata.db';
const METADATA_PATH = process.env.METADATA_PATH || './metadata';

async function main() {
  console.log('🚀 Starting X++ MCP Code Completion Server...');

  // Initialize cache service
  console.log('💾 Initializing cache service...');
  const cache = new RedisCacheService();
  if (cache.isEnabled()) {
    const stats = await cache.getStats();
    console.log(`✅ Redis cache enabled (${stats.keyCount || 0} keys, ${stats.memory || 'unknown'} memory)`);
  } else {
    console.log('⚠️  Redis cache disabled - running without cache');
  }

  // Initialize symbol index and parser
  console.log(`📚 Loading metadata from: ${DB_PATH}`);
  const symbolIndex = new XppSymbolIndex(DB_PATH);
  const parser = new XppMetadataParser();
  
  // Check if database needs indexing
  const symbolCount = symbolIndex.getSymbolCount();
  if (symbolCount === 0) {
    console.log('⚠️  No symbols found in database. Run indexing first:');
    console.log('   npm run index-metadata');
    console.log('   or set METADATA_PATH and the server will index on startup');
    
    // If metadata path exists, index it
    const fs = await import('fs/promises');
    try {
      await fs.access(METADATA_PATH);
      console.log(`📖 Indexing metadata from: ${METADATA_PATH}`);
      const modelNamesStr = process.env.MODEL_NAMES || process.env.MODEL_NAME || 'CustomModel';
      const separator = process.env.MODEL_NAMES_SEPARATOR || ',';
      const modelNames = modelNamesStr.split(separator).map(m => m.trim()).filter(Boolean);
      console.log(`📦 Using model names: ${modelNames.join(', ')}`);
      
      for (const modelName of modelNames) {
        console.log(`   Indexing ${modelName}...`);
        await symbolIndex.indexMetadataDirectory(METADATA_PATH, modelName);
      }
      
      console.log(`✅ Indexed ${symbolIndex.getSymbolCount()} symbols from ${modelNames.length} model(s)`);
    } catch (error) {
      console.warn('⚠️  Metadata path not accessible, starting with empty index');
    }
  } else {
    console.log(`✅ Loaded ${symbolCount} symbols from database`);
  }

  // Create MCP server with symbol index, parser, and cache
  const mcpServer = createXppMcpServer({ symbolIndex, parser, cache });
  console.log('✅ MCP Server initialized');

  // Create Express app with transport
  const app = express();
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
  createStreamableHttpTransport(mcpServer, app);

  // Start server on 0.0.0.0 for Azure App Service
  const host = process.env.HOST || '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`✅ D365 F&O MCP Server listening on ${host}:${PORT}`);
    console.log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log('');
    console.log('🎯 Available tools:');
    console.log('   - xpp_search: Search for X++ symbols');
    console.log('   - xpp_get_class: Get class details');
    console.log('   - xpp_get_table: Get table details');
    console.log('   - xpp_complete_method: Get method completions');
    console.log('   - xpp_generate_code: Generate X++ code templates');
  });
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
