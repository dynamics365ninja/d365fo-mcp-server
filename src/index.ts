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
import { WorkspaceScanner } from './workspace/workspaceScanner.js';
import { HybridSearch } from './workspace/hybridSearch.js';
import { downloadDatabaseFromBlob } from './database/download.js';
import * as fs from 'fs/promises';

const PORT = parseInt(process.env.PORT || '8080');
const DB_PATH = process.env.DB_PATH || './data/xpp-metadata.db';
const METADATA_PATH = process.env.METADATA_PATH || './metadata';

// Detect if running in stdio mode (launched by MCP client)
// Force HTTP mode in Azure (when PORT or WEBSITES_PORT env var is set)
const isStdioMode = !process.env.PORT && !process.env.WEBSITES_PORT && !process.stdin.isTTY;

// Readiness state tracking
interface ServerState {
  isReady: boolean;
  isHealthy: boolean;
  statusMessage: string;
  symbolIndex?: XppSymbolIndex;
  parser?: XppMetadataParser;
  cache?: RedisCacheService;
}

const serverState: ServerState = {
  isReady: false,
  isHealthy: false,
  statusMessage: 'Starting...',
};

async function initializeServices() {
  console.log('🚀 Starting X++ MCP Code Completion Server...');

  try {
    // Initialize cache service
    console.log('💾 Initializing cache service...');
    serverState.statusMessage = 'Connecting to Redis...';
    const cache = new RedisCacheService();
    
    // Wait for Redis connection
    const isConnected = await cache.waitForConnection();
    if (isConnected) {
      const stats = await cache.getStats();
      console.log(`✅ Redis cache enabled (${stats.keyCount || 0} keys, ${stats.memory || 'unknown'} memory)`);
    } else {
      console.log('⚠️  Redis cache disabled - running without cache');
    }
    serverState.cache = cache;

    // Download database from blob storage if configured
    if (process.env.AZURE_STORAGE_CONNECTION_STRING && process.env.BLOB_CONTAINER_NAME) {
      try {
        serverState.statusMessage = 'Downloading database from Azure Blob Storage...';
        await downloadDatabaseFromBlob();
      } catch (error) {
        console.error('⚠️  Failed to download database from blob storage:', error);
        console.log('   Will attempt to use existing local database...');
        
        // If download failed, check if local database exists and is valid
        try {
          await fs.access(DB_PATH);
          console.log('   ℹ️  Local database file exists, will attempt to use it');
        } catch {
          console.log('   ⚠️  No local database available - server will start with empty index');
        }
      }
    }

    // Initialize symbol index and parser
    console.log(`📚 Loading metadata from: ${DB_PATH}`);
    serverState.statusMessage = 'Loading metadata database...';
    
    let symbolIndex: XppSymbolIndex;
    let symbolCount = 0;
    
    try {
      symbolIndex = new XppSymbolIndex(DB_PATH);
      symbolCount = symbolIndex.getSymbolCount();
    } catch (error: any) {
      console.error('❌ Failed to open database:', error);
      
      // If database is corrupted, delete it and create new empty one
      if (error.code === 'SQLITE_CORRUPT' || error.message?.includes('malformed')) {
        console.log('   🧹 Database is corrupted, removing and creating fresh database...');
        try {
          await fs.unlink(DB_PATH);
          console.log('   ✅ Corrupted database removed');
        } catch (unlinkError) {
          console.error('   ⚠️  Failed to remove corrupted database:', unlinkError);
        }
        
        // Try again with fresh database
        symbolIndex = new XppSymbolIndex(DB_PATH);
        symbolCount = symbolIndex.getSymbolCount();
      } else {
        throw error;
      }
    }
    
    const parser = new XppMetadataParser();
    
    // Check if database needs indexing
    if (symbolCount === 0) {
      console.log('⚠️  No symbols found in database. Run indexing first:');
      console.log('   npm run index-metadata');
      console.log('   or set METADATA_PATH and the server will index on startup');
      
      // If metadata path exists, index it
      try {
        await fs.access(METADATA_PATH);
        console.log(`📖 Indexing metadata from: ${METADATA_PATH}`);
        serverState.statusMessage = 'Indexing metadata...';
        const modelNamesStr = process.env.CUSTOM_MODELS || 'CustomModel';
        const modelNames = modelNamesStr.split(',').map(m => m.trim()).filter(Boolean);
        console.log(`📦 Using model names: ${modelNames.join(', ')}`);
        
        for (const modelName of modelNames) {
          console.log(`   Indexing ${modelName}...`);
          await symbolIndex.indexMetadataDirectory(METADATA_PATH, modelName);
        }
        
        console.log(`✅ Indexed ${symbolIndex.getSymbolCount()} symbols from ${modelNames.length} model(s)`);
      } catch (error) {
        console.log('⚠️  Metadata path not accessible, starting with empty index');
      }
    } else {
      console.log(`✅ Loaded ${symbolCount} symbols from database`);
    }

    serverState.symbolIndex = symbolIndex;
    serverState.parser = parser;

    // Initialize workspace scanner and hybrid search
    console.log('🔍 Initializing workspace scanner...');
    const workspaceScanner = new WorkspaceScanner();
    const hybridSearch = new HybridSearch(symbolIndex, workspaceScanner);
    console.log('✅ Workspace-aware search enabled');

    // Initialize term relationship graph for search suggestions
    console.log('🔗 Building term relationship graph...');
    const { TermRelationshipGraph } = await import('./utils/suggestionEngine.js');
    const termRelationshipGraph = new TermRelationshipGraph();
    const symbolsForAnalysis = symbolIndex.getAllSymbolsForAnalysis();
    termRelationshipGraph.build(symbolsForAnalysis);
    console.log('✅ Term relationship graph built for intelligent suggestions');

    // Create MCP server with full context
    serverState.statusMessage = 'Initializing MCP server...';
    const mcpServer = createXppMcpServer({ 
      symbolIndex, 
      parser, 
      cache, 
      workspaceScanner, 
      hybridSearch,
      termRelationshipGraph
    });
    console.log('✅ MCP Server initialized with workspace support');

    return { mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph };
  } catch (error) {
    console.error('❌ Initialization error:', error);
    serverState.statusMessage = `Initialization failed: ${error}`;
    throw error;
  }
}

