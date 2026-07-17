/**
 * BridgeClient — Manages the C# D365MetadataBridge child process.
 *
 * Protocol: newline-delimited JSON-RPC over stdin/stdout.
 * Stderr: diagnostics/logging (forwarded to console.error).
 *
 * Lifecycle:
 *   1. `initialize()` — spawns the .exe, waits for "ready" JSON
 *   2. `call(method, params)` — sends a request, returns promise of response
 *   3. `dispose()` — kills the child process
 *
 * The client is designed to be a singleton field on XppServerContext.
 * It is only initialized when running on a Windows VM with D365FO installed.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type {
  BridgeResponse,
  BridgeReadyPayload,
  BridgeInfoPayload,
  BridgeTableInfo,
  BridgeClassInfo,
  BridgeEnumInfo,
  BridgeEdtInfo,
  BridgeFormInfo,
  BridgeQueryInfo,
  BridgeViewInfo,
  BridgeDataEntityInfo,
  BridgeReportInfo,
  BridgeReferenceResult,
  BridgeSearchResult,
  BridgeMethodSource,
  BridgeListResult,
  BridgeValidateResult,
  BridgeResolveResult,
  BridgeRefreshResult,
  BridgeWriteResult,
  BridgeSmartTableResult,
  BridgeBatchOperationRequest,
  BridgeBatchOperationResult,
  BridgeCapabilities,
  BridgeFormPatternDiscoveryResult,
  BridgeSecurityPrivilegeResult,
  BridgeSecurityDutyResult,
  BridgeSecurityRoleResult,
  BridgeMenuItemResult,
  BridgeTableExtensionListResult,
  BridgeCompletionResult,
  BridgeExtensionClassResult,
  BridgeEventSubscriberResult,
  BridgeApiUsageCallersResult,
} from './bridgeTypes.js';

// Re-export types for convenience
export type { BridgeReadyPayload, BridgeInfoPayload } from './bridgeTypes.js';
export * from './bridgeTypes.js';

const BRIDGE_EXE_NAME = 'D365MetadataBridge.exe';

/** Parse a positive-integer env var with a fallback (ignores invalid/non-positive values). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like envInt but accepts 0 (used by knobs where 0 means "disabled"). */
function envIntZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Configurable via env so large installations / slow VMs can raise the limits.
const READY_TIMEOUT_MS = envInt('BRIDGE_READY_TIMEOUT_MS', 30_000); // 30s for metadata provider init
const CALL_TIMEOUT_MS = envInt('BRIDGE_CALL_TIMEOUT_MS', 60_000);   // 60s per call (large searches can take time)
const MAX_RETRIES = envIntZero('BRIDGE_MAX_RETRIES', 2);            // retries for READ calls only (0 = disabled)
const HEALTHCHECK_MS = envIntZero('BRIDGE_HEALTHCHECK_MS', 0);      // idle ping interval (0 = disabled)
const MAX_RESTARTS = envInt('BRIDGE_MAX_RESTARTS', 3);              // max child respawns per minute
const RESTART_WINDOW_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;
const RETRY_BASE_DELAY_MS = 250;

/**
 * Methods safe to auto-retry on timeout/pipe error: idempotent READS only.
 * Writes (create/modify/delete/batch/refresh) must NEVER be retried — the
 * operation may have already applied on the bridge side before the timeout fired.
 */
const RETRYABLE_METHODS = new Set([
  'ping', 'getInfo', 'getCapabilities',
  'readTable', 'readClass', 'readEnum', 'readEdt', 'readForm', 'readQuery',
  'readView', 'readDataEntity', 'readReport', 'readSecurityPrivilege',
  'readSecurityDuty', 'readSecurityRole', 'readMenuItem', 'readTableExtensions',
  'getMethodSource', 'searchObjects', 'listObjects', 'findReferences',
  'getCompletionMembers', 'findExtensionClasses', 'findEventSubscribers',
  'findApiUsageCallers', 'resolveObjectInfo', 'validateObject', 'discoverFormPatterns',
]);

