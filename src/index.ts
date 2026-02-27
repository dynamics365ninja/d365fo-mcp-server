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
import { initializeDatabase } from './database/download.js';
import { initializeConfig } from './utils/configManager.js';
import { SERVER_MODE, WRITE_TOOLS } from './server/serverMode.js';
import * as fs from 'fs/promises';

// Filter debug logs unless DEBUG_LOGGING is enabled
const originalConsoleError = console.error;
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';
console.error = (...args: any[]) => {
  if (DEBUG_LOGGING) {
    originalConsoleError(...args);
    return;
  }
  // Only log actual errors, not debug info from tool handlers
  const firstArg = String(args[0]);
  if (firstArg.includes('[create_d365fo_file]') || 
      firstArg.includes('[generate_d365fo_xml]') ||
      firstArg.includes('[ProjectFileManager]')) {
    // Skip debug logs from tool handlers unless it's an actual error
    if (firstArg.includes('Failed') || 
        firstArg.includes('Error') || 
        firstArg.includes('❌') ||
        firstArg.includes('⚠️  Redis')) {
      originalConsoleError(...args);
    }
    return;
  }
  originalConsoleError(...args);
};

const PORT = parseInt(process.env.PORT || '8080');
const DB_PATH = process.env.DB_PATH || './data/xpp-metadata.db';
const LABELS_DB_PATH = process.env.LABELS_DB_PATH || './data/xpp-metadata-labels.db';
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
  console.log(`🔧 Server mode: ${SERVER_MODE} (from env: ${process.env.MCP_SERVER_MODE || 'not set, defaulting to full'})`);

  // -----------------------------------------------------------------------
  // write-only mode: skip all database/symbol work — file-operation tools
  // (create_d365fo_file, modify_d365fo_file, create_label) only need the
  // config manager for path resolution, not the 1.5 GB symbol database.
  // -----------------------------------------------------------------------
  if (SERVER_MODE === 'write-only') {
    console.log('✏️  Mode: write-only (local file-operations companion)');
    console.log('⏭️  Skipping database download and symbol index — not needed in write-only mode');

    console.log('⚙️  Loading .mcp.json configuration...');
    const config = await initializeConfig();
    if (config?.servers.context) {
      console.log('✅ Configuration loaded from .mcp.json');
      if (config.servers.context.workspacePath) {
        console.log(`   Workspace path: ${config.servers.context.workspacePath}`);
      }
    } else {
      console.log('ℹ️  No .mcp.json configuration found, using defaults');
    }

    const cache = new RedisCacheService();
    // Don't wait for Redis in write-only mode — it's not used
    cache.waitForConnection().catch(() => {});

    const symbolIndex = new XppSymbolIndex(':memory:', ':memory:');
    const parser = new XppMetadataParser();
    const workspaceScanner = new WorkspaceScanner();
    const hybridSearch = new HybridSearch(symbolIndex, workspaceScanner);
    const { TermRelationshipGraph } = await import('./utils/suggestionEngine.js');
    const termRelationshipGraph = new TermRelationshipGraph();

    serverState.symbolIndex = symbolIndex;
    serverState.parser = parser;
    serverState.cache = cache;

    const mcpServer = createXppMcpServer({ symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph });
    console.log('✅ MCP Server initialized (write-only mode)');
    return { mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph };
  }

  // -----------------------------------------------------------------------
  // full / read-only mode: full initialization with database
  // -----------------------------------------------------------------------
  try {
    // Load .mcp.json configuration
    console.log('⚙️  Loading .mcp.json configuration...');
    const config = await initializeConfig();
    if (config && config.servers.context) {
      console.log('✅ Configuration loaded from .mcp.json');
      if (config.servers.context.workspacePath) {
        console.log(`   Workspace path: ${config.servers.context.workspacePath}`);
      }
      if (config.servers.context.packagePath) {
        console.log(`   Package path: ${config.servers.context.packagePath}`);
      }
    } else {
      console.log('ℹ️  No .mcp.json configuration found, using defaults');
    }

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

    // Download database from blob storage if configured (only if remote is newer than local)
    if (process.env.AZURE_STORAGE_CONNECTION_STRING && process.env.BLOB_CONTAINER_NAME) {
      try {
        serverState.statusMessage = 'Checking database version...';
        await initializeDatabase();
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
    console.log(`📚 Labels database: ${LABELS_DB_PATH}`);
    serverState.statusMessage = 'Loading metadata database...';
    
    let symbolIndex: XppSymbolIndex;
    let symbolCount = 0;
    
    try {
      symbolIndex = new XppSymbolIndex(DB_PATH, LABELS_DB_PATH);
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
        symbolIndex = new XppSymbolIndex(DB_PATH, LABELS_DB_PATH);
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
      const breakdown = symbolIndex.getSymbolCountByType();
      console.log('   📊 Symbol types: ' + 
        `${breakdown.class || 0} classes, ` +
        `${breakdown.table || 0} tables, ` +
        `${breakdown.form || 0} forms, ` +
        `${breakdown.query || 0} queries, ` +
        `${breakdown.view || 0} views`);
    }

    serverState.symbolIndex = symbolIndex;
    serverState.parser = parser;

    // Initialize workspace scanner and hybrid search
    console.log('🔍 Initializing workspace scanner...');
    const workspaceScanner = new WorkspaceScanner();
    const hybridSearch = new HybridSearch(symbolIndex, workspaceScanner);
    console.log('✅ Workspace-aware search enabled');

    // Initialize term relationship graph for search suggestions (lazy loading)
    // Only build if explicitly enabled or in development mode
    const enableSuggestions = process.env.ENABLE_SEARCH_SUGGESTIONS === 'true' || process.env.NODE_ENV === 'development';
    let termRelationshipGraph: any;
    
    if (enableSuggestions) {
      console.log('🔗 Building term relationship graph (lazy mode)...');
      const { TermRelationshipGraph } = await import('./utils/suggestionEngine.js');
      termRelationshipGraph = new TermRelationshipGraph();
      // Build graph asynchronously to avoid blocking startup
      setImmediate(() => {
        try {
          const symbolsForAnalysis = symbolIndex.getAllSymbolsForAnalysis();
          termRelationshipGraph.build(symbolsForAnalysis);
          console.log(`✅ Term relationship graph built (${symbolsForAnalysis.length} symbols analyzed)`);
        } catch (error) {
          console.warn('⚠️ Failed to build term relationship graph:', error);
        }
      });
    } else {
      console.log('⏭️  Search suggestions disabled (set ENABLE_SEARCH_SUGGESTIONS=true to enable)');
      const { TermRelationshipGraph } = await import('./utils/suggestionEngine.js');
      termRelationshipGraph = new TermRelationshipGraph(); // Empty graph
    }

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
  // CRITICAL: In STDIO mode, redirect all console.log to stderr
  // GitHub Copilot reads stdout for MCP protocol only!
  if (isStdioMode) {
    console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
    console.info = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
    console.warn = (...args: any[]) => process.stderr.write('[WARN] ' + args.join(' ') + '\n');
  }

  console.log(`📡 Mode: ${isStdioMode ? 'STDIO' : 'HTTP'}`);
  console.log(`🔧 Server mode: ${SERVER_MODE}`);

  if (isStdioMode) {
    // STDIO mode - initialize synchronously before connecting
    const { mcpServer } = await initializeServices();
    console.log('📡 Using stdio transport for MCP client');
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.log('✅ Stdio transport connected');
    
    // Log actual tool count based on server mode
    const totalTools = 30;
    const writeToolCount = WRITE_TOOLS.size;
    const toolCount = SERVER_MODE === 'write-only' ? writeToolCount :
                     SERVER_MODE === 'read-only' ? totalTools - writeToolCount : totalTools;
    const toolDesc = SERVER_MODE === 'write-only' ? `(${Array.from(WRITE_TOOLS).join(', ')})` :
                    SERVER_MODE === 'read-only' ? '(all except write tools)' :
                    '(8 discovery + 3 labels + 6 object-info + 4 intelligent + 3 smart-generation + 3 file-ops + 3 pattern-analysis)';
    console.log(`🎯 Registered ${toolCount} X++ MCP tools ${toolDesc}`);
    serverState.isReady = true;
    serverState.isHealthy = true;
    serverState.statusMessage = 'Ready';
  } else {
    // HTTP mode - initialize fully BEFORE opening the port.
    // VS Copilot's MCP client does not retry on 503/404, so the port must only
    // become available once the server is completely ready to handle requests.
    console.log('📡 Using HTTP transport for standalone server');

    const { mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph } =
      await initializeServices();

    // Create Express app
    const app = express();

    // Trust proxy - required for Azure App Service (behind reverse proxy)
    app.set('trust proxy', 1);

    app.use(express.json());

    // Register MCP transport (all /mcp routes)
    createStreamableHttpTransport(mcpServer, app, { symbolIndex, parser, cache, workspaceScanner, hybridSearch, termRelationshipGraph });

    serverState.isReady = true;
    serverState.isHealthy = true;
    serverState.statusMessage = 'Ready';

    // Health check endpoint
    app.get('/health', (_req, res) => {
      return res.json({
        status: 'healthy',
        ready: true,
        service: 'd365fo-mcp-server',
        version: '1.0.0',
        symbols: serverState.symbolIndex?.getSymbolCount() || 0,
      });
    });

    // Start listening — server is fully initialised at this point
    const host = process.env.HOST || '0.0.0.0';
    app.listen(PORT, host, () => {
      console.log('');
      console.log('✅ Server is READY!');
      console.log(`✅ D365 F&O MCP Server listening on ${host}:${PORT}`);
      console.log(`📡 MCP endpoint: http://${host}:${PORT}/mcp`);
      console.log(`🏥 Health check: http://localhost:${PORT}/health`);
      console.log(`🔧 Server mode: ${SERVER_MODE}`);
      console.log('');

      const toolCatalog = [
        { icon: '🔍', category: 'Search & Discovery', tools: [
          { name: 'search',                       desc: 'Search 584K+ D365FO symbols by name or keyword' },
          { name: 'batch_search',                 desc: 'Execute multiple searches in parallel (3x faster)' },
          { name: 'search_extensions',            desc: 'Search only custom/ISV models (filters out standard code)' },
          { name: 'get_class_info',               desc: 'Full class: all methods with source, inheritance, attributes' },
          { name: 'get_table_info',               desc: 'Full table: fields, indexes, relations, methods' },
          { name: 'get_enum_info',                desc: 'Enum values with integer values and labels' },
          { name: 'get_edt_info',                 desc: 'Extended Data Type: base type, labels, properties' },
          { name: 'code_completion',              desc: 'IntelliSense-style method/field listing on any object' },
        ]},
        { icon: '🏷️ ', category: 'Label Management', tools: [
          { name: 'search_labels',                desc: 'Full-text search across all AxLabelFile labels' },
          { name: 'get_label_info',               desc: 'Get all language translations for a label ID' },
          { name: 'create_label',                 desc: 'Add new label to all language files in a model' },
          { name: 'rename_label',                 desc: 'Rename a label ID in .label.txt, X++ and XML metadata' },
        ]},
        { icon: '📊', category: 'Advanced Object Info', tools: [
          { name: 'get_form_info',                desc: 'Form datasources, control hierarchy, and methods' },
          { name: 'get_query_info',               desc: 'Query datasources, joins, field lists, and ranges' },
          { name: 'get_view_info',                desc: 'View/data entity fields, relations, computed columns' },
          { name: 'get_report_info',              desc: 'AxReport datasets, fields, designs and RDL summary' },
          { name: 'get_method_signature',         desc: 'Exact method signature (required before CoC extensions)' },
          { name: 'find_references',              desc: 'Where-used analysis across the entire codebase' },
        ]},
        { icon: '🧠', category: 'Intelligent Code Generation', tools: [
          { name: 'analyze_code_patterns',        desc: 'Find common patterns used in a scenario' },
          { name: 'suggest_method_implementation',desc: 'Real examples of similar method implementations' },
          { name: 'analyze_class_completeness',   desc: 'Find missing standard methods on a class' },
          { name: 'get_api_usage_patterns',       desc: 'Show how an API is initialized and called' },
        ]},
        { icon: '🎨', category: 'Smart Object Generation', tools: [
          { name: 'generate_smart_table',         desc: 'AI-driven table generation with pattern analysis' },
          { name: 'generate_smart_form',          desc: 'AI-driven form generation with pattern analysis' },
          { name: 'suggest_edt',                  desc: 'Suggest EDT for field name using fuzzy matching' },
        ]},
        { icon: '📝', category: 'File & Metadata Operations', tools: [
          { name: 'generate_d365fo_xml',          desc: 'Generate D365FO XML content (preview / cloud-ready)' },
          { name: 'create_d365fo_file',           desc: 'Create D365FO file in correct AOT location (Windows)' },
          { name: 'modify_d365fo_file',           desc: 'Safely edit D365FO XML with backup & rollback (Windows)' },
        ]},
        { icon: '📈', category: 'Pattern Analysis', tools: [
          { name: 'get_table_patterns',           desc: 'Analyze common field/index patterns for table groups' },
          { name: 'get_form_patterns',            desc: 'Analyze common datasource/control patterns for forms' },
          { name: 'generate_code',                desc: 'Generate X++ boilerplate (class, batch-job, data-entity, …)' },
        ]},
      ];

      const filteredCatalog = toolCatalog
        .map(cat => ({
          ...cat,
          tools: cat.tools.filter(t => {
            if (SERVER_MODE === 'read-only') return !WRITE_TOOLS.has(t.name);
            if (SERVER_MODE === 'write-only') return WRITE_TOOLS.has(t.name);
            return true;
          }),
        }))
        .filter(cat => cat.tools.length > 0);

      const totalTools = filteredCatalog.reduce((sum, cat) => sum + cat.tools.length, 0);

      console.log(`🎯 Available tools (${totalTools} total):`);
      for (const cat of filteredCatalog) {
        console.log(`   ${cat.icon} ${cat.category} (${cat.tools.length}):`);
        for (const t of cat.tools) {
          console.log(`   - ${t.name.padEnd(28)} ${t.desc}`);
        }
        console.log('');
      }
    });
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