async function main() {
  console.log(`📡 Mode: ${isStdioMode ? 'STDIO' : 'HTTP'}`);

  if (isStdioMode) {
    // STDIO mode - initialize synchronously before connecting
    const { mcpServer } = await initializeServices();
    console.log('📡 Using stdio transport for MCP client');
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.log('✅ Stdio transport connected');
    console.log('🎯 Registered 10 X++ MCP tools (6 basic + 4 intelligent)');
    serverState.isReady = true;
    serverState.isHealthy = true;
    serverState.statusMessage = 'Ready';
  } else {
    // HTTP mode - start server immediately, initialize asynchronously
    console.log('📡 Using HTTP transport for standalone server');
    
    // Create Express app immediately
    const app = express();
    
    // Trust proxy - required for Azure App Service (behind reverse proxy)
    app.set('trust proxy', 1);
    
    app.use(express.json());

    // Health check endpoint - responds immediately with current state
    app.get('/health', (_req, res) => {
      if (!serverState.isReady) {
        // Server is starting - return 503 Service Unavailable
        return res.status(503).json({
          status: 'starting',
          ready: false,
          service: 'd365fo-mcp-server',
          version: '1.0.0',
          message: serverState.statusMessage,
        });
      }

      // Server is ready - return 200 OK
      return res.json({
        status: 'healthy',
        ready: true,
        service: 'd365fo-mcp-server',
        version: '1.0.0',
        symbols: serverState.symbolIndex?.getSymbolCount() || 0,
      });
    });

    // Start server on 0.0.0.0 for Azure App Service
    const host = process.env.HOST || '0.0.0.0';
    app.listen(PORT, host, () => {
      console.log(`✅ D365 F&O MCP Server listening on ${host}:${PORT}`);
      console.log(`🏥 Health check: http://localhost:${PORT}/health`);
      console.log('⏳ Initializing services asynchronously...');
    });

    // Initialize services asynchronously after server is running
    initializeServices()
      .then(({ mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph }) => {
        // MCP endpoints - register after initialization
        createStreamableHttpTransport(mcpServer, app, { symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph });
        
        serverState.isReady = true;
        serverState.isHealthy = true;
        serverState.statusMessage = 'Ready';
        
        console.log('');
        console.log('✅ Server is READY!');
        console.log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
        console.log('');
        console.log('🎯 Available tools:');
        console.log('   Basic Discovery:');
        console.log('   - search: Search for X++ classes, tables, methods, and fields');
        console.log('   - search_extensions: Search for symbols in custom extensions/ISV models');
        console.log('   - get_class_info: Get detailed class information');
        console.log('   - get_table_info: Get detailed table information');
        console.log('   - code_completion: Get method and field completions (IntelliSense)');
        console.log('   - generate_code: Generate X++ code templates');
        console.log('');
        console.log('   🧠 Intelligent Code Generation:');
        console.log('   - analyze_code_patterns: Analyze codebase for similar patterns');
        console.log('   - suggest_method_implementation: Get implementation examples from codebase');
        console.log('   - analyze_class_completeness: Find missing methods in classes');
        console.log('   - get_api_usage_patterns: See how APIs are used in codebase');
      })
      .catch((error) => {
        console.error('❌ Failed to initialize services:', error);
        serverState.isReady = false;
        serverState.isHealthy = false;
        serverState.statusMessage = `Initialization failed: ${error.message}`;
        // Don't exit - keep server running for health check visibility
      });
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
