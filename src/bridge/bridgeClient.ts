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
  BridgeDeleteResult,
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

  // ========================================
  // Phase 6 — Security, Menu Items, Table Extensions, Completion, Xref
  // ========================================

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

  // ========================================
  // Write-support methods (Phase 3)
  // ========================================

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

  // ========================================
  // Write operations (Phase 4)
  // ========================================

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
  async addEnumValue(enumName: string, valueName: string, value: number, label?: string): Promise<BridgeWriteResult> {
    return this.call<BridgeWriteResult>('addEnumValue', { objectName: enumName, enumValueName: valueName, enumValue: value, label });
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

  // ========================================
  // Delete, Batch, Capabilities, Pattern Discovery
  // ========================================

  /** Delete a D365FO object by removing its file from disk */
  async deleteObject(objectType: string, objectName: string): Promise<BridgeDeleteResult> {
    return this.call<BridgeDeleteResult>('deleteObject', { objectType, objectName });
  }

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
