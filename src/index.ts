/**
 * X++ MCP Code Completion Server
 * Main entry point
 */

// Load .env — supports ENV_FILE env var for multi-instance setups.
// See src/utils/loadEnv.ts for details.
import { loadEnv } from './utils/loadEnv.js';
loadEnv(import.meta.url);
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import express from 'express';
import compression from 'compression';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createXppMcpServer } from './server/mcpServer.js';
import { createStreamableHttpTransport } from './server/transport.js';
import { XppSymbolIndex } from './metadata/symbolIndex.js';
import { XppMetadataParser } from './metadata/xmlParser.js';
import { RedisCacheService } from './cache/redisCache.js';
import { WorkspaceScanner } from './workspace/workspaceScanner.js';
import { HybridSearch } from './workspace/hybridSearch.js';
import { initializeDatabase } from './database/download.js';
import { initializeConfig, getConfigManager } from './utils/configManager.js';
import { SERVER_MODE, LOCAL_TOOLS } from './server/serverMode.js';
import { apiKeyAuth } from './middleware/apiKeyAuth.js';
import { setInitializeParams } from './utils/stdioSessionInfo.js';
import * as fs from 'fs/promises';
import * as fsSync from 'node:fs';
import { Transform } from 'node:stream';

// Filter verbose debug progress messages unless DEBUG_LOGGING is enabled.
// Only suppress messages that are KNOWN debug output (tool-handler progress)
// and do NOT contain any error/warning indicators.
const originalConsoleError = console.error;
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';

// ─── Optional file-based logging ──────────────────────────────────────────────
// Set LOG_FILE env var to an absolute path to get a copy of all stderr output
// written to a file. Useful when the IDE doesn't expose MCP subprocess stderr
// (e.g. VS 2022 Output window only shows Copilot extension logs, not ours).
//
// In .mcp.json:  "LOG_FILE": "C:\\Temp\\d365fo-mcp.log"
// Tail in PS:    Get-Content C:\Temp\d365fo-mcp.log -Wait -Tail 50
// ─────────────────────────────────────────────────────────────────────────────
const LOG_FILE = process.env.LOG_FILE;
let _logStream: fsSync.WriteStream | undefined;
if (LOG_FILE) {
  try {
    _logStream = fsSync.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
    const banner = `\n${'─'.repeat(72)}\n[d365fo-mcp] Started at ${new Date().toISOString()}  pid=${process.pid}\n${'─'.repeat(72)}\n`;
    _logStream.write(banner);
    // Tee: intercept process.stderr so every write also goes to the log file
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream & { write: (...args: any[]) => boolean }).write = function (chunk: any, ...rest: any[]): boolean {
      _logStream!.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return origStderrWrite(chunk, ...rest) as boolean;
    };
  } catch (e) {
    // Don't crash if log file can't be opened — just disable file logging
    process.stderr.write(`[d365fo-mcp] ⚠️ Cannot open LOG_FILE=${LOG_FILE}: ${e}\n`);
    _logStream = undefined;
  }
}
console.error = (...args: any[]) => {
  if (DEBUG_LOGGING) {
    originalConsoleError(...args);
    return;
  }
  const firstArg = String(args[0]);
  // Suppress only verbose debug progress from known tool handler prefixes,
  // but NEVER suppress if the message contains error/warning indicators.
  const isToolDebugMessage =
    (firstArg.includes('[create_d365fo_file]') ||
     firstArg.includes('[generate_d365fo_xml]') ||
     firstArg.includes('[ProjectFileManager]')) &&
    !firstArg.includes('Failed') &&
    !firstArg.includes('Error') &&
    !firstArg.includes('error') &&
    !firstArg.includes('❌') &&
    !firstArg.includes('⚠️');
  if (!isToolDebugMessage) {
    originalConsoleError(...args);
  }
};

