/**
 * X++ MCP Code Completion Server
 * Main entry point
 */

// Load configuration onto process.env — MUST stay the first import: ESM
// evaluates imports before any module body, so anything above this line is
// evaluated before the configuration exists (see src/bootstrapEnv.ts).
import './bootstrapEnv.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import express from 'express';
import compression from 'compression';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createXppMcpServer } from './server/mcpServer.js';
import { createStreamableHttpTransport } from './server/transport.js';
import { XppSymbolIndex } from './metadata/symbolIndex.js';
import { shouldWarmIndexes, warmIndexes, renderWarmupReport } from './metadata/indexWarmup.js';
import { canIndexOffThread, indexMetadataOffThread } from './metadata/startupIndexing.js';
import { XppMetadataParser } from './metadata/xmlParser.js';
import { WorkspaceScanner } from './workspace/workspaceScanner.js';
import { HybridSearch } from './workspace/hybridSearch.js';
import { initializeDatabase } from './database/download.js';
import { initializeConfig, getConfigManager } from './utils/configManager.js';
import { SERVER_MODE, LOCAL_TOOLS, TOOL_PROFILE, EXTRA_TOOLS, isToolEnabled } from './server/serverMode.js';
import { TOOL_ANNOTATIONS } from './server/toolAnnotations.js';
import { apiKeyAuth, authStartupError, resolveBindHost } from './middleware/apiKeyAuth.js';
import { VERSION } from './version.js';
import { setInitializeParams } from './utils/stdioSessionInfo.js';
import { setModelObjectNameSource } from './utils/modelPrefixInference.js';
import { trackBridgeStartup } from './bridge/bridgeReadiness.js';
import { startLoopLagMonitor } from './utils/loopLag.js';
import { createShutdownCoordinator } from './utils/gracefulShutdown.js';
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
/** Undoes the stderr tee. Set only while the tee is installed. */
let _restoreStderr: (() => void) | undefined;
if (LOG_FILE) {
  try {
    _logStream = fsSync.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
    // The open is asynchronous, so a bad path (missing directory, no write
    // permission) never reaches the catch below — it arrives here instead, and
    // without a listener an 'error' event on a stream is an uncaught exception.
    _logStream.on('error', (err) => {
      _logStream = undefined;
      _restoreStderr?.();
      process.stderr.write(`[d365fo-mcp] ⚠️ LOG_FILE=${LOG_FILE} unusable, file logging off: ${err}\n`);
    });
    const banner = `\n${'─'.repeat(72)}\n[d365fo-mcp] Started at ${new Date().toISOString()}  pid=${process.pid}\n${'─'.repeat(72)}\n`;
    _logStream.write(banner);
    // Tee: intercept process.stderr so every write also goes to the log file.
    // The mirror is best-effort — stderr itself must keep working even once the
    // stream is gone, because shutdown reports its final progress through it.
    const stderr = process.stderr as NodeJS.WriteStream & { write: (...args: any[]) => boolean };
    const origStderrWrite = stderr.write.bind(process.stderr);
    const teeWrite = function (chunk: any, ...rest: any[]): boolean {
      try {
        _logStream?.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      } catch {
        // A failed mirror must never take the real stderr write down with it.
      }
      return origStderrWrite(chunk, ...rest) as boolean;
    };
    stderr.write = teeWrite;
    _restoreStderr = () => {
      // Only unpatch our own tee — something else may have wrapped stderr since.
      if (stderr.write === teeWrite) stderr.write = origStderrWrite;
      _restoreStderr = undefined;
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
// A throw inside either of these handlers is fatal and unrecoverable — Node has
// no net left to catch it — so the reporting itself is wrapped: the net must not
// be the thing that kills the process it exists to keep alive.
function reportSafely(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    /* nothing left to report through */
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  reportSafely(`[d365fo-mcp] ⚠️ Unhandled promise rejection (server staying up): ${msg}\n`);
});

// Same protection for SYNCHRONOUS uncaught exceptions — a throw that escapes a
// timer/stream/event callback (not an awaited promise) would otherwise stop the
// process outright. For a stdio server that means the MCP client must respawn
// the subprocess after the very first failing request. Log the full stack so the
// root cause is diagnosable, then keep serving. (Genuinely fatal startup errors
// are still surfaced via main().catch → process.exit below.)
process.on('uncaughtException', (err) => {
  reportSafely(`[d365fo-mcp] ⚠️ Uncaught exception (server staying up): ${err?.stack ?? err}\n`);
});

const PORT = parseInt(process.env.PORT || '8080', 10);
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

// Graceful shutdown — see src/utils/gracefulShutdown.ts for why and how.
const shutdownCoordinator = createShutdownCoordinator({
  deadlineMs: Math.max(1_000, parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '5000', 10) || 5_000),
});
const onShutdown = shutdownCoordinator.onShutdown;

async function initializeServices() {
  // Attribution for "the first call took seconds" — off unless DEBUG_LOGGING is
  // set. See src/utils/loopLag.ts for what was measured and what could not be.
  startLoopLagMonitor();

  // -----------------------------------------------------------------------
  // write-only mode: skip all database/symbol work — the LOCAL_TOOLS set
  // (src/server/serverMode.ts; d365fo_file, build_d365fo_project,
  //  verify_d365fo_project, run_bp_check, get_workspace_info, …)
  //  only needs the config manager for path resolution, not the 1.5 GB symbol
  //  database. Read the set from serverMode.ts rather than trusting this list.
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
    // Opening a SQLite database is synchronous — a 1.5 GB file can stall the loop for
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

    // Let object naming learn each model's prefix from the objects that model
    // already contains, instead of applying one configured EXTENSION_PREFIX to
    // every model a developer works in (see utils/modelPrefixInference.ts).
    setModelObjectNameSource(model => symbolIndex.getModelObjectNames(model));

    const parser = new XppMetadataParser();

    // Check if database needs indexing
    if (!dbHasSymbols) {
      log.warn('No symbols found in database — run `npm run index-metadata` first');
      log.detail('or set METADATA_PATH and the server will index on startup');

      // If metadata path exists, index it
      let metadataAccessible = false;
      try {
        await fs.access(METADATA_PATH);
        metadataAccessible = true;
      } catch {
        log.warn('Metadata path not accessible — starting with empty index');
      }
      if (metadataAccessible) {
        log.step(`Indexing metadata from ${METADATA_PATH}` + glyph.ellipsis);
        serverState.statusMessage = 'Indexing metadata...';
        const modelNamesStr = process.env.CUSTOM_MODELS || 'CustomModel';
        const modelNames = modelNamesStr.split(',').map(m => m.trim()).filter(Boolean);
        log.detail(`model names: ${modelNames.join(', ')}`);

        // Single pass over all requested models — the FTS index is rebuilt once at the
        // end of the call, so looping per model would repeat a full-table rebuild.
        log.detail(`indexing ${modelNames.join(', ')}` + glyph.ellipsis);
        try {
          if (canIndexOffThread(DB_PATH, LABELS_DB_PATH)) {
            // On a worker thread: the build is synchronous end to end, and inline
            // it blocked the event loop for its whole duration — every tool call,
            // get_workspace_info included, hung until it finished. dbReady is still
            // held until it completes, so symbol-backed tools keep answering "still
            // loading" rather than returning empty results; the loop stays free.
            const { elapsedMs } = await indexMetadataOffThread({
              dbPath: DB_PATH,
              labelsDbPath: LABELS_DB_PATH,
              metadataPath: METADATA_PATH,
              modelNames,
              output: process.stderr,
            });
            log.detail(`indexed in ${(elapsedMs / 1000).toFixed(1)}s on a worker thread`);
          } else {
            await symbolIndex.indexMetadataDirectory(METADATA_PATH, modelNames);
          }
          log.ok(`Indexed ${symbolIndex.getSymbolCount().toLocaleString('en-US')} symbols from ${modelNames.length} model(s)`);
        } catch (error) {
          log.warn(`Metadata indexing failed — starting with empty index: ${error}`);
          log.detail('run `npm run index-metadata` to build the database');
        }
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

      // Read the indexes the request paths use, on a thread of their own, before
      // anyone asks a question that needs them. Measured on the reference VM:
      // the first covering scan of idx_symbols_name costs 83 s cold and 0.11 s
      // warm, and the labels join behind every label search costs 31 s cold —
      // which is most of what the benchmark's tool time has ever been. The OS
      // page cache is process-wide, so a worker warms it for the main thread's
      // own connections. Never awaited: an unfinished warm-up just leaves the
      // first query paying for the part not yet read, exactly as it does today.
      if (shouldWarmIndexes(DB_PATH, LABELS_DB_PATH)) {
        void warmIndexes({ dbPath: DB_PATH, labelsDbPath: LABELS_DB_PATH })
          .then(report => { log.detail(renderWarmupReport(report)); })
          .catch(err => { log.detail(`Index warm-up skipped: ${err}`); });
      }
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
      // dispose() ends the child's stdin and escalates to SIGTERM/SIGKILL, so the
      // bridge gets the chance to finish an in-flight AOT write and close its own
      // metadata handles rather than being cut off mid-file.
      onShutdown('C# bridge', () => bridge.dispose());
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
  // Registered first so it runs LAST (cleanups run in reverse): the log file is
  // where the other steps report, so it has to outlive them.
  onShutdown('log file', () => {
    // Unpatch before closing: the coordinator still writes "[shutdown] done"
    // after this cleanup returns, and that write must not touch a closed stream.
    _restoreStderr?.();
    if (_logStream) {
      _logStream.end();
      _logStream = undefined;
    }
  });
  // Covers whichever index ended up in serverState — the real one, the in-memory
  // stub, or the replacement built after a corrupt-DB recovery.
  onShutdown('symbol index', () => serverState.symbolIndex?.close?.());
  shutdownCoordinator.registerSignalHandlers({ stdio: isStdioMode });

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
    // The attempt is tracked on the context so bridge-backed tools called in the
    // first seconds wait for it instead of reporting a phantom "not connected".
    stubContext.bridgeStartup = trackBridgeStartup(
      initializeBridge(stubContext).then(s => (s.ok ? log.ok(s.summary) : log.warn(s.summary))),
    );

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
    const toolCount = Object.keys(TOOL_ANNOTATIONS).filter(name => isToolEnabled(name)).length;
    const toolDesc = SERVER_MODE === 'write-only' ? `(${Array.from(LOCAL_TOOLS).join(', ')})` :
                    SERVER_MODE === 'read-only' ? '(all except local tools)' :
                    TOOL_PROFILE === 'core' ? `(core profile${EXTRA_TOOLS.size ? ` + ${EXTRA_TOOLS.size} extra` : ''}; MCP_TOOL_PROFILE=full for all ${Object.keys(TOOL_ANNOTATIONS).length})` :
                    '(1 discovery + 1 labels + 3 object-info + 2 intelligent + 2 smart-gen + 1 file-ops + 1 pattern-analysis + 5 security-ext + 5 sdlc-build + 2 code-review + 2 code-quality)';
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
    // Fail closed before anything binds: a network-reachable listener with no
    // API_KEY would serve the whole read surface to anonymous callers.
    const authError = authStartupError();
    if (authError) {
      console.error('');
      console.error(authError);
      console.error('');
      process.exit(1);
    }

    // Not `process.env.HOST || '0.0.0.0'` — with no key configured the default
    // is loopback, so forgetting the key costs reachability, not secrecy.
    const host = resolveBindHost();
    const W = 50;
    console.log('');
    for (const line of box([
      spread(c.bold('D365 F&O MCP Server'), c.dim(`v${VERSION}`), W),
      c.gray('X++ Code Intelligence'),
    ], W)) {
      console.log(line);
    }
    console.log('');
    console.log(kv('Mode', `HTTP ${c.dim(glyph.dot)} ${SERVER_MODE}`));
    // Three states, and the guard above has already ruled out the fourth
    // (no key on a public interface), so "none" here always means loopback.
    console.log(kv('Auth', process.env.API_KEY?.trim()
      ? `API key ${c.dim(glyph.dot)} X-Api-Key`
      : process.env.ALLOW_UNAUTHENTICATED === 'true'
        ? c.yellow(`delegated upstream ${c.dim(glyph.dot)} nothing is checked here`)
        : `none ${c.dim(glyph.dot)} ${c.dim('loopback only, not reachable from the network')}`));
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
        version: VERSION,
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
    const httpServer = await new Promise<import('http').Server>(resolve => {
      const s = app.listen(PORT, host, () => resolve(s));
    });
    // Stop accepting new connections and let in-flight requests finish. Bounded
    // by the shutdown deadline, so a held-open keep-alive socket cannot stall the
    // exit.
    onShutdown('HTTP server', () => new Promise<void>(resolve => httpServer.close(() => resolve())));

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
        const attempt = initializeBridge(context);
        // Tracked before the bounded race below, so a bridge that is still
        // connecting when the banner gives up is still awaited by tool calls.
        context.bridgeStartup = trackBridgeStartup(attempt);
        const status = await Promise.race<BridgeStatus>([
          attempt,
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
        ]},
        { icon: '🏷️ ', category: 'Label Management', tools: [
          { name: 'labels',                       desc: 'Unified label ops: action=search|info|create|rename (read/write)' },
        ]},
        { icon: '📊', category: 'Advanced Object Info', tools: [
          { name: 'get_object_info',              desc: 'Read one object (objectType, name) or many in one call (objects[]): class/table/form/query/view/enum/edt/report/data-entity/menu-item/service/map/config-key/security-policy/macro' },
          { name: 'find_references',              desc: 'Where-used analysis across the entire codebase' },
        ]},
        { icon: '🧠', category: 'Intelligent Code Generation', tools: [
          { name: 'get_knowledge',                desc: 'kind=knowledge|error — X++ rulebook/patterns or D365FO error diagnosis' },
          { name: 'analyze_code',                 desc: 'Learn from the codebase: mode=patterns|implementations|completeness|api-usage' },
        ]},
        { icon: '🎨', category: 'Smart Object Generation', tools: [
          { name: 'generate_object',                     desc: 'mode=pattern (named X++ skeleton) | scaffold (whole table/form/report)' },
        ]},
        { icon: '📝', category: 'File & Metadata Operations', tools: [
          { name: 'd365fo_file',                  desc: 'action=create|modify|delete|undo|generate — write/edit/roll back AOT objects or emit XML (cloud)' },
        ]},
        { icon: '📈', category: 'Pattern Analysis', tools: [
          { name: 'object_patterns',                     desc: 'domain=table|form — table field/index patterns, or form-pattern toolkit (analyze/spec/validate)' },
        ]},
        { icon: '🔐', category: 'Security & Extensions', tools: [
          { name: 'security_info',                desc: 'mode=artifact|coverage — Privilege/Duty/Role chain, or who can access an object' },
          { name: 'extension_info',                desc: 'mode=coc|events|table-merge|points|strategy — CoC/event-handler/extension analysis + strategy advice' },
          { name: 'validate_object_naming',       desc: 'Validate proposed extensions and object names against D365FO conventions' },
          { name: 'get_workspace_info',           desc: 'Detected workspace paths, model name, project file, and server mode; changes=true returns the uncommitted git diff' },
          { name: 'verify_d365fo_project',        desc: 'Verify objects exist on disk and are referenced in the .rnrproj project file' },
        ]},
        { icon: '🏗️ ', category: 'SDLC & Build Tools', tools: [
          { name: 'update_symbol_index',          desc: 'Re-index a file changed outside this server (create/modify refresh it themselves)' },
          { name: 'build_d365fo_project',         desc: 'Compile the model locally; bpCheck/dbSync fold the BP check and the database sync into the same call' },
          { name: 'run_bp_check',                 desc: 'Run Microsoft Best Practices (xppbp.exe) analysis' },
          { name: 'run_systest_class',            desc: 'Execute unit tests using SysTestConsole.exe' },
        ]},
        { icon: '🧪', category: 'Code Quality & Grounding', tools: [
          { name: 'validate_code',                     desc: 'mode=syntax (offline BP validator, SEL/COC/BP/TTS/XML) | references (semantic symbol resolver vs index)' },
          { name: 'prepare',                      desc: 'Single-call context aggregator + grounding token: mode=change|create' },
        ]},
      ];

      const filteredCatalog = toolCatalog
        .map(cat => ({
          ...cat,
          // Same predicate as the ListTools filter and runtime gate, so the
          // startup banner matches what the server actually exposes.
          tools: cat.tools.filter(t => isToolEnabled(t.name)),
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
