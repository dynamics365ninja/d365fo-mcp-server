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
} from './bridgeTypes.js';

// Re-export types for convenience
export type { BridgeReadyPayload, BridgeInfoPayload } from './bridgeTypes.js';
export * from './bridgeTypes.js';

const BRIDGE_EXE_NAME = 'D365MetadataBridge.exe';
const READY_TIMEOUT_MS = 30_000;   // 30s for metadata provider init
const CALL_TIMEOUT_MS = 60_000;    // 60s per call (large searches can take time)

export interface BridgeClientOptions {
  /** Path to the D365MetadataBridge.exe (auto-detected if omitted) */
  bridgeExePath?: string;
  /** K:\AosService\PackagesLocalDirectory */
  packagesPath: string;
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

  // ========================================
  // Lifecycle
  // ========================================

  /**
   * Spawn the C# bridge process and wait for the "ready" message.
   * Resolves with the BridgeReadyPayload on success.
   * Rejects if the process fails to start or doesn't send ready in time.
   */
  async initialize(): Promise<BridgeReadyPayload> {
    if (this._disposed) throw new Error('BridgeClient has been disposed');
    if (this._isReady) return this.readyPayload!;

    const exePath = this.resolveBridgeExe();
    const args = [
      '--packages-path', this.options.packagesPath,
    ];
    if (this.options.binPath) {
      args.push('--bin-path', this.options.binPath);
    }
    if (this.options.xrefServer) {
      args.push('--xref-server', this.options.xrefServer);
    }
    if (this.options.xrefDatabase) {
      args.push('--xref-database', this.options.xrefDatabase);
    }

    console.error(`[BridgeClient] Spawning: ${exePath} ${args.join(' ')}`);

    return new Promise<BridgeReadyPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.dispose();
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

      // Handle stdout — newline-delimited JSON
      this.process.stdout!.on('data', (chunk: Buffer) => {
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
                pending.reject(new Error(`Bridge error [${msg.error.code}]: ${msg.error.message}`));
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
      this.process.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          // Only log non-trivial messages
          for (const line of text.split('\n')) {
            if (line.includes('[ERROR]') || line.includes('[WARN]')) {
              console.error(`[Bridge] ${line.trim()}`);
            }
          }
        }
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        this._isReady = false;
        console.error(`[BridgeClient] Process error: ${err.message}`);
        this.rejectAllPending(new Error(`Bridge process error: ${err.message}`));
        reject(err);
      });

      this.process.on('exit', (code, signal) => {
        this._isReady = false;
        console.error(`[BridgeClient] Process exited: code=${code}, signal=${signal}`);
        this.rejectAllPending(new Error(`Bridge process exited unexpectedly: code=${code}`));
      });
    });
  }

  /**
   * Send a JSON-RPC call to the bridge and return the result.
   * Rejects if bridge is not ready, the call times out, or the bridge returns an error.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this._isReady || this._disposed || !this.process?.stdin?.writable) {
      throw new Error('Bridge is not ready');
    }

    const id = String(++this.requestId);
    const request = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options.callTimeoutMs ?? CALL_TIMEOUT_MS;
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

  /** Gracefully shut down the bridge process */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._isReady = false;

    this.rejectAllPending(new Error('BridgeClient disposed'));

    if (this.process) {
      try {
        this.process.stdin?.end();
        // Give it a moment to exit gracefully
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
          }
        }, 2000);
      } catch { /* ignore */ }
      this.process = null;
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

  async searchObjects(query: string, objectType?: string): Promise<BridgeSearchResult> {
    const params: Record<string, unknown> = { query };
    if (objectType) params.objectType = objectType;
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

  async getInfo(): Promise<BridgeInfoPayload> {
    return this.call<BridgeInfoPayload>('getInfo');
  }

  // ========================================
  // Private helpers
  // ========================================

  private resolveBridgeExe(): string {
    // 1. Explicit path from options
    if (this.options.bridgeExePath) {
      if (!fs.existsSync(this.options.bridgeExePath)) {
        throw new Error(`Bridge exe not found at: ${this.options.bridgeExePath}`);
      }
      return this.options.bridgeExePath;
    }

    // 2. Look relative to this module's location (project root/bridge/D365MetadataBridge/bin/Release/)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const candidates = [
      // Development: built in-tree
      path.resolve(__dirname, '../../bridge/D365MetadataBridge/bin/Release', BRIDGE_EXE_NAME),
      // Production: alongside the server
      path.resolve(__dirname, '../bridge', BRIDGE_EXE_NAME),
      // Same directory
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

// ========================================
// Factory function — detects D365FO presence
// ========================================

/**
 * Attempt to create and initialize a BridgeClient.
 * Returns null if D365FO is not installed or the bridge exe is missing.
 *
 * This is a non-throwing factory — safe to call during server startup.
 */
export async function createBridgeClient(options: {
  packagesPath?: string;
  binPath?: string;
  bridgeExePath?: string;
  xrefServer?: string;
  xrefDatabase?: string;
}): Promise<BridgeClient | null> {
  // Auto-detect packagesPath if not provided
  const packagesPath = options.packagesPath ?? detectPackagesPath();
  if (!packagesPath) {
    console.error('[BridgeClient] No packagesPath detected — bridge disabled');
    return null;
  }

  // Check if bridge exe exists before trying to spawn
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
  const candidates = [
    'K:\\AosService\\PackagesLocalDirectory',
    'C:\\AosService\\PackagesLocalDirectory',
    'J:\\AosService\\PackagesLocalDirectory',
    process.env.PackagesPath ?? '',
  ].filter(Boolean);

  for (const p of candidates) {
    // Traditional: bin is directly under packagesPath
    if (fs.existsSync(path.join(p, 'bin', 'Microsoft.Dynamics.AX.Metadata.dll'))) {
      return p;
    }
  }
  return null;
}