const PORT = parseInt(process.env.PORT || '8080');
// Derive server root from this file's location so paths are absolute
// regardless of process.cwd() — critical when VS Code launches this as stdio subprocess.
const __serverDir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(__serverDir, '../data/xpp-metadata.db');
const LABELS_DB_PATH = process.env.LABELS_DB_PATH
  ? resolve(process.env.LABELS_DB_PATH)
  : resolve(__serverDir, '../data/xpp-metadata-labels.db');
const METADATA_PATH = process.env.METADATA_PATH
  ? resolve(process.env.METADATA_PATH)
  : resolve(__serverDir, '../metadata');

// Detect if running in stdio mode (launched by MCP client as subprocess).
// Primary signal: stdin is NOT a TTY — in Node.js isTTY is `true` for terminals
// and `undefined` (never `false`) for pipes, so use !isTTY, not === false.
// WEBSITES_PORT guards Azure App Service (HTTP-only, stdin may also be non-TTY there).
// MCP_FORCE_HTTP lets an operator explicitly keep HTTP even when stdin is piped.
const isStdioMode =
  !process.env.WEBSITES_PORT &&
  process.env.MCP_FORCE_HTTP !== 'true' &&
  (process.env.MCP_STDIO_MODE === 'true' || !process.stdin.isTTY);

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
  // write-only mode: skip all database/symbol work — LOCAL_TOOLS
  // (create_d365fo_file, modify_d365fo_file, create_label, verify_d365fo_project,
  //  get_workspace_info etc.) only need the config manager for path resolution,
  //  not the 1.5 GB symbol database.
  // -----------------------------------------------------------------------
  if (SERVER_MODE === 'write-only') {
    console.log('✏️  Mode: write-only (local file-operations companion)');
    console.log('⏭️  Skipping database download and symbol index — not needed in write-only mode');

    console.log('⚙️  Loading .mcp.json configuration...');
    const config = await initializeConfig();
    if (config?.servers?.context) {
      console.log('✅ Configuration loaded from .mcp.json (servers.context)');
      if (config.servers.context.workspacePath) {
        console.log(`   Workspace path: ${config.servers.context.workspacePath}`);
      }
    } else if (config) {
      console.log('ℹ️  .mcp.json found (VS/Copilot registry format) — paths from process.env');
    } else {
      console.log('ℹ️  No .mcp.json found — using environment variables / defaults');
    }

    const cache = new RedisCacheService();
    // Don't wait for Redis in write-only mode — it's not used
    cache.waitForConnection().catch(() => {});

    const symbolIndex = new XppSymbolIndex(':memory:', ':memory:');
    const parser = new XppMetadataParser();
    const workspaceScanner = new WorkspaceScanner();
    const hybridSearch = new HybridSearch(symbolIndex, workspaceScanner);

    serverState.symbolIndex = symbolIndex;
    serverState.parser = parser;
    serverState.cache = cache;

    const context: import('./types/context.js').XppServerContext = { symbolIndex, parser, cache, workspaceScanner, hybridSearch };
    const mcpServer = createXppMcpServer(context);
    console.log('✅ MCP Server initialized (write-only mode)');
    return { mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, context };
  }

  // -----------------------------------------------------------------------
  // full / read-only mode: full initialization with database
  // -----------------------------------------------------------------------
  try {
    // Load .mcp.json configuration
    console.log('⚙️  Loading .mcp.json configuration...');
    const config = await initializeConfig();
    if (config?.servers?.context) {
      console.log('✅ Configuration loaded from .mcp.json (servers.context)');
      if (config.servers.context.workspacePath) {
        console.log(`   Workspace path: ${config.servers.context.workspacePath}`);
      }
      if (config.servers.context.packagePath) {
        console.log(`   Package path: ${config.servers.context.packagePath}`);
      }
    } else if (config) {
      // Home .mcp.json found but uses VS/Copilot server-registry format (servers.<name>).
      // D365FO paths are supplied via process.env (D365FO_SOLUTIONS_PATH, DB_PATH, …).
      console.log('ℹ️  .mcp.json found (VS/Copilot registry format) — paths from process.env');
    } else {
      console.log('ℹ️  No .mcp.json found — using environment variables / defaults');
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
        console.log('   ⚠️  Symbol index is now empty. To restore, run:');
        console.log('       npm run index-metadata');
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

    // Create MCP server with full context
    serverState.statusMessage = 'Initializing MCP server...';
    const context: import('./types/context.js').XppServerContext = { 
      symbolIndex, 
      parser, 
      cache, 
      workspaceScanner, 
      hybridSearch,
    };
    const mcpServer = createXppMcpServer(context);
    console.log('✅ MCP Server initialized with workspace support');

    return { mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, context };
  } catch (error) {
    console.error('❌ Initialization error:', error);
    serverState.statusMessage = `Initialization failed: ${error}`;
    throw error;
  }
}

