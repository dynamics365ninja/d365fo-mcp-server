/**
 * X++ MCP Code Completion Server
 * Main entry point
 */

// Load .env — supports ENV_FILE env var for multi-instance setups (see src/utils/loadEnv.ts).
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
import { WorkspaceScanner } from './workspace/workspaceScanner.js';
import { HybridSearch } from './workspace/hybridSearch.js';
import { initializeDatabase } from './database/download.js';
import { initializeConfig, getConfigManager } from './utils/configManager.js';
import { SERVER_MODE, LOCAL_TOOLS } from './server/serverMode.js';
import { TOOL_ANNOTATIONS } from './server/toolAnnotations.js';
import { apiKeyAuth } from './middleware/apiKeyAuth.js';
import { setInitializeParams } from './utils/stdioSessionInfo.js';
import { box, kv, sectionTitle, statusLine, spread, c, glyph, sanitize, supportsUnicode, log, shortPath, startupWarnings } from './utils/terminalUi.js';
import * as fs from 'fs/promises';
import * as fsSync from 'node:fs';
import { Transform } from 'node:stream';

// Filter verbose debug progress messages unless DEBUG_LOGGING is enabled.
const originalConsoleError = console.error;
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';

// Optional file-based logging: set LOG_FILE to an absolute path to mirror stderr
// to a file (useful when the IDE doesn't expose MCP subprocess stderr).
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
    // Don't crash the server if the log file can't be opened
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
  // Suppress verbose operational debug messages from any tool/component prefix
  // (pattern: message starts with "[module_name]"), but NEVER suppress if the
  // message contains error/warning indicators — those must always reach the client.
  const hasErrorIndicator =
    firstArg.includes('Failed') ||
    firstArg.includes('failed') ||
    firstArg.includes('Error') ||
    firstArg.includes('error') ||
    firstArg.includes('❌') ||
    firstArg.includes('⚠️') ||
    firstArg.includes('[WARN]') ||
    firstArg.includes('[ERROR]');
  const isModuleDebugMessage = /^\[[\w\- ]+\]/.test(firstArg) && !hasErrorIndicator;
  if (!isModuleDebugMessage) {
    originalConsoleError(...args);
  }
};