/** Errors that indicate a transient transport problem (vs. a deterministic bridge error). */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('timed out') ||
    msg.includes('Bridge is not ready') ||
    msg.includes('exited unexpectedly') ||
    msg.includes('Bridge process error') ||
    msg.includes('Failed to write to bridge stdin') ||
    msg.includes('Bridge restarting')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface BridgeClientOptions {
  /** Path to the D365MetadataBridge.exe (auto-detected if omitted) */
  bridgeExePath?: string;
  /** K:\AosService\PackagesLocalDirectory */
  packagesPath: string;
  /**
   * Optional secondary packages path.
   * UDE: Microsoft FrameworkDirectory (e.g. %LOCALAPPDATA%\Microsoft\Dynamics365\{ver}\PackagesLocalDirectory).
   * When provided the bridge initialises a second DiskProvider and transparently falls back to it
   * for any object not found in the primary path — so both custom and Microsoft-shipped metadata
   * resolve correctly without having to choose one path over the other.
   */
  referencePackagesPath?: string;
  /**
   * Explicit path to the D365FO bin directory containing Microsoft.Dynamics.*.dll.
   * Traditional: omit — defaults to {packagesPath}/bin.
   * UDE: set to microsoftPackagesPath/bin (the FrameworkDirectory bin folder).
   */
  binPath?: string;
  /** SQL Server instance for cross-references (default: localhost) */
  xrefServer?: string;
  /** XRef database name (default: DYNAMICSXREFDB) */
  xrefDatabase?: string;
  /** Timeout for the ready signal in ms */
  readyTimeoutMs?: number;
  /** Timeout for each RPC call in ms */
  callTimeoutMs?: number;
  /** Path to a log file for bridge diagnostics (append mode) */
  logFile?: string;
  /** Max automatic retries for READ calls on timeout/pipe error (default: BRIDGE_MAX_RETRIES env or 2) */
  maxRetries?: number;
  /** Idle ping interval in ms, 0 = disabled (default: BRIDGE_HEALTHCHECK_MS env or 0) */
  healthcheckMs?: number;
  /** Max child respawns per 60s before giving up (default: BRIDGE_MAX_RESTARTS env or 3) */
  maxRestarts?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private readyPayload: BridgeReadyPayload | null = null;
  private _isReady = false;
  private _disposed = false;
  private restartPromise: Promise<void> | null = null;
  private restartTimestamps: number[] = [];
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  public readonly options: BridgeClientOptions;

  constructor(options: BridgeClientOptions) {
    super();
    this.options = options;
  }

  /** Whether the bridge process is running and the metadata provider initialized */
  get isReady(): boolean { return this._isReady && !this._disposed; }

  /** Whether the MS metadata API is available (set after ready) */
  get metadataAvailable(): boolean { return this.readyPayload?.metadataAvailable ?? false; }

  /** Whether the cross-reference DB is available (set after ready) */
  get xrefAvailable(): boolean { return this.readyPayload?.xrefAvailable ?? false; }

  /** The ready payload from the bridge process */
  get ready(): BridgeReadyPayload | null { return this.readyPayload; }

  // Lifecycle

  /**
   * Spawn the C# bridge process and wait for the "ready" message.
   * Resolves with the BridgeReadyPayload on success.
   * Rejects if the process fails to start or doesn't send ready in time.
   */
  async initialize(): Promise<BridgeReadyPayload> {
    if (this._disposed) throw new Error('BridgeClient has been disposed');
    if (this._isReady) return this.readyPayload!;

    const payload = await this.spawnAndWaitReady();
    this.startHealthcheck();
    return payload;
  }

  /** Spawn the child process and wait for its "ready" message. Used by initialize() and restart(). */
  private async spawnAndWaitReady(): Promise<BridgeReadyPayload> {
    const exePath = this.resolveBridgeExe();
    const args = [
      '--packages-path', this.options.packagesPath,
    ];
    if (this.options.referencePackagesPath) {
      args.push('--reference-packages-path', this.options.referencePackagesPath);
    }
    if (this.options.binPath) {
      args.push('--bin-path', this.options.binPath);
    }
    if (this.options.xrefServer) {
      args.push('--xref-server', this.options.xrefServer);
    }
    if (this.options.xrefDatabase) {
      args.push('--xref-database', this.options.xrefDatabase);
    }
    if (this.options.logFile) {
      args.push('--log-file', this.options.logFile);
    }

    console.error(`[BridgeClient] Spawning: ${exePath} ${args.join(' ')}`);

    return new Promise<BridgeReadyPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Kill only the child; the client stays usable for a later restart()/dispose().
        this.killChild();
        reject(new Error(`Bridge process did not become ready within ${this.options.readyTimeoutMs ?? READY_TIMEOUT_MS}ms`));
      }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);

      try {
        this.process = spawn(exePath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn bridge: ${err}`));
        return;
      }

      // Capture the child so late events from a replaced (restarted) process cannot
      // corrupt the state of its successor.
      const child = this.process;

      // Streams can emit EPIPE/ECONNRESET if the child dies mid-write. Without a
      // listener that throws as an uncaughtException and kills the whole server, so
      // just log it; recovery is handled by the child's 'error'/'exit' handlers below.
      const onStreamError = (where: string) => (err: Error) => {
        console.error(`[BridgeClient] ${where} stream error: ${err.message}`);
      };
      child.stdin?.on('error', onStreamError('stdin'));
      child.stdout?.on('error', onStreamError('stdout'));
      child.stderr?.on('error', onStreamError('stderr'));

      // Handle stdout — newline-delimited JSON
      child.stdout!.on('data', (chunk: Buffer) => {
        if (this.process !== child) return;
        this.buffer += chunk.toString('utf8');
        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.substring(0, newlineIdx).trim();
          this.buffer = this.buffer.substring(newlineIdx + 1);
          if (!line) continue;

          try {
            const msg: BridgeResponse = JSON.parse(line);

            // Handle the initial "ready" message
            if (msg.id === 'ready' && msg.result) {
              clearTimeout(timeout);
              this.readyPayload = msg.result as BridgeReadyPayload;
              this._isReady = true;
              console.error(`[BridgeClient] Ready: metadata=${this.readyPayload.metadataAvailable}, xref=${this.readyPayload.xrefAvailable}`);
              this.emit('ready', this.readyPayload);
              resolve(this.readyPayload);
              return;
            }

            // Handle RPC responses
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              clearTimeout(pending.timer);
              if (msg.error) {
                // -32001 "not found" from a read is a normal negative result (T | null),
                // not a failure; the write path's -32001 keeps a distinct message and rejects.
                if (msg.error.code === -32001 && /not found/i.test(msg.error.message ?? '')) {
                  pending.resolve(null);
                } else {
                  pending.reject(new Error(`Bridge error [${msg.error.code}]: ${msg.error.message}`));
                }
              } else {
                pending.resolve(msg.result);
              }
            }
          } catch (parseErr) {
            console.error(`[BridgeClient] Failed to parse line: ${line.substring(0, 200)}`);
          }
        }
      });

      // Forward stderr for diagnostics
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // With a log file configured, forward all stderr lines; otherwise only errors/warnings.
            if (this.options.logFile ||
                trimmed.includes('[ERROR]') || trimmed.includes('[WARN]')) {
              console.error(`[Bridge] ${trimmed}`);
            }
          }
        }
      });

      child.on('error', (err) => {
        if (this.process !== child) return;
        clearTimeout(timeout);
        this._isReady = false;
        console.error(`[BridgeClient] Process error: ${err.message}`);
        this.rejectAllPending(new Error(`Bridge process error: ${err.message}`));
        reject(err);
      });

      child.on('exit', (code, signal) => {
        if (this.process !== child) return;
        clearTimeout(timeout);
        this._isReady = false;
        console.error(`[BridgeClient] Process exited: code=${code}, signal=${signal}`);
        const exitErr = new Error(`Bridge process exited before becoming ready: code=${code}, signal=${signal}`);
        this.rejectAllPending(exitErr);
        reject(exitErr);
      });
    });
  }

  /**
   * Send a JSON-RPC call to the bridge and return the result.
   * Rejects if bridge is not ready, the call times out, or the bridge returns an error.
   *
   * READ methods (RETRYABLE_METHODS) are transparently retried on transient
   * transport failures — timeout, dead pipe, child exit — with jittered
   * exponential backoff and a health-checked restart of the child in between.
   * Write methods are never retried: a timed-out write may have already
   * applied on the bridge side, and replaying it could duplicate the operation.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const maxRetries = RETRYABLE_METHODS.has(method) ? (this.options.maxRetries ?? MAX_RETRIES) : 0;

    for (let attempt = 0; ; attempt++) {
      try {
        if (this.restartPromise) await this.restartPromise;
        return await this.callOnce<T>(method, params);
      } catch (err) {
        if (attempt >= maxRetries || this._disposed || !isTransientError(err)) {
          throw err;
        }
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 100);
        console.error(
          `[BridgeClient] Read call '${method}' failed (${err instanceof Error ? err.message : err}) — ` +
          `retry ${attempt + 1}/${maxRetries} in ${delay}ms`
        );
        await sleep(delay);
        await this.ensureHealthy();
      }
    }
  }

  /** Single-shot RPC send with no retry. */
  private callOnce<T>(method: string, params: Record<string, unknown>, timeoutOverrideMs?: number): Promise<T> {
    if (!this._isReady || this._disposed || !this.process?.stdin?.writable) {
      return Promise.reject(new Error('Bridge is not ready'));
    }

    const id = String(++this.requestId);
    const request = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = timeoutOverrideMs ?? this.options.callTimeoutMs ?? CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.process!.stdin!.write(request, 'utf8', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`Failed to write to bridge stdin: ${err.message}`));
        }
      });
    });
  }

  /**
   * Verify the child is alive and responding; respawn it if not.
   * Called between read-retry attempts and from the idle health-check.
   */
  private async ensureHealthy(): Promise<void> {
    if (this._disposed) throw new Error('BridgeClient disposed');

    if (this.processAlive()) {
      try {
        await this.callOnce<string>('ping', {}, PING_TIMEOUT_MS);
        return;
      } catch {
        // alive but wedged — fall through to restart
      }
    }
    await this.restart();
  }

  private processAlive(): boolean {
    return this._isReady && this.process !== null && this.process.exitCode === null;
  }

  /**
   * Tear down the current child and spawn a fresh one. Concurrent callers
   * share a single in-flight restart. Capped at maxRestarts per 60s to avoid
   * crash loops — past the cap the error tells the user where to look.
   */
  async restart(): Promise<BridgeReadyPayload> {
    if (this._disposed) throw new Error('BridgeClient disposed');

    if (this.restartPromise) {
      await this.restartPromise;
      return this.readyPayload!;
    }

    const now = Date.now();
    const maxRestarts = this.options.maxRestarts ?? MAX_RESTARTS;
    this.restartTimestamps = this.restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= maxRestarts) {
      throw new Error(
        `Bridge child restarted ${maxRestarts}x within ${RESTART_WINDOW_MS / 1000}s and keeps failing — giving up. ` +
        `Check the bridge log (D365FO_BRIDGE_LOG_FILE) for the underlying crash.`
      );
    }
    this.restartTimestamps.push(now);

    this.restartPromise = (async () => {
      console.error('[BridgeClient] Restarting bridge child process…');
      this.rejectAllPending(new Error('Bridge restarting'));
      this.killChild();
      this._isReady = false;
      this.readyPayload = null;
      this.buffer = '';
      await this.spawnAndWaitReady();
      console.error('[BridgeClient] Bridge child restarted successfully');
    })();

    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
    return this.readyPayload!;
  }

  /** Periodic idle ping (BRIDGE_HEALTHCHECK_MS > 0) — proactively respawns a dead/wedged child. */
  private startHealthcheck(): void {
    const intervalMs = this.options.healthcheckMs ?? HEALTHCHECK_MS;
    if (!intervalMs || this.healthTimer) return;

    this.healthTimer = setInterval(() => {
      if (this._disposed || this.restartPromise) return;
      // Skip when calls are in flight — they detect failures themselves.
      if (this.pending.size > 0) return;
      void this.ensureHealthy().catch((err) => {
        console.error(`[BridgeClient] Health-check failed: ${err instanceof Error ? err.message : err}`);
      });
    }, intervalMs);
    if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref();
  }

  /** Gracefully shut down the bridge process */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._isReady = false;

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.rejectAllPending(new Error('BridgeClient disposed'));
    this.killChild();
  }

  /** Kill the current child process (used by dispose and restart). */
  private killChild(): void {
    // Capture the reference before clearing this.process so the deferred SIGTERM closure retains it.
    const child = this.process;
    this.process = null;
    if (child) {
      try {
        child.stdin?.end();
        const graceful = setTimeout(() => {
          if (!child.killed) {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
          }
        }, 2000);
        // SIGKILL fallback if SIGTERM did not terminate within another 3s.
        const hard = setTimeout(() => {
          if (!child.killed) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }
        }, 5000);
        if (typeof graceful.unref === 'function') graceful.unref();
        if (typeof hard.unref === 'function') hard.unref();
      } catch { /* ignore */ }
    }
  }

  // ========================================
  // Typed convenience methods
  // ========================================

  async ping(): Promise<string> {
    return this.call<string>('ping');
  }

  async readTable(tableName: string): Promise<BridgeTableInfo | null> {
    return this.call<BridgeTableInfo | null>('readTable', { tableName });
  }

  async readClass(className: string): Promise<BridgeClassInfo | null> {
    return this.call<BridgeClassInfo | null>('readClass', { className });
  }

  async readEnum(enumName: string): Promise<BridgeEnumInfo | null> {
    return this.call<BridgeEnumInfo | null>('readEnum', { enumName });
  }

  async readEdt(edtName: string): Promise<BridgeEdtInfo | null> {
    return this.call<BridgeEdtInfo | null>('readEdt', { edtName });
  }

  async readForm(formName: string): Promise<BridgeFormInfo | null> {
    return this.call<BridgeFormInfo | null>('readForm', { formName });
  }

  async readQuery(queryName: string): Promise<BridgeQueryInfo | null> {
    return this.call<BridgeQueryInfo | null>('readQuery', { queryName });
  }

  async readView(viewName: string): Promise<BridgeViewInfo | null> {
    return this.call<BridgeViewInfo | null>('readView', { viewName });
  }

  async readDataEntity(entityName: string): Promise<BridgeDataEntityInfo | null> {
    return this.call<BridgeDataEntityInfo | null>('readDataEntity', { entityName });
  }

  async readReport(reportName: string): Promise<BridgeReportInfo | null> {
    return this.call<BridgeReportInfo | null>('readReport', { reportName });
  }

  async getMethodSource(className: string, methodName: string): Promise<BridgeMethodSource> {
    return this.call<BridgeMethodSource>('getMethodSource', { className, methodName });
  }

  async searchObjects(query: string, objectType?: string, maxResults?: number): Promise<BridgeSearchResult> {
    const params: Record<string, unknown> = { query };
    if (objectType) params.objectType = objectType;
    if (maxResults != null) params.maxResults = maxResults;
    return this.call<BridgeSearchResult>('searchObjects', params);
  }

  async listObjects(type: string): Promise<BridgeListResult> {
    return this.call<BridgeListResult>('listObjects', { type });
  }

  async findReferences(targetName: string, targetType?: string): Promise<BridgeReferenceResult> {
    const params: Record<string, unknown> = { targetName };
    if (targetType) params.targetType = targetType;
    return this.call<BridgeReferenceResult>('findReferences', params);
  }

  // Security, Menu Items, Table Extensions, Completion, Xref

  async readSecurityPrivilege(name: string): Promise<BridgeSecurityPrivilegeResult | null> {
    return this.call<BridgeSecurityPrivilegeResult | null>('readSecurityPrivilege', { name });
  }

  async readSecurityDuty(name: string): Promise<BridgeSecurityDutyResult | null> {
    return this.call<BridgeSecurityDutyResult | null>('readSecurityDuty', { name });
  }

  async readSecurityRole(name: string): Promise<BridgeSecurityRoleResult | null> {
    return this.call<BridgeSecurityRoleResult | null>('readSecurityRole', { name });
  }

  async readMenuItem(name: string, itemType?: string): Promise<BridgeMenuItemResult | null> {
    const params: Record<string, unknown> = { name };
    if (itemType) params.itemType = itemType;
    return this.call<BridgeMenuItemResult | null>('readMenuItem', params);
  }

  async readTableExtensions(baseTableName: string): Promise<BridgeTableExtensionListResult | null> {
    return this.call<BridgeTableExtensionListResult | null>('readTableExtensions', { baseTableName });
  }

  async getCompletionMembers(symbolName: string): Promise<BridgeCompletionResult | null> {
    return this.call<BridgeCompletionResult | null>('getCompletionMembers', { symbolName });
  }

  async findExtensionClasses(baseClassName: string): Promise<BridgeExtensionClassResult | null> {
    return this.call<BridgeExtensionClassResult | null>('findExtensionClasses', { baseClassName });
  }

  async findEventSubscribers(
    targetName: string,
    eventName?: string,
    handlerType?: string,
  ): Promise<BridgeEventSubscriberResult | null> {
    const params: Record<string, unknown> = { targetName };
    if (eventName) params.eventName = eventName;
    if (handlerType) params.handlerType = handlerType;
    return this.call<BridgeEventSubscriberResult | null>('findEventSubscribers', params);
  }

  async findApiUsageCallers(apiName: string, limit?: number): Promise<BridgeApiUsageCallersResult | null> {
    const params: Record<string, unknown> = { apiName };
    if (limit) params.limit = limit;
    return this.call<BridgeApiUsageCallersResult | null>('findApiUsageCallers', params);
  }

  async getInfo(): Promise<BridgeInfoPayload> {
    return this.call<BridgeInfoPayload>('getInfo');
  }

  // Write-support methods

  /** Re-create the DiskProvider so newly written files are picked up. */
  async refreshProvider(): Promise<BridgeRefreshResult> {
    return this.call<BridgeRefreshResult>('refreshProvider');
  }

  /** Ask IMetadataProvider to read back an object — validates the XML is consumable. */
  async validateObject(objectType: string, objectName: string): Promise<BridgeValidateResult> {
    return this.call<BridgeValidateResult>('validateObject', { objectType, objectName });
  }

  /** Check if an object exists in IMetadataProvider and return its model. */
  async resolveObjectInfo(objectType: string, objectName: string): Promise<BridgeResolveResult | null> {
    return this.call<BridgeResolveResult | null>('resolveObjectInfo', { objectType, objectName });
  }

  // Write operations

  /** Create a D365FO object via IMetadataProvider.Create() */
  async createObject(params: {
    objectType: string;
    objectName: string;
    modelName: string;
    declaration?: string;
    methods?: { name: string; source?: string }[];
    fields?: Record<string, unknown>[];
    fieldGroups?: Record<string, unknown>[];
    indexes?: Record<string, unknown>[];
    relations?: Record<string, unknown>[];
    values?: Record<string, unknown>[];
    properties?: Record<string, string>;
  }): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('createObject', params);
  }

  /**
   * Create a smart table via C# CreateSmartTable — all BP-smart defaults
   * (CacheLookup, FieldGroups, DeleteActions, TitleField, indexes) are auto-set in C#.
   */
  async createSmartTable(params: {
    objectName: string;
    modelName: string;
    tableGroup?: string;
    tableType?: string;
    label?: string;
    fields?: Record<string, unknown>[];
    extraFieldGroups?: Record<string, unknown>[];
    indexes?: Record<string, unknown>[];
    relations?: Record<string, unknown>[];
    methods?: { name: string; source?: string }[];
    extraProperties?: Record<string, string>;
  }): Promise<BridgeSmartTableResult> {
    return this.call<BridgeSmartTableResult>('createSmartTable', params);
  }

  /** Add or replace a method on a class or table via IMetadataProvider.Update() */
  async addMethod(objectType: string, objectName: string, methodName: string, sourceCode: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addMethod', { objectType, objectName, methodName, sourceCode });
  }

  /** Add a field to a table via IMetadataProvider.Update() */
  async addField(objectName: string, fieldName: string, fieldType: string, edt?: string, mandatory?: boolean, label?: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addField', { objectName, fieldName, fieldType, edt, mandatory, label });
  }

  /** Set a property on any object via IMetadataProvider.Update() */
  async setProperty(objectType: string, objectName: string, propertyPath: string, propertyValue: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('setProperty', { objectType, objectName, propertyPath, propertyValue });
  }

  /** Replace code within a method via IMetadataProvider.Update() */
  async replaceCode(objectType: string, objectName: string, methodName: string | undefined, oldCode: string, newCode: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('replaceCode', { objectType, objectName, methodName, oldCode, newCode });
  }

  /** Remove a method from a class, table, form, query, or view */
  async removeMethod(objectType: string, objectName: string, methodName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('removeMethod', { objectType, objectName, methodName });
  }

  /** Add an index to a table */
  async addIndex(tableName: string, indexName: string, fields?: string[], allowDuplicates?: boolean, alternateKey?: boolean): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addIndex', { objectName: tableName, indexName, fields, allowDuplicates, alternateKey });
  }

  /** Remove an index from a table */
  async removeIndex(tableName: string, indexName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('removeIndex', { objectName: tableName, indexName });
  }

  /** Add a relation to a table */
  async addRelation(tableName: string, relationName: string, relatedTable: string, constraints?: Array<{ field?: string; relatedField?: string }>): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addRelation', { objectName: tableName, relationName, relatedTable, constraints });
  }

  /** Remove a relation from a table */
  async removeRelation(tableName: string, relationName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('removeRelation', { objectName: tableName, relationName });
  }

  /** Add a field group to a table */
  async addFieldGroup(tableName: string, groupName: string, label?: string, fields?: string[]): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addFieldGroup', { objectName: tableName, fieldGroupName: groupName, label, fields });
  }

  /** Remove a field group from a table */
  async removeFieldGroup(tableName: string, groupName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('removeFieldGroup', { objectName: tableName, fieldGroupName: groupName });
  }

  /** Add a field reference to an existing field group */
  async addFieldToFieldGroup(tableName: string, groupName: string, fieldName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addFieldToFieldGroup', { objectName: tableName, fieldGroupName: groupName, fieldName });
  }

  /** Modify properties of an existing field on a table */
  async modifyField(tableName: string, fieldName: string, properties?: Record<string, string>): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('modifyField', { objectName: tableName, fieldName, properties });
  }

  /** Rename a field on a table (also fixes index/fieldgroup/TitleField refs) */
  async renameField(tableName: string, oldName: string, newName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('renameField', { objectName: tableName, fieldName: oldName, fieldNewName: newName });
  }

  /** Remove a field from a table */
  async removeField(tableName: string, fieldName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('removeField', { objectName: tableName, fieldName });
  }

  /** Replace ALL fields on a table (clear + re-add) */
  async replaceAllFields(tableName: string, fields: Array<Record<string, unknown>>): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('replaceAllFields', { objectName: tableName, fields });
  }

  /** Add a value to an enum */
  async addEnumValue(enumName: string, valueName: string, value: number, label?: string, countryRegionCodes?: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addEnumValue', { objectName: enumName, enumValueName: valueName, enumValue: value, label, countryRegionCodes });
  }

  /** Modify an existing enum value's properties */
  async modifyEnumValue(enumName: string, valueName: string, properties?: Record<string, string>): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('modifyEnumValue', { objectName: enumName, enumValueName: valueName, properties });
  }

  /** Remove a value from an enum */
  async removeEnumValue(enumName: string, valueName: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('removeEnumValue', { objectName: enumName, enumValueName: valueName });
  }

  /** Add a control to a form */
  async addControl(formName: string, controlName: string, parentControl: string, controlType: string, dataSource?: string, dataField?: string, label?: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addControl', { objectName: formName, controlName, parentControl, controlType, controlDataSource: dataSource, controlDataField: dataField, label });
  }

  /** Add a data source to a form */
  async addDataSource(objectType: string, objectName: string, dsName: string, table: string, joinSource?: string, linkType?: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addDataSource', { objectType, objectName, dataSourceName: dsName, dataSourceTable: table, joinSource, linkType });
  }

  /** Add/update a field modification in a table-extension (override base-table field label/mandatory) */
  async addFieldModification(extensionName: string, fieldName: string, fieldLabel?: string, fieldMandatory?: boolean): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addFieldModification', { objectName: extensionName, fieldName, fieldLabel, fieldMandatory });
  }

  /** Add a menu item reference to a menu */
  async addMenuItemToMenu(menuName: string, menuItemToAdd: string, menuItemToAddType?: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addMenuItemToMenu', { objectName: menuName, menuItemToAdd, menuItemToAddType: menuItemToAddType ?? 'display' });
  }

  // Batch, Capabilities, Pattern Discovery

  /** Execute multiple write operations on a single object in one call */
  async batchModify(
    objectType: string,
    objectName: string,
    operations: BridgeBatchOperationRequest[]
  ): Promise<BridgeBatchOperationResult> {
    return this.call<BridgeBatchOperationResult>('batchModify', { objectType, objectName, operations });
  }

  /** Get structured capabilities map — lists available operations per object type */
  async getCapabilities(): Promise<BridgeCapabilities> {
    return this.call<BridgeCapabilities>('getCapabilities', {});
  }

  /** Discover available D365FO form patterns (runtime DLL or hardcoded fallback) */
  async discoverFormPatterns(): Promise<BridgeFormPatternDiscoveryResult> {
    return this.call<BridgeFormPatternDiscoveryResult>('discoverFormPatterns', {});
  }

  // Private helpers

  private resolveBridgeExe(): string {
    if (this.options.bridgeExePath) {
      if (!fs.existsSync(this.options.bridgeExePath)) {
        throw new Error(`Bridge exe not found at: ${this.options.bridgeExePath}`);
      }
      return this.options.bridgeExePath;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const candidates = [
      // Development: built in-tree
      path.resolve(__dirname, '../../bridge/D365MetadataBridge/bin/Release', BRIDGE_EXE_NAME),
      // Production: alongside the server
      path.resolve(__dirname, '../bridge', BRIDGE_EXE_NAME),
      path.resolve(__dirname, BRIDGE_EXE_NAME),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `Bridge executable not found. Searched:\n${candidates.map(c => `  - ${c}`).join('\n')}\n` +
      `Build it with: cd bridge/D365MetadataBridge && dotnet build -c Release`
    );
  }

  private rejectAllPending(error: Error): void {
    for (const [_id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// Factory function — detects D365FO presence

/**
 * Attempt to create and initialize a BridgeClient.
 * Returns null if D365FO is not installed or the bridge exe is missing.
 *
 * This is a non-throwing factory — safe to call during server startup.
 */
export async function createBridgeClient(options: {
  packagesPath?: string;
  referencePackagesPath?: string;
  binPath?: string;
  bridgeExePath?: string;
  xrefServer?: string;
  xrefDatabase?: string;
  logFile?: string;
}): Promise<BridgeClient | null> {
  const packagesPath = options.packagesPath ?? detectPackagesPath();
  if (!packagesPath) {
    console.error(
      '[BridgeClient] No packagesPath detected — bridge disabled.\n' +
      '  Set "packagePath" in .mcp.json context, or "D365FO_PACKAGE_PATH" env var.\n' +
      '  Checked: options.packagesPath=' + (options.packagesPath ?? 'undefined') +
      ', D365FO_PACKAGE_PATH=' + (process.env.D365FO_PACKAGE_PATH ?? 'undefined') +
      ', PACKAGES_PATH=' + (process.env.PACKAGES_PATH ?? 'undefined')
    );
    return null;
  }

  console.error(`[BridgeClient] packagesPath=${packagesPath}, binPath=${options.binPath ?? 'auto'}`);

  const client = new BridgeClient({
    ...options,
    packagesPath,
  });

  try {
    await client.initialize();
    return client;
  } catch (err) {
    console.error(`[BridgeClient] Initialization failed: ${err}`);
    client.dispose();
    return null;
  }
}

function detectPackagesPath(): string | null {
  // Canonical env vars take priority over well-known path probes. D365FO_PACKAGE_PATH can be set
  // in .env (traditional mode, loaded by dotenv at startup) or in the .mcp.json env{} block
  // (VS passes it to the subprocess). Both sources land in process.env equivalently.
  // PACKAGES_PATH is the legacy .env.example name.
  const candidates = [
    process.env.D365FO_PACKAGE_PATH ?? '',
    process.env.PACKAGES_PATH ?? '',
    // Well-known fallback locations (traditional D365FO VM layouts)
    'C:\\AosService\\PackagesLocalDirectory',
    'C:\\AOSService\\PackagesLocalDirectory',
    'J:\\AosService\\PackagesLocalDirectory',
    'K:\\AosService\\PackagesLocalDirectory',
  ].filter(Boolean);

  for (const p of candidates) {
    // Traditional: bin is directly under packagesPath
    if (fs.existsSync(path.join(p, 'bin', 'Microsoft.Dynamics.AX.Metadata.dll'))) {
      return p;
    }
  }
  return null;
}
