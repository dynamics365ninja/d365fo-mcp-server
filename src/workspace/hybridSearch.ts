/**
 * Hybrid Search
 * Combines external D365FO metadata index with local workspace files
 */

import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import type { WorkspaceScanner, WorkspaceFile } from './workspaceScanner.js';
import type { XppSymbol } from '../metadata/types.js';

export interface HybridSearchResult {
  source: 'external' | 'workspace';
  symbol?: XppSymbol;
  file?: WorkspaceFile;
  relevance: number;
}

export class HybridSearch {
  constructor(
    private symbolIndex: XppSymbolIndex,
    private workspaceScanner: WorkspaceScanner
  ) {}

  /**
   * Search in both external metadata and workspace
   */
  async search(
    query: string,
    options: {
      types?: Array<'class' | 'table' | 'method' | 'field' | 'enum'>;
      limit?: number;
      workspacePath?: string;
      includeWorkspace?: boolean;
    } = {}
  ): Promise<HybridSearchResult[]> {
    const results: HybridSearchResult[] = [];

    // 1. Search external metadata (D365FO PackagesLocalDirectory)
    const externalSymbols = this.symbolIndex.searchSymbols(
      query,
      options.limit || 20,
      options.types
    );

    for (const symbol of externalSymbols) {
      results.push({
        source: 'external',
        symbol,
        relevance: this.calculateRelevance(query, symbol.name),
      });
    }

    // 2. Search workspace files (if workspace path provided)
    if (options.includeWorkspace && options.workspacePath) {
      const workspaceFiles = await this.workspaceScanner.searchInWorkspace(
        options.workspacePath,
        query,
        options.types?.[0] as any // Use first type for workspace filter
      );

      for (const file of workspaceFiles) {
        results.push({
          source: 'workspace',
          file,
          relevance: this.calculateRelevance(query, file.name),
        });
      }
    }

    // 3. Sort by relevance and deduplicate
    results.sort((a, b) => b.relevance - a.relevance);

    // 4. Deduplicate (prefer workspace over external for same name)
    const seen = new Set<string>();
    const deduplicated: HybridSearchResult[] = [];

    for (const result of results) {
      const name = result.symbol?.name || result.file?.name;
      if (!name) continue;

      if (!seen.has(name)) {
        seen.add(name);
        deduplicated.push(result);
      } else if (result.source === 'workspace') {
        // Replace external with workspace version
        const idx = deduplicated.findIndex(
          (r) => (r.symbol?.name || r.file?.name) === name
        );
        if (idx !== -1) {
          deduplicated[idx] = result;
        }
      }
    }

    return deduplicated.slice(0, options.limit || 20);
  }

  /**
   * Search patterns in workspace code
   */
  async searchPatterns(
    scenario: string,
    workspacePath: string
  ): Promise<{
    externalPatterns: any[];
    workspaceMatches: WorkspaceFile[];
  }> {
    // Get patterns from external metadata
    const externalPatterns = this.symbolIndex.analyzeCodePatterns(scenario);

    // Search workspace for matching files
    const workspaceMatches = await this.workspaceScanner.searchInWorkspace(
      workspacePath,
      scenario
    );

    return {
      externalPatterns,
      workspaceMatches,
    };
  }

  /**
   * Calculate relevance score
   */
  private calculateRelevance(query: string, name: string): number {
    const q = query.toLowerCase();
    const n = name.toLowerCase();

    // Exact match = 100
    if (n === q) return 100;

    // Starts with = 80
    if (n.startsWith(q)) return 80;

    // Contains = 50
    if (n.includes(q)) return 50;

    // Fuzzy match = 30
    const distance = this.levenshteinDistance(q, n);
    if (distance <= 3) return 30;

    return 10;
  }

  /**
   * Levenshtein distance for fuzzy matching
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}
