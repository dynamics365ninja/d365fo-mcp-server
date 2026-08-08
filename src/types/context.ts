/**
 * Shared type definitions
 */

import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import type { XppMetadataParser } from '../metadata/xmlParser.js';
import type { WorkspaceScanner } from '../workspace/workspaceScanner.js';
import type { HybridSearch } from '../workspace/hybridSearch.js';
import type { BridgeClient } from '../bridge/bridgeClient.js';
import type { BridgeStartup } from '../bridge/bridgeReadiness.js';

/**
 * Editor context from IDE (VS2022, VS2026)
 */
export interface EditorContext {
  /** Currently active file in editor */
  activeFile?: {
    path: string;
    content: string;
    cursorLine: number;
    cursorColumn: number;
  };
  /** Current selection in editor */
  selection?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
    text: string;
  };
  /** Files with unsaved changes (path -> content) */
  modifiedFiles: Map<string, string>;
}

export interface XppServerContext {
  symbolIndex: XppSymbolIndex;
  parser: XppMetadataParser;
  workspaceScanner: WorkspaceScanner;
  hybridSearch: HybridSearch;
  editorContext?: EditorContext;
  /**
   * C# bridge to Microsoft's Dev Tools API (IMetadataProvider + DYNAMICSXREFDB).
   * Available only on Windows VMs with D365FO installed.
   * When present, tools can use it for live metadata reads and cross-references
   * instead of the SQLite symbol index.
   */
  bridge?: BridgeClient;
  /**
   * Tracks the one-shot C# bridge startup attempt, which runs in parallel with
   * the DB load and only sets `bridge` once it succeeds. Bridge-backed tools
   * await it (bounded) so a cold-start race is never reported as a missing
   * object or a broken configuration. Absent when nothing spawned a bridge.
   */
  bridgeStartup?: BridgeStartup;
  /**
   * Resolves when the real symbol database has been loaded.
   * Present only in stdio mode when the stub pattern is active.
   * Tool handlers await this before executing so they always use the real
   * index rather than the empty in-memory stub.
   */
  dbReady?: Promise<void>;
}