// ─── Global safety net ────────────────────────────────────────────────────────
// An unhandled promise rejection terminates the Node process by default
// (Node ≥15, --unhandled-rejections=throw). In stdio mode that kills the MCP
// subprocess and the client must restart it — observed as "the server crashes
// on the first request and has to be restarted" when a background task (e.g.
// the async DB load) rejects before any tool call awaits it. Log and keep the
// server alive instead of dying. (stderr is already tee'd to LOG_FILE above.)
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[d365fo-mcp] ⚠️ Unhandled promise rejection (server staying up): ${msg}\n`);
});

// Same protection for SYNCHRONOUS uncaught exceptions — a throw that escapes a
// timer/stream/event callback (not an awaited promise) would otherwise stop the
// process outright. For a stdio server that means the MCP client must respawn
// the subprocess after the very first failing request. Log the full stack so the
// root cause is diagnosable, then keep serving. (Genuinely fatal startup errors
// are still surfaced via main().catch → process.exit below.)
process.on('uncaughtException', (err) => {
  process.stderr.write(`[d365fo-mcp] ⚠️ Uncaught exception (server staying up): ${err?.stack ?? err}\n`);
});

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
}

const serverState: ServerState = {
  isReady: false,
  isHealthy: false,
  statusMessage: 'Starting...',
};

async function initializeServices() {
  // -----------------------------------------------------------------------
  // write-only mode: skip all database/symbol work — LOCAL_TOOLS
  // (create_d365fo_file, modify_d365fo_file, labels, verify_d365fo_project,
  //  get_workspace_info etc.) only need the config manager for path resolution,
  //  not the 1.5 GB symbol database.
  // -----------------------------------------------------------------------
  if (SERVER_MODE === 'write-only') {
    log.info('Mode: write-only (local file-operations companion)');
    log.detail('skipping database download and symbol index — not needed here');

    const config = await initializeConfig();
    if (config?.servers?.context) {
      log.ok('Configuration loaded from .mcp.json (servers.context)');
      if (config.servers.context.workspacePath) {
        log.detail(`workspace: ${config.servers.context.workspacePath}`);
      }
    } else if (config) {
      log.info('Configuration from environment (.mcp.json uses VS/Copilot registry format)');
    } else {
      log.info('Configuration from environment variables');
    }

    const symbolIndex = new XppSymbolIndex(':memory:', ':memory:');
    const parser = new XppMetadataParser();
    const workspaceScanner = new WorkspaceScanner();
    const hybridSearch = new HybridSearch(symbolIndex, workspaceScanner);

    serverState.symbolIndex = symbolIndex;
    serverState.parser = parser;

    const context: import('./types/context.js').XppServerContext = { symbolIndex, parser, workspaceScanner, hybridSearch };
    const mcpServer = createXppMcpServer(context);
    log.ok('MCP Server initialized (write-only mode)');
    return { mcpServer, symbolIndex, parser, workspaceScanner, hybridSearch, context };
  }

  // -----------------------------------------------------------------------
  // full / read-only mode: full initialization with database
  // -----------------------------------------------------------------------
  try {
    // Resolve configuration source — report the outcome in a single line rather
    // than a "loading…" step followed by a result (the load is instant, and an
    // absent .mcp.json is a normal case, not a warning).
    const config = await initializeConfig();
    if (config?.servers?.context) {
      log.ok('Configuration loaded from .mcp.json (servers.context)');
      if (config.servers.context.workspacePath) {
        log.detail(`workspace: ${config.servers.context.workspacePath}`);
      }
      if (config.servers.context.packagePath) {
        log.detail(`packages:  ${config.servers.context.packagePath}`);
      }
    } else if (config) {
      // Home .mcp.json found but uses VS/Copilot server-registry format (servers.<name>).
      // D365FO paths are supplied via process.env (D365FO_SOLUTIONS_PATH, DB_PATH, …).
      log.info('Configuration from environment (.mcp.json uses VS/Copilot registry format)');
    } else {
      log.info('Configuration from environment variables');
    }

    // Download database from blob storage if configured (only if remote is newer than local)
    if (process.env.AZURE_STORAGE_CONNECTION_STRING && process.env.BLOB_CONTAINER_NAME) {
      try {
        serverState.statusMessage = 'Checking database version...';
        await initializeDatabase();
      } catch (error) {
        console.error(statusLine('warn', 'Failed to download database from blob storage:'), error);
        log.detail('will attempt to use existing local database' + glyph.ellipsis);

        // If download failed, check if local database exists and is valid
        try {
          await fs.access(DB_PATH);
          log.detail('local database file exists, will attempt to use it');
        } catch {
          log.warn('No local database available — server will start with empty index');
        }
      }
    }

    // Initialize symbol index and parser (DB path is shown in the startup header).
    // The open is synchronous and can block briefly on a large DB, so announce
    // it first — otherwise the output looks frozen during the load.
    log.step('Loading symbols' + glyph.ellipsis);
    serverState.statusMessage = 'Loading metadata database...';
    const dbLoadStart = Date.now();

    // Yield event loop so any pending MCP protocol messages (initialize exchange,
    // roots/list, first tool call) can be queued before new Database() blocks.
    // better-sqlite3 open is synchronous — a 1.5 GB file can stall the loop for
    // several seconds, causing the first client request to time out and cancel.
    await new Promise<void>(r => setImmediate(r));

    let symbolIndex: XppSymbolIndex;
    let dbHasSymbols = false;

    try {
      symbolIndex = new XppSymbolIndex(DB_PATH, LABELS_DB_PATH);
      // Cheap O(1) probe — NOT getSymbolCount(): a full COUNT scan of a 2 GB DB
      // blocks the event loop for 30-60 s, which starves the MCP handshake and
      // makes clients (VS Code Copilot) time out and kill the server.
      dbHasSymbols = symbolIndex.hasAnySymbols();
    } catch (error: any) {
      console.error(statusLine('err', 'Failed to open database:'), error);

      // If database is corrupted, delete it and create new empty one
      if (error.code === 'SQLITE_CORRUPT' || error.message?.includes('malformed')) {
        log.warn('Database is corrupted — removing and creating a fresh one' + glyph.ellipsis);
        try {
          await fs.unlink(DB_PATH);
          log.detail('corrupted database removed');
        } catch (unlinkError) {
          console.error(statusLine('warn', 'Failed to remove corrupted database:'), unlinkError);
        }

        // Try again with fresh database
        symbolIndex = new XppSymbolIndex(DB_PATH, LABELS_DB_PATH);
        dbHasSymbols = symbolIndex.hasAnySymbols();
        log.warn('Symbol index is now empty. To restore, run: npm run index-metadata');
      } else {
        throw error;
      }
    }

    const parser = new XppMetadataParser();

    // Check if database needs indexing
    if (!dbHasSymbols) {
      log.warn('No symbols found in database — run `npm run index-metadata` first');
      log.detail('or set METADATA_PATH and the server will index on startup');

      // If metadata path exists, index it
      try {
        await fs.access(METADATA_PATH);
        log.step(`Indexing metadata from ${METADATA_PATH}` + glyph.ellipsis);
        serverState.statusMessage = 'Indexing metadata...';
        const modelNamesStr = process.env.CUSTOM_MODELS || 'CustomModel';
        const modelNames = modelNamesStr.split(',').map(m => m.trim()).filter(Boolean);
        log.detail(`model names: ${modelNames.join(', ')}`);

        for (const modelName of modelNames) {
          log.detail(`indexing ${modelName}` + glyph.ellipsis);
          await symbolIndex.indexMetadataDirectory(METADATA_PATH, modelName);
        }

        log.ok(`Indexed ${symbolIndex.getSymbolCount().toLocaleString('en-US')} symbols from ${modelNames.length} model(s)`);
      } catch {
        log.warn('Metadata path not accessible — starting with empty index');
      }
    } else {
      log.ok(`Database opened in ${((Date.now() - dbLoadStart) / 1000).toFixed(1)}s ${glyph.dot} counting symbols in background`);
      // The count scan runs in a worker thread (getSymbolCounts) so it never
      // blocks MCP requests; the breakdown is logged when it lands.
      void symbolIndex.getSymbolCounts().then(({ total, byType: b }) => {
        const n = (x: number) => (x || 0).toLocaleString('en-US');
        log.ok(`Counted ${total.toLocaleString('en-US')} symbols in ${((Date.now() - dbLoadStart) / 1000).toFixed(1)}s`);
        log.detail(`${n(b.class)} classes ${glyph.dot} ${n(b.table)} tables ${glyph.dot} ${n(b.form)} forms ${glyph.dot} ${n(b.query)} queries ${glyph.dot} ${n(b.view)} views`);
      }).catch(err => {
        console.error(statusLine('warn', 'Symbol count failed:'), err);
      });
    }

    serverState.symbolIndex = symbolIndex;
    serverState.parser = parser;

    // Initialize workspace scanner and hybrid search
    const workspaceScanner = new WorkspaceScanner();
    const hybridSearch = new HybridSearch(symbolIndex, workspaceScanner);

    // Create MCP server with full context
    serverState.statusMessage = 'Initializing MCP server...';
    const context: import('./types/context.js').XppServerContext = {
      symbolIndex,
      parser,
      workspaceScanner,
      hybridSearch,
    };
    const mcpServer = createXppMcpServer(context);

    return { mcpServer, symbolIndex, parser, workspaceScanner, hybridSearch, context };
  } catch (error) {
    console.error(statusLine('err', 'Initialization error:'), error);
    serverState.statusMessage = `Initialization failed: ${error}`;
    throw error;
  }
}

/**
 * Initialize C# bridge (non-blocking).
 * Shared by stdio and HTTP startup paths.
 * Attaches bridge to the given context object on success.
 */
interface BridgeStatus {
  ok: boolean;
  summary: string;
  detail?: string;
}

async function initializeBridge(targetContext: import('./types/context.js').XppServerContext): Promise<BridgeStatus> {
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
      // Traditional: the MS PackagesLocalDirectory is the canonical metadata root.
      const pldPath = configMgr.getPackagePath() ?? undefined;
      // A custom metadata root — e.g. a repo checkout configured via
      // context.customPackagesPath / D365FO_CUSTOM_PACKAGES_PATH — may hold the
      // model being edited. If it differs from the PLD, make it the PRIMARY
      // provider and keep the PLD as the reference provider so BOTH custom and
      // Microsoft-shipped objects resolve. Without this, modify/create via the
      // bridge can't find objects whose metadata lives outside the PLD (the
      // bridge resolves objects by its configured roots, not per-call paths).
      const customPath = await configMgr.getCustomPackagesPath();
      const { existsSync } = await import('fs');
      const { join, resolve } = await import('path');
      const samePath = (a?: string, b?: string) =>
        !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();
      if (customPath && existsSync(customPath) && !samePath(customPath, pldPath)) {
        packagesPath = customPath;
        if (pldPath) {
          referencePackagesPath = pldPath;
          const candidate = join(pldPath, 'bin');
          if (existsSync(candidate)) binPath = candidate;
        }
      } else {
        packagesPath = pldPath;
      }
    }

    // Pass xref connection details for UDE environments
    const xrefServer = await configMgr.getXrefDbServer() ?? undefined;
    const xrefDatabase = await configMgr.getXrefDbName() ?? undefined;

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
      const cap = `metadata ${bridge.metadataAvailable ? 'yes' : 'no'} ${glyph.dot} xref ${bridge.xrefAvailable ? 'yes' : 'no'}`;
      return { ok: true, summary: `C# bridge connected (${devEnvType}) ${glyph.dot} ${cap}` };
    }
    return {
      ok: false,
      summary: `C# bridge unavailable (${devEnvType}) — live metadata off, using the symbol index`,
      detail: `packages: ${packagesPath ?? '(not detected — check .mcp.json context.packagePath or PackagesLocalDirectory)'}`,
    };
  } catch (err) {
    return { ok: false, summary: `C# bridge unavailable: ${err}` };
  }
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  // Stdin sniffer: capture the `initialize` request params for get_workspace_info.
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Wraps process.stdin to capture the `initialize` request params (clientInfo,
   * capabilities, roots) so get_workspace_info can surface them. Passes every
   * byte through unchanged — this feeds a real tool, it is not a diagnostic trace.
   */
  function createInitializeParamsSniffer(): Transform {
    let buf = Buffer.alloc(0);
    const t = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        buf = Buffer.concat([buf, chunk]);
        // MCP stdio transport uses newline-delimited JSON: one object per line.
        let newlineIdx: number;
        while ((newlineIdx = buf.indexOf(0x0a)) !== -1) {
          const line = buf.slice(0, newlineIdx).toString('utf8').replace(/\r$/, '');
          buf = buf.slice(newlineIdx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method === 'initialize' && msg.params) {
              setInitializeParams(msg.params);
            }
          } catch { /* non-JSON line, skip */ }
        }
        cb(null, chunk); // pass data through unchanged
      },
    });
    process.stdin.pipe(t);
    return t;
  }

  // CRITICAL: In STDIO mode, redirect all console.log/info/warn to stderr.
  // GitHub Copilot reads stdout for MCP protocol only!
  // Suppress verbose operational messages unless DEBUG_LOGGING=true — every
  // stderr line appears as "[warning] [server stderr]" in the MCP client UI,
  // which is confusing when it's just normal startup/metrics output.
  if (isStdioMode) {
    const stderrWrite = (...args: any[]) => {
      if (DEBUG_LOGGING) { process.stderr.write(args.join(' ') + '\n'); return; }
      const msg = args.join(' ');
      // Only forward genuine errors/warnings; suppress operational info.
      if (msg.includes('❌') || msg.includes('⚠️') ||
          msg.includes('Error') || msg.includes('error') ||
          msg.includes('Failed') || msg.includes('failed')) {
        process.stderr.write(msg + '\n');
      }
    };
    console.log = stderrWrite;
    console.info = stderrWrite;
    console.warn = (...args: any[]) => process.stderr.write('[WARN] ' + args.join(' ') + '\n');
  } else {
    // HTTP mode (e.g. `npm run dev` in PowerShell, or Azure App Service).
    // Sanitise at the stream level so the classic Windows console (cp852) shows
    // clean ASCII glyphs instead of mojibake, while modern terminals (Windows
    // Terminal, VS Code) keep the emoji. Wrapping process.stdout/stderr.write —
    // rather than the console.* methods — keeps the error-detection filter above
    // working on the original (emoji-bearing) text, and catches direct
    // process.stderr.write calls too. No-op when Unicode is supported.
    // Safe in HTTP mode: the MCP protocol travels over HTTP sockets, not stdout.
    if (!supportsUnicode) {
      const wrapWrite = (stream: NodeJS.WriteStream) => {
        const orig = stream.write.bind(stream) as (...a: any[]) => boolean;
        (stream as any).write = (chunk: any, ...rest: any[]): boolean =>
          typeof chunk === 'string' ? orig(sanitize(chunk), ...rest) : orig(chunk, ...rest);
      };
      wrapWrite(process.stdout);
      wrapWrite(process.stderr);
    }
    // Redirect console.warn to stdout so Azure Log Stream shows red ONLY for
    // console.error (real errors), not warnings.
    console.warn = (...args: any[]) => process.stdout.write('[WARN] ' + args.join(' ') + '\n');
  }

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
    // Floor handler: if the background DB load fails before any tool call awaits
    // dbReady (e.g. the first request is a LOCAL tool, which skips the wait in
    // toolHandler), the rejection would otherwise float and crash the stdio
    // process. Attaching a catch here marks it handled; tool handlers that do
    // await context.dbReady still receive and surface the rejection themselves.
    dbReadyPromise.catch(() => { /* handled — never let it float */ });

    const stubContext: import('./types/context.js').XppServerContext = {
      symbolIndex: stubIndex,
      parser: stubParser,
      workspaceScanner: stubScanner,
      hybridSearch: stubHybrid,
      dbReady: dbReadyPromise,
    };
    const mcpServer = createXppMcpServer(stubContext);

    // Step 2: connect transport — handshake completes here
    // Always wrap stdin with the initialize-params sniffer so we can capture the
    // `initialize` request params (clientInfo, capabilities) for get_workspace_info.
    const transport = new StdioServerTransport(
      createInitializeParamsSniffer() as unknown as typeof process.stdin,
      process.stdout,
    );
    await mcpServer.connect(transport);
    log.ok('Stdio transport connected (DB loading in background)');

    // Step 3: yield the event loop so `initialized` + roots/list can be processed
    // BEFORE the synchronous new Database() call blocks the event loop.
    await new Promise<void>(resolve => setImmediate(resolve));

    // Step 3b: Initialize C# bridge in parallel with DB load (non-blocking)
    // The bridge provides live metadata from Microsoft's IMetadataProvider API
    // and cross-reference queries — only available on Windows VMs with D365FO.
    void initializeBridge(stubContext).then(s => (s.ok ? log.ok(s.summary) : log.warn(s.summary)));

    // Step 4: load real database in the background
    const dbLoadStart = Date.now();
    initializeServices().then(({ symbolIndex, parser, workspaceScanner, hybridSearch }) => {
      // Step 5: patch the context references used by tool handlers
      stubContext.symbolIndex       = symbolIndex;
      stubContext.parser            = parser;
      stubContext.workspaceScanner  = workspaceScanner;
      stubContext.hybridSearch      = hybridSearch;
      serverState.symbolIndex = symbolIndex;
      serverState.parser      = parser;
      serverState.statusMessage = 'Ready';
      // Resolve dbReady AFTER context is patched — tools can now run with real index.
      resolveDbReady();
      log.ok(`Database loaded in ${Date.now() - dbLoadStart} ms — all tools fully operational`);

      // The in-memory stub symbol index is also unreachable once swapped.
      try { stubIndex.close(); } catch { /* ignore */ }
    }).catch(err => {
      rejectDbReady(err);
      console.error(statusLine('err', 'Background initialization failed:'), err);
    });

    // Log tool count immediately (transport is already connected).
    // TOOL_ANNOTATIONS is guaranteed complete by tests/utils/toolInventory.test.ts,
    // so its size tracks the real tool count without a hardcoded literal.
    const totalTools = Object.keys(TOOL_ANNOTATIONS).length;
    const localToolCount = LOCAL_TOOLS.size;
    const toolCount = SERVER_MODE === 'write-only' ? localToolCount :
                     SERVER_MODE === 'read-only' ? totalTools - localToolCount : totalTools;
    const toolDesc = SERVER_MODE === 'write-only' ? `(${Array.from(LOCAL_TOOLS).join(', ')})` :
                    SERVER_MODE === 'read-only' ? '(all except local tools)' :
                    '(2 discovery + 1 labels + 3 object-info + 2 intelligent + 2 smart-gen + 1 file-ops + 1 pattern-analysis + 5 security-ext + 5 sdlc-build + 2 code-review + 2 code-quality)';
    log.ok(`Registered ${toolCount} X++ MCP tools ${toolDesc}`);
    serverState.isReady = true;
    serverState.isHealthy = true;
    serverState.statusMessage = 'Loading database...';
  } else {
    // HTTP mode — bind the port immediately so Azure App Service does not kill
    // the process during the (potentially long) database initialisation phase.
    // The health endpoint returns 503 while the server is starting and 200 once
    // fully ready.  MCP routes are registered dynamically after initializeServices().
    // Branded banner first — connection details are known immediately, before
    // the (potentially long) database load. Symbol counts are intentionally NOT
    // shown here; they appear once during the load (`✓ Loaded … symbols`).
    const host = process.env.HOST || '0.0.0.0';
    const W = 50;
    console.log('');
    for (const line of box([
      spread(c.bold('D365 F&O MCP Server'), c.dim('v1.0.0'), W),
      c.gray('X++ Code Intelligence'),
    ], W)) {
      console.log(line);
    }
    console.log('');
    console.log(kv('Mode', `HTTP ${c.dim(glyph.dot)} ${SERVER_MODE}`));
    console.log(kv('Endpoint', c.cyan(`http://${host}:${PORT}/mcp`)));
    console.log(kv('Health', c.cyan(`http://localhost:${PORT}/health`)));
    console.log(kv('Runtime', `Node ${process.version} ${c.dim(glyph.dot)} pid ${process.pid}`));
    console.log(kv('Database', c.dim(shortPath(DB_PATH))));
    console.log('');

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
        // Cached-only: a health probe must never trigger a 30-60 s COUNT scan.
        symbols: serverState.symbolIndex?.getCachedSymbolCounts()?.total || 0,
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
    await new Promise<void>(resolve => app.listen(PORT, host, () => resolve()));

    // Initialise services in the background; register MCP routes once ready
    initializeServices().then(async ({ mcpServer, symbolIndex, parser, workspaceScanner, hybridSearch, context }) => {
      // Register MCP transport (Express supports dynamic route registration)
      createStreamableHttpTransport(mcpServer, app, { symbolIndex, parser, workspaceScanner, hybridSearch });

      serverState.isReady = true;
      serverState.isHealthy = true;
      serverState.statusMessage = 'Ready';

      console.log('');
      console.log(statusLine('ok', c.green(`Ready in ${process.uptime().toFixed(1)}s`)));

      // C# bridge — await its connection (bounded) so its status prints here, in
      // order, instead of trailing after the tool list. A slow/hung bridge must
      // never block startup, so cap the wait; it keeps connecting in the
      // background afterwards and attaches to the context once ready.
      if (context) {
        const status = await Promise.race<BridgeStatus>([
          initializeBridge(context),
          new Promise<BridgeStatus>(r => setTimeout(
            () => r({ ok: true, summary: 'C# bridge still connecting in the background' + glyph.ellipsis }), 6000)),
        ]);
        if (status.ok) log.ok(status.summary); else log.warn(status.summary);
        if (status.detail) log.detail(status.detail);
      }
      console.log('');

      const toolCatalog = [
        { icon: '🔍', category: 'Search & Discovery', tools: [
          { name: 'search',                       desc: 'Search 584K+ symbols: single, batch (queries[]) or scope=extensions' },
          { name: 'batch_get_info',               desc: 'Get detailed info for up to 10 objects in one parallel call' },
        ]},
        { icon: '🏷️ ', category: 'Label Management', tools: [
          { name: 'labels',                       desc: 'Unified label ops: action=search|info|create|rename (read/write)' },
        ]},
        { icon: '📊', category: 'Advanced Object Info', tools: [
          { name: 'get_object_info',              desc: 'Read any object by objectType: class/table/form/query/view/enum/edt/report/data-entity/menu-item/service/map/config-key/security-policy/macro' },
          { name: 'get_method',                   desc: 'Method signature/source/both via include= (required before CoC extensions)' },
          { name: 'find_references',              desc: 'Where-used analysis across the entire codebase' },
        ]},
        { icon: '🧠', category: 'Intelligent Code Generation', tools: [
          { name: 'get_knowledge',                desc: 'kind=knowledge|error — X++ rulebook/patterns or D365FO error diagnosis' },
          { name: 'analyze_code',                 desc: 'Learn from the codebase: mode=patterns|implementations|completeness|api-usage' },
        ]},
        { icon: '🎨', category: 'Smart Object Generation', tools: [
          { name: 'generate_object',                     desc: 'mode=pattern (named X++ skeleton) | scaffold (whole table/form/report)' },
          { name: 'suggest_edt',                  desc: 'Suggest EDT for field name using fuzzy matching' },
        ]},
        { icon: '📝', category: 'File & Metadata Operations', tools: [
          { name: 'd365fo_file',                  desc: 'action=create|modify|generate — write/edit AOT objects or emit XML (cloud)' },
        ]},
        { icon: '📈', category: 'Pattern Analysis', tools: [
          { name: 'object_patterns',                     desc: 'domain=table|form — table field/index patterns, or form-pattern toolkit (analyze/spec/validate)' },
        ]},
        { icon: '🔐', category: 'Security & Extensions', tools: [
          { name: 'security_info',                desc: 'mode=artifact|coverage — Privilege/Duty/Role chain, or who can access an object' },
          { name: 'extension_info',                desc: 'mode=coc|events|table-merge|points|strategy — CoC/event-handler/extension analysis + strategy advice' },
          { name: 'validate_object_naming',       desc: 'Validate proposed extensions and object names against D365FO conventions' },
          { name: 'get_workspace_info',           desc: 'Detected workspace paths, model name, project file, and server mode' },
          { name: 'verify_d365fo_project',        desc: 'Verify objects exist on disk and are referenced in the .rnrproj project file' },
        ]},
        { icon: '🏗️ ', category: 'SDLC & Build Tools', tools: [
          { name: 'update_symbol_index',          desc: 'Index a newly generated XML file immediately (no restart needed)' },
          { name: 'build_d365fo_project',         desc: 'Run MSBuild compilation locally to capture errors' },
          { name: 'trigger_db_sync',              desc: 'Run a database sync for the current model' },
          { name: 'run_bp_check',                 desc: 'Run Microsoft Best Practices (xppbp.exe) analysis' },
          { name: 'run_systest_class',            desc: 'Execute unit tests using SysTestConsole.exe' },
        ]},
        { icon: '🔄', category: 'Code Review & Source Control', tools: [
          { name: 'review_workspace_changes',     desc: 'AI-based D365FO code review on uncommitted X++ changes (git diff)' },
          { name: 'undo_last_modification',       desc: 'Safely revert last file change: checkout HEAD or delete untracked file' },
        ]},
        { icon: '🧪', category: 'Code Quality & Grounding', tools: [
          { name: 'validate_code',                     desc: 'mode=syntax (offline BP validator, SEL/COC/BP/TTS/XML) | references (semantic symbol resolver vs index)' },
          { name: 'prepare',                      desc: 'Single-call context aggregator + grounding token: mode=change|create' },
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

      // Align tool names into a column (cap so long names don't push descriptions off-screen).
      const nameW = Math.min(
        26,
        Math.max(...filteredCatalog.flatMap(cat => cat.tools.map(t => t.name.length))) + 2,
      );

      console.log(sectionTitle(`Tools (${totalTools})`));
      console.log('');
      for (const cat of filteredCatalog) {
        console.log(`  ${cat.icon} ${c.bold(c.cyan(cat.category))} ${c.dim(`(${cat.tools.length})`)}`);
        for (const t of cat.tools) {
          console.log(`    ${t.name.padEnd(nameW)}${c.dim(t.desc)}`);
        }
        console.log('');
      }

      // End-of-startup recap — surfaces any warnings the long tool list scrolled
      // past, so the operator sees them without scrolling back up.
      if (startupWarnings.length > 0) {
        console.log(statusLine('warn', c.yellow(`${startupWarnings.length} warning${startupWarnings.length > 1 ? 's' : ''} during startup:`)));
        for (const w of startupWarnings) log.detail(w);
        console.log('');
      }
    }).catch((err) => {
      console.error(statusLine('err', 'Initialisation failed:'), err);
      serverState.isHealthy = false;
      serverState.statusMessage = `Initialisation failed: ${err}`;
    });
  }
}

main().catch((error) => {
  console.error(statusLine('err', 'Fatal error:'), error);
  process.exit(1);
});