/**
 * Initialize C# bridge (non-blocking).
 * Shared by stdio and HTTP startup paths.
 * Attaches bridge to the given context object on success.
 */
async function initializeBridge(targetContext: import('./types/context.js').XppServerContext): Promise<void> {
  try {
    const { createBridgeClient } = await import('./bridge/bridgeClient.js');
    const configMgr = getConfigManager();
    await configMgr.ensureLoaded();
    // Call getDevEnvironmentType() BEFORE getPackagePath() — it triggers
    // ensureXppConfig() which populates xppConfig.customPackagesPath.
    // Without this ordering, getPackagePath() can't use the UDE custom path.
    const devEnvType = await configMgr.getDevEnvironmentType();
    // For UDE environments use getCustomPackagesPath() explicitly for the primary
    // path. getPackagePath() has a priority chain where .rnrproj auto-detection
    // (priority #3) can resolve to the Microsoft PackagesLocalDirectory before
    // the UDE customPackagesPath check (priority #4), causing both
    // --packages-path and --reference-packages-path to point to the same
    // Microsoft directory and leaving custom metadata unresolvable.
    let packagesPath: string | undefined;
    let binPath: string | undefined;
    let referencePackagesPath: string | undefined;
    if (devEnvType === 'ude') {
      const customPath = await configMgr.getCustomPackagesPath();
      if (customPath) packagesPath = customPath;
      const msPath = await configMgr.getMicrosoftPackagesPath();
      if (msPath) {
        const { existsSync } = await import('fs');
        const { join } = await import('path');
        const candidate = join(msPath, 'bin');
        if (existsSync(candidate)) binPath = candidate;
        // Pass Microsoft packages as reference provider so both custom and
        // Microsoft-shipped objects (forms, tables, classes, etc.) are resolvable.
        referencePackagesPath = msPath;
      }
    } else {
      packagesPath = configMgr.getPackagePath() ?? undefined;
    }

    // Pass xref connection details for UDE environments
    const xrefServer = await configMgr.getXrefDbServer() ?? undefined;
    const xrefDatabase = await configMgr.getXrefDbName() ?? undefined;

    console.log(`[Bridge] Attempting connection: packagesPath=${packagesPath ?? 'not set'}, referencePackagesPath=${referencePackagesPath ?? 'none'}, binPath=${binPath ?? 'auto'}, devEnvType=${devEnvType}`);

    const bridge = await createBridgeClient({
      packagesPath,
      referencePackagesPath,
      binPath,
      xrefServer,
      xrefDatabase,
      logFile: configMgr.getContext()?.bridgeLogFile ?? undefined,
    });
    if (bridge) {
      targetContext.bridge = bridge;
      console.log(`✅ C# bridge connected (${devEnvType}): metadata=${bridge.metadataAvailable}, xref=${bridge.xrefAvailable}`);
    } else {
      console.log(
        `⚠️  C# bridge not available — createBridgeClient returned null.\n` +
        `   packagesPath: ${packagesPath ?? '(not detected — check .mcp.json context.packagePath or PackagesLocalDirectory)'}\n` +
        `   devEnvType: ${devEnvType}\n` +
        `   Check stderr / bridge log for details. Ensure the bridge exe is built:\n` +
        `     cd bridge/D365MetadataBridge && dotnet build -c Release`
      );
    }
  } catch (err) {
    console.log(`ℹ️  C# bridge not available: ${err}`);
  }
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  // Phase-1 diagnostic interceptors (stdio-only helpers)
  // Defined here so _phase1Start and diagTs are never allocated in HTTP mode.
  // Each incoming/outgoing newline-delimited JSON-RPC message is logged to
  // stderr so you can see exactly what VS 2022 sends.
  // ─────────────────────────────────────────────────────────────────────────────
  const _phase1Start = Date.now();
  function diagTs(): string {
    return `+${Date.now() - _phase1Start}ms`;
  }

  /** Wraps process.stdin — logs every incoming JSON-RPC message, passes data through unchanged. */
  function createDiagnosticStdin(): Transform {
    let buf = Buffer.alloc(0);
    const t = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        buf = Buffer.concat([buf, chunk]);
        // MCP stdio transport uses newline-delimited JSON: each message is one
        // JSON object terminated by \n (with optional \r before \n).
        let newlineIdx: number;
        while ((newlineIdx = buf.indexOf(0x0a)) !== -1) {
          const line = buf.slice(0, newlineIdx).toString('utf8').replace(/\r$/, '');
          buf = buf.slice(newlineIdx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            // Always capture initialize params regardless of DEBUG_LOGGING flag
            // so get_workspace_info can show them even in production stdio mode.
            if (msg.method === 'initialize' && msg.params) {
              setInitializeParams(msg.params);
            }
            if (DEBUG_LOGGING) {
              const kind = msg.method != null ? `📨 ${msg.method}` : `✅ reply#${msg.id}`;
              const payload = msg.params ?? msg.result ?? msg.error ?? {};
              process.stderr.write(
                `[VS→MCP ${diagTs()}] ${kind}  ${JSON.stringify(payload).slice(0, 900)}\n`
              );
            }
          } catch { /* non-JSON line, skip */ }
        }
        cb(null, chunk); // pass data through unchanged
      },
    });
    process.stdin.pipe(t);
    return t;
  }

  /** Wraps process.stdout — logs every outgoing JSON-RPC message, passes data through unchanged. */
  function createDiagnosticStdout(): Transform {
    let buf = Buffer.alloc(0);
    const t = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        buf = Buffer.concat([buf, chunk]);
        // MCP stdio transport uses newline-delimited JSON.
        let newlineIdx: number;
        while ((newlineIdx = buf.indexOf(0x0a)) !== -1) {
          const line = buf.slice(0, newlineIdx).toString('utf8').replace(/\r$/, '');
          buf = buf.slice(newlineIdx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const kind = msg.method != null ? `🔔 ${msg.method}` : `📤 reply#${msg.id}`;
            let payload: unknown = msg.result ?? msg.params ?? msg.error ?? {};
            // Avoid flooding log with the full tools/list payload
            if (msg.id != null && Array.isArray((payload as any)?.tools)) {
              payload = { tools_count: (payload as any).tools.length, first: (payload as any).tools[0]?.name };
            }
            process.stderr.write(
              `[MCP→VS ${diagTs()}] ${kind}  ${JSON.stringify(payload).slice(0, 500)}\n`
            );
          } catch { /* non-JSON line, skip */ }
        }
        cb(null, chunk); // pass data through unchanged
      },
    });
    t.pipe(process.stdout);
    return t;
  }

  // CRITICAL: In STDIO mode, redirect all console.log to stderr
  // GitHub Copilot reads stdout for MCP protocol only!
  if (isStdioMode) {
    console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
    console.info = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
    console.warn = (...args: any[]) => process.stderr.write('[WARN] ' + args.join(' ') + '\n');
  } else {
    // HTTP mode (Azure App Service): redirect console.warn to stdout so Azure
    // Log Stream shows red ONLY for console.error (real errors), not warnings.
    console.warn = (...args: any[]) => process.stdout.write('[WARN] ' + args.join(' ') + '\n');
  }

  console.log(`📡 Mode: ${isStdioMode ? 'STDIO' : 'HTTP'}`);
  console.log(`🔧 Server mode: ${SERVER_MODE}`);

  if (isStdioMode) {
    // Pre-seed workspace so auto-detection starts before the first tool call.
    // VS Code sets process.cwd() to the first workspace folder for stdio servers.
    // VSCODE_WORKSPACE_FOLDER_PATHS is a more reliable VS Code-specific env var.
    const envRoots = process.env.VSCODE_WORKSPACE_FOLDER_PATHS
      ?.split(';')
      .filter(Boolean)
      .map(u => u.startsWith('file:///')
        ? decodeURIComponent(u.slice(8)).replace(/\//g, '\\')
        : u);
    const initialWorkspace = envRoots?.[0] ?? process.cwd();
    // Eagerly scan D365FO_SOLUTIONS_PATH so allDetectedProjects is populated before
    // VS 2022 sends roots/list (usually within 1–2 s of startup).
    getConfigManager().initEagerScan();
    process.stderr.write(`[stdio ${diagTs()}] Seeding workspace: ${initialWorkspace}\n`);
    if (DEBUG_LOGGING) {
      process.stderr.write(
        `[phase1 diag] ────────────────────────────────────────────────────────\n` +
        `[phase1 diag] DEBUG_LOGGING=true → raw JSON-RPC trace ENABLED\n` +
        `[phase1 diag]  [VS→MCP ...] = messages FROM Visual Studio TO this server\n` +
        `[phase1 diag]  [MCP→VS ...] = messages FROM this server TO Visual Studio\n` +
        `[phase1 diag] ────────────────────────────────────────────────────────\n`
      );
    }
    getConfigManager().setRuntimeContext({ workspacePath: initialWorkspace });

    // STDIO mode: connect transport BEFORE the heavy database open so the MCP
    // handshake completes within VS 2022's initialization timeout (~10 s).
    //
    // Strategy:
    //  1. Create a lightweight "stub" server with an in-memory (empty) symbol index.
    //  2. Connect the stdio transport — handshake completes immediately.
    //  3. Yield the event loop (setImmediate) so VS 2022's `initialized` notification
    //     and the roots/list exchange are processed BEFORE the synchronous DB open
    //     blocks the event loop. Without this yield, project auto-detection via
    //     roots/list could be delayed until after DB load.
    //  4. Run full initializeServices() in the background.
    //  5. Swap the real symbol index into the context once init finishes.
    //     Tool handlers await ctx.dbReady so they always use the real index —
    //     they will block (showing a spinner in the IDE) until the DB is ready,
    //     then execute immediately with full results.

    // Step 1: lightweight stub + deferred dbReady promise
    const stubCache = new RedisCacheService();
    stubCache.waitForConnection().catch(() => {});
    const stubIndex = new XppSymbolIndex(':memory:', ':memory:');
    const stubParser = new XppMetadataParser();
    const stubScanner = new WorkspaceScanner();
    const stubHybrid = new HybridSearch(stubIndex, stubScanner);

    let resolveDbReady!: () => void;
    let rejectDbReady!: (err: unknown) => void;
    const dbReadyPromise = new Promise<void>((res, rej) => {
      resolveDbReady = res;
      rejectDbReady  = rej;
    });

    const stubContext: import('./types/context.js').XppServerContext = {
      symbolIndex: stubIndex,
      parser: stubParser,
      cache: stubCache,
      workspaceScanner: stubScanner,
      hybridSearch: stubHybrid,
      dbReady: dbReadyPromise,
    };
    const mcpServer = createXppMcpServer(stubContext);

    // Step 2: connect transport — handshake completes here
    // Always wrap stdin with the session-sniffer Transform so we can capture
    // the `initialize` request params (clientInfo, capabilities) for
    // get_workspace_info diagnostics — even when DEBUG_LOGGING is false.
    // stdout is only intercepted when DEBUG_LOGGING=true (it's noisy).
    const diagStdin  = createDiagnosticStdin();
    const diagStdout = DEBUG_LOGGING ? createDiagnosticStdout() : process.stdout;
    const transport = new StdioServerTransport(
      diagStdin  as unknown as typeof process.stdin,
      diagStdout as unknown as typeof process.stdout,
    );
    await mcpServer.connect(transport);
    console.log(`✅ Stdio transport connected ${diagTs()} (DB loading in background)`);

    // Step 3: yield the event loop so `initialized` + roots/list can be processed
    // BEFORE the synchronous new Database() call blocks the event loop.
    await new Promise<void>(resolve => setImmediate(resolve));
    process.stderr.write(`[stdio ${diagTs()}] setImmediate fired — roots/list exchange should be done\n`);

    // Step 3b: Initialize C# bridge in parallel with DB load (non-blocking)
    // The bridge provides live metadata from Microsoft's IMetadataProvider API
    // and cross-reference queries — only available on Windows VMs with D365FO.
    void initializeBridge(stubContext);

    // Step 4: load real database in the background
    const dbLoadStart = Date.now();
    initializeServices().then(({ symbolIndex, parser, cache, workspaceScanner, hybridSearch }) => {
      // Step 5: patch the context references used by tool handlers
      stubContext.symbolIndex       = symbolIndex;
      stubContext.parser            = parser;
      stubContext.cache             = cache;
      stubContext.workspaceScanner  = workspaceScanner;
      stubContext.hybridSearch      = hybridSearch;
      serverState.symbolIndex = symbolIndex;
      serverState.parser      = parser;
      serverState.cache       = cache;
      serverState.statusMessage = 'Ready';
      // Resolve dbReady AFTER context is patched — tools can now run with real index.
      resolveDbReady();
      console.log(`✅ Database loaded in ${Date.now() - dbLoadStart} ms (${diagTs()} from process start) — all tools fully operational`);

      // Close the handshake-phase stub cache so we don't leak its (no-op or
      // real Redis) connection for the rest of the process lifetime.
      // The stub and the real cache are distinct RedisCacheService instances;
      // once the real one is wired, the stub is unreachable.
      if (stubCache !== cache) {
        stubCache.close().catch(() => {});
      }
      // The in-memory stub symbol index is also unreachable once swapped.
      try { stubIndex.close(); } catch { /* ignore */ }
    }).catch(err => {
      rejectDbReady(err);
      console.error('❌ Background initialization failed:', err);
    });

    // Log tool count immediately (transport is already connected)
    const totalTools = 54;
    const localToolCount = LOCAL_TOOLS.size;
    const toolCount = SERVER_MODE === 'write-only' ? localToolCount :
                     SERVER_MODE === 'read-only' ? totalTools - localToolCount : totalTools;
    const toolDesc = SERVER_MODE === 'write-only' ? `(${Array.from(LOCAL_TOOLS).join(', ')})` :
                    SERVER_MODE === 'read-only' ? '(all except local tools)' :
                    '(8 discovery + 7 object-info + 6 intelligent + 4 smart-gen + 3 pattern-analysis + 10 security-ext + 4 file-ops + 7 sdlc-build + 4 labels + 1 workspace)';
    console.log(`🎯 Registered ${toolCount} X++ MCP tools ${toolDesc}`);
    serverState.isReady = true;
    serverState.isHealthy = true;
    serverState.statusMessage = 'Loading database...';
  } else {
    // HTTP mode — bind the port immediately so Azure App Service does not kill
    // the process during the (potentially long) database initialisation phase.
    // The health endpoint returns 503 while the server is starting and 200 once
    // fully ready.  MCP routes are registered dynamically after initializeServices().
    console.log('📡 Using HTTP transport for standalone server');

    // Create Express app
    const app = express();

    // Trust proxy - required for Azure App Service (behind reverse proxy)
    app.set('trust proxy', 1);

    // Compress responses — JSON search results can be 50–200 KB;
    // gzip typically gives 70–80 % reduction and Azure egress billing benefits.
    app.use(compression());

    app.use(express.json());

    // API key authentication — enforced when API_KEY env var is set.
    // Must be after express.json() but before route handlers.
    // /health is excluded so Azure health probes still work unauthenticated.
    app.use(apiKeyAuth);

    // Health check endpoint — dynamic: reflects serverState at request time
    app.get('/health', (_req, res) => {
      const ready = serverState.isReady;
      return res.status(ready ? 200 : 503).json({
        status: ready ? 'healthy' : 'starting',
        ready,
        service: 'd365fo-mcp-server',
        version: '1.0.0',
        message: serverState.statusMessage,
        symbols: serverState.symbolIndex?.getSymbolCount() || 0,
      });
    });

    // Early /mcp route — returns 503 while services are loading so MCP clients
    // (VS 2022, VS Code Copilot) get a proper JSON-RPC error instead of a 404
    // during Azure cold start. Once initializeServices() finishes, the real
    // transport route (registered later in the Express stack) handles requests.
    // We call next() when ready so the real handler takes over.
    app.post('/mcp', (_req, res, next) => {
      if (serverState.isReady) {
        // Services loaded — let the real transport handler take over
        next();
        return;
      }
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Server is starting: ${serverState.statusMessage}` },
        id: (_req.body as any)?.id ?? null,
      });
    });

    // Bind port immediately — Azure requires the port to be open within ~230 s
    const host = process.env.HOST || '0.0.0.0';
    await new Promise<void>(resolve => app.listen(PORT, host, () => {
      console.log(`🔌 HTTP server bound to ${host}:${PORT} — waiting for initialisation...`);
      resolve();
    }));

    // Initialise services in the background; register MCP routes once ready
    initializeServices().then(({ mcpServer, symbolIndex, parser, cache, workspaceScanner, hybridSearch, context }) => {
      // Register MCP transport (Express supports dynamic route registration)
      createStreamableHttpTransport(mcpServer, app, { symbolIndex, parser, cache, workspaceScanner, hybridSearch });

      // Initialize C# bridge (non-blocking) — also needed for HTTP mode on Windows/UDE
      if (context) void initializeBridge(context);

      serverState.isReady = true;
      serverState.isHealthy = true;
      serverState.statusMessage = 'Ready';

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
          { name: 'get_method_source',            desc: 'Full X++ source code of a method (complete business logic)' },
          { name: 'find_references',              desc: 'Where-used analysis across the entire codebase' },
        ]},
        { icon: '🧠', category: 'Intelligent Code Generation', tools: [
          { name: 'get_xpp_knowledge',            desc: 'X++ knowledge base: D365FO patterns, best practices, AX2012→D365FO migration' },
          { name: 'get_d365fo_error_help',        desc: 'Explain D365FO compiler, runtime and BP errors with concrete fixes' },
          { name: 'analyze_code_patterns',        desc: 'Find common patterns used in a scenario' },
          { name: 'suggest_method_implementation',desc: 'Real examples of similar method implementations' },
          { name: 'analyze_class_completeness',   desc: 'Find missing standard methods on a class' },
          { name: 'get_api_usage_patterns',       desc: 'Show how an API is initialized and called' },
        ]},
        { icon: '🎨', category: 'Smart Object Generation', tools: [
          { name: 'generate_smart_table',         desc: 'AI-driven table generation with pattern analysis' },
          { name: 'generate_smart_form',          desc: 'AI-driven form generation with pattern analysis' },
          { name: 'generate_smart_report',        desc: 'AI-driven SSRS report generation (TmpTable + Contract + DP + Controller + AxReport)' },
          { name: 'suggest_edt',                  desc: 'Suggest EDT for field name using fuzzy matching' },
        ]},
        { icon: '📝', category: 'File & Metadata Operations', tools: [
          { name: 'generate_d365fo_xml',          desc: 'Generate D365FO XML content (preview / cloud-ready)' },
          { name: 'create_d365fo_file',           desc: 'Create D365FO file in correct AOT location (Windows)' },
          { name: 'modify_d365fo_file',           desc: 'Safely edit D365FO XML (Windows)' },
        ]},
        { icon: '📈', category: 'Pattern Analysis', tools: [
          { name: 'get_table_patterns',           desc: 'Analyze common field/index patterns for table groups' },
          { name: 'get_form_patterns',            desc: 'Analyze common datasource/control patterns for forms' },
          { name: 'generate_code',                desc: 'Generate X++ boilerplate (class, SysOperation, CoC, event-handler, …)' },
        ]},
        { icon: '🔐', category: 'Security & Extensions', tools: [
          { name: 'get_security_artifact_info',   desc: 'Privilege/Duty/Role details and full hierarchy chain' },
          { name: 'get_security_coverage_for_object', desc: 'Which roles can access a form/table/class?' },
          { name: 'get_menu_item_info',           desc: 'Menu item target, type, and security privilege chain' },
          { name: 'find_coc_extensions',          desc: 'Which classes use CoC to wrap a given method?' },
          { name: 'find_event_handlers',          desc: 'Find all [SubscribesTo] handlers for a table or class event' },
          { name: 'get_table_extension_info',     desc: 'All extensions of a table: added fields, indexes, methods' },
          { name: 'get_data_entity_info',         desc: 'Data entity: category, OData settings, data sources, keys' },
          { name: 'analyze_extension_points',     desc: 'CoC-eligible methods, delegates, events — what can be extended?' },
          { name: 'recommend_extension_strategy',  desc: 'Recommends the best extensibility mechanism for a given scenario' },
          { name: 'validate_object_naming',       desc: 'Validate proposed extensions and object names against D365FO conventions' },
          { name: 'get_workspace_info',           desc: 'Detected workspace paths, model name, project file, and server mode' },
          { name: 'verify_d365fo_project',        desc: 'Verify objects exist on disk and are referenced in the .rnrproj project file' },
        ]},
        { icon: '🏗️ ', category: 'SDLC & Build Tools', tools: [
          { name: 'update_symbol_index',          desc: 'Index a newly generated XML file immediately (no restart needed)' },
          { name: 'build_d365fo_project',         desc: 'Run MSBuild compilation locally to capture errors' },
          { name: 'trigger_db_sync',              desc: 'Run a database sync for the current model' },
          { name: 'run_bp_check',                 desc: 'Run Microsoft Best Practices (xppbp.exe) analysis' },
          { name: 'run_systest_class',            desc: 'Execute unit tests using SysTestRunner.exe' },
        ]},
        { icon: '🔄', category: 'Code Review & Source Control', tools: [
          { name: 'review_workspace_changes',     desc: 'AI-based D365FO code review on uncommitted X++ changes (git diff)' },
          { name: 'undo_last_modification',       desc: 'Safely revert last file change: checkout HEAD or delete untracked file' },
        ]},
      ];

      const filteredCatalog = toolCatalog
        .map(cat => ({
          ...cat,
          tools: cat.tools.filter(t => {
            if (SERVER_MODE === 'read-only') return !LOCAL_TOOLS.has(t.name);
            if (SERVER_MODE === 'write-only') return LOCAL_TOOLS.has(t.name);
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
    }).catch((err) => {
      console.error('❌ Initialisation failed:', err);
      serverState.isHealthy = false;
      serverState.statusMessage = `Initialisation failed: ${err}`;
    });
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
