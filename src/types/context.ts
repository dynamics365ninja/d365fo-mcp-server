/**
 * Shared type definitions
 */

import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import type { XppMetadataParser } from '../metadata/xmlParser.js';
import type { RedisCacheService } from '../cache/redisCache.js';
import type { WorkspaceScanner } from '../workspace/workspaceScanner.js';
import type { HybridSearch } from '../workspace/hybridSearch.js';
import type { TermRelationshipGraph } from '../utils/suggestionEngine.js';

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
  cache: RedisCacheService;
  workspaceScanner: WorkspaceScanner;
  hybridSearch: HybridSearch;
  termRelationshipGraph: TermRelationshipGraph;
  editorContext?: EditorContext;
  /**
   * Resolves when the real symbol database has been loaded.
   * Present only in stdio mode when the stub pattern is active.
   * Tool handlers await this before executing so they always use the real
   * index rather than the empty in-memory stub.
   */
  dbReady?: Promise<void>;
}


