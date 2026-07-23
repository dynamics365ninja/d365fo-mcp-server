/**
 * X++ Symbol Search Tool
 * Search for classes, tables, methods, and fields by name or keyword
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { validateWorkspacePath } from '../workspace/workspaceUtils.js';
import {
  generateRelatedSearches,
  detectCommonPatterns,
  generateContextualTips,
  formatRichContext
} from '../utils/richContext.js';
import {
  generateSearchSuggestions,
  formatSuggestions
} from '../utils/suggestionEngine.js';
import { tryBridgeSearch } from '../bridge/bridgeAdapter.js';
import { lookupSymbolsNocase } from '../utils/symbolLookup.js';
import { rankCustomFirst, isExactNameMatch } from '../utils/exactMatchRanking.js';
import { isCustomModel } from '../utils/modelClassifier.js';

/**
 * Index-safe probe for symbols whose name EQUALS the query (#15).
 *
 * Runs `lookupSymbolsNocase`, i.e. an exact-case equality probe on
 * idx_name_type followed by a bounded FTS5 phrase match for differently-cased
 * input. Deliberately NOT `LIKE` and NOT `name = ? COLLATE NOCASE` as the
 * primary predicate: on the 1.17M-row production symbol DB either shape
 * degrades to a full scan (80–278 s measured) and blocks the event loop until
 * MCP clients kill the server.
 *
 * Returns [] on any failure — the exact-first repair must never break search.
 */
export function probeExactMatches(
  symbolIndex: any,
  query: string,
  types?: string[],
): Array<{ name: string; type: string; model?: string; filePath?: string }> {
  if (!query || /[\s*"%]/.test(query)) return [];
  try {
    const db = symbolIndex?.getReadDb?.();
    if (!db) return [];
    return lookupSymbolsNocase(db, query, { types, limit: 5 })
      .filter(hit => isExactNameMatch(query, hit.name))
      .map(hit => ({
        name: hit.name,
        type: hit.type,
        model: hit.model ?? undefined,
        filePath: hit.file_path ?? undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Probe the SQLite index for keyword matches that live in CUSTOM/ISV models.
 *
 * Broad keyword searches routed through the C# bridge fill their fixed result
 * window in provider-enumeration order (Microsoft-dominated) and truncate at
 * `maxResults`, so custom matches enumerated later never reach the client — the
 * search then looks like it "returns only Microsoft objects". These hits are
 * spliced back into the bridge/external results and ranked directly after exact
 * matches so custom code is always visible. Model-scoped and FTS-driven, so it
 * stays index-safe (never a full `%query%` scan of the whole corpus).
 *
 * Returns [] on any failure — the custom-first repair must never break search.
 */
export function probeCustomMatches(
  symbolIndex: any,
  query: string,
  types?: string[],
  limit = 15,
): Array<{ name: string; type: string; model?: string; filePath?: string }> {
  if (!query) return [];
  try {
    const hits = symbolIndex?.searchCustomModelSymbols?.(query, types, limit) ?? [];
    return hits.map((hit: any) => ({
      name: hit.name,
      type: hit.type,
      model: hit.model ?? undefined,
      filePath: hit.filePath ?? hit.file_path ?? undefined,
    }));
  } catch {
    return [];
  }
}

const SearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  type: z.enum([
    'class', 'table', 'form', 'field', 'method', 'enum', 'edt', 'query', 'view', 'report',
    'security-privilege', 'security-duty', 'security-role',
    'menu-item-display', 'menu-item-action', 'menu-item-output',
    'table-extension', 'class-extension', 'form-extension',
    'enum-extension', 'edt-extension', 'data-entity-extension',
    'all',
  ]).optional().default('all').describe('Filter by object type (all=no filter, use specific type to narrow results)'),
  limit: z.number().max(100).optional().default(50).describe('Maximum results to return'),
  workspacePath: z.string().optional().describe('Optional workspace path to search local project files in addition to external metadata'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to include workspace files in search results (workspace-aware search)'),
  verbose: z.boolean().optional().default(false).describe('Include related-searches/patterns/tips sections in the output'),
});

export async function searchTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SearchArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    if (args.includeWorkspace && args.workspacePath) {
      return await performHybridSearch(args, context);
    }

    // Try C# bridge first (IMetadataProvider — live D365FO metadata).
    // The exact-name probe is passed along so an exact match that fell outside
    // the bridge's truncated result window is still ranked first (#15).
    // The custom-model probe is passed along so custom/ISV matches truncated out
    // of the Microsoft-dominated bridge window are spliced back in and
    // prioritized (never "only Microsoft objects").
    const searchTypes = args.type === 'all' ? undefined : [args.type];
    const exactMatches = probeExactMatches(symbolIndex, args.query, searchTypes);
    const customMatches = probeCustomMatches(symbolIndex, args.query, searchTypes);
    const bridgeResult = await tryBridgeSearch(
      context.bridge,
      args.query,
      args.type === 'all' ? undefined : args.type,
      args.limit,
      { exactMatches, customMatches },
    );
    if (bridgeResult) return bridgeResult;

    // Standard external metadata search
    return await performExternalSearch(args, symbolIndex);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Perform hybrid search (external + workspace)
 */
async function performHybridSearch(
  args: z.infer<typeof SearchArgsSchema>,
  context: XppServerContext
) {
  const { hybridSearch } = context;

  if (args.workspacePath) {
    const validation = await validateWorkspacePath(args.workspacePath);
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Invalid workspace path: ${validation.error}`,
          },
        ],
        isError: true,
      };
    }
  }

  const results = await hybridSearch.search(args.query, {
    types: args.type === 'all' ? undefined : [args.type as any],
    limit: args.limit,
    workspacePath: args.workspacePath,
    includeWorkspace: true,
  });

  if (results.length === 0) {
    let output = `No X++ symbols found matching "${args.query}" in external metadata or workspace`;

    try {
      const { symbolIndex } = context;
      const allSymbolNames = symbolIndex.getAllSymbolNames(args.query);
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();

      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );

      if (suggestions.length > 0) {
        output += '\n' + formatSuggestions(suggestions);
      } else {
        // Fall back to basic tips if no suggestions
        const tips = generateContextualTips(args.query, [], args.type);
        if (tips.length > 0) {
          output += '\n\n## 💡 Suggestions\n';
          tips.forEach(tip => {
            const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
            output += `\n• ${tip.tip}${toolHint}`;
          });
        }
      }
    } catch (error) {
      // Suggestion generation can fail if the relationship graph isn't built yet
      console.warn('⚠️ Could not generate search suggestions:', error);
      const tips = generateContextualTips(args.query, [], args.type);
      if (tips.length > 0) {
        output += '\n\n## 💡 Suggestions\n';
        tips.forEach(tip => {
          const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
          output += `\n• ${tip.tip}${toolHint}`;
        });
      }
    }
    
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  }

  // Convert hybrid results to XppSymbol format for rich context
  const symbols = results.map(r => r.symbol).filter(Boolean) as any[];

  // Rich context sections (related searches / patterns / tips) are opt-in:
  // on a successful search they are mostly generic boilerplate that costs the
  // agent hundreds of tokens per call. Empty-result searches keep suggestions
  // (handled above) because there the guidance is the entire value.
  const relatedSearches = args.verbose ? generateRelatedSearches(args.query, symbols, 5) : [];
  const commonPatterns = args.verbose ? detectCommonPatterns(symbols) : [];
  const tips = args.verbose ? generateContextualTips(args.query, symbols, args.type) : [];

  // Format results with source indicators
  const formatted = results
    .map((r) => {
      const source = r.source === 'workspace' ? '🔹 WORKSPACE' : '📦 EXTERNAL';
      if (r.symbol) {
        const parentPrefix = r.symbol.parentName ? `${r.symbol.parentName}.` : '';
        const signature = r.symbol.signature ? ` - ${r.symbol.signature}` : '';
        return `${source} [${r.symbol.type.toUpperCase()}] ${parentPrefix}${r.symbol.name}${signature}`;
      }
      if (r.file) {
        return `${source} [${r.file.type.toUpperCase()}] ${r.file.name} (${r.file.path})`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const workspaceCount = results.filter((r) => r.source === 'workspace').length;
  const externalCount = results.filter((r) => r.source === 'external').length;

  let output = `Found ${results.length} matches (${workspaceCount} workspace, ${externalCount} external):\n\n${formatted}`;

  if (relatedSearches.length > 0) {
    output += '\n\n## 🔍 Related Searches\n';
    relatedSearches.forEach(rel => {
      output += `\n• **"${rel.query}"** - ${rel.reason}`;
    });
  }

  if (commonPatterns.length > 0) {
    output += '\n\n## 💡 Common Patterns\n';
    commonPatterns.forEach(pattern => {
      const freq = pattern.frequency ? ` (found ${pattern.frequency}×)` : '';
      output += `\n• ${pattern.pattern}${freq}`;
    });
  }

  if (tips.length > 0) {
    output += '\n\n## 📌 Tips\n';
    tips.forEach(tip => {
      const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
      output += `\n• ${tip.tip}${toolHint}`;
    });
  }

  output += `\n\n💡 **Workspace-aware search** includes both your local project files and D365FO external metadata.`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

/**
 * Perform standard external metadata search
 */
async function performExternalSearch(
  args: z.infer<typeof SearchArgsSchema>,
  symbolIndex: any,
) {
  try {
    const types = args.type === 'all' ? undefined : [args.type];
    const raw: any[] = symbolIndex.searchSymbols(args.query, args.limit, types) || [];

    // #15: FTS5 `ORDER BY rank` scores token frequency, not name equality, so an
    // exact-name hit can be missing from (or buried inside) the window. Probe for
    // it on-index and rank it first.
    const seen = new Set(raw.map(r => `${String(r.name).toLowerCase()} ${r.type}`));
    const missingExact = probeExactMatches(symbolIndex, args.query, types)
      .filter(hit => !seen.has(`${hit.name.toLowerCase()} ${hit.type}`));
    for (const hit of missingExact) seen.add(`${hit.name.toLowerCase()} ${hit.type}`);

    // Custom/ISV matches are likewise buried under the Microsoft-dominated FTS
    // window, so splice any the window missed and mark every custom hit so
    // rankCustomFirst can lift them just behind the exact matches.
    const customProbe = probeCustomMatches(symbolIndex, args.query, types);
    const customKeys = new Set(customProbe.map(h => `${h.name.toLowerCase()} ${h.type}`));
    const missingCustom = customProbe
      .filter(hit => !seen.has(`${hit.name.toLowerCase()} ${hit.type}`));
    for (const hit of missingCustom) seen.add(`${hit.name.toLowerCase()} ${hit.type}`);

    const combined = [...missingExact, ...missingCustom, ...raw];
    const isCustomHit = (r: any) =>
      (r.model ? isCustomModel(String(r.model)) : false) ||
      customKeys.has(`${String(r.name).toLowerCase()} ${r.type}`);
    const results: any[] = rankCustomFirst(args.query, combined, r => String(r.name), isCustomHit);

    if (!results || results.length === 0) {
      const allSymbolNames = symbolIndex.getAllSymbolNames(args.query);
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();

      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );

      let output = `No X++ symbols found matching "${args.query}"`;

      if (suggestions.length > 0) {
        output += '\n' + formatSuggestions(suggestions);
      } else {
        // Fall back to basic tips if no suggestions
        const tips = generateContextualTips(args.query, [], args.type);
        if (tips.length > 0) {
          output += '\n\n## 💡 Suggestions\n';
          tips.forEach(tip => {
            const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
            output += `\n• ${tip.tip}${toolHint}`;
          });
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    }

    // Rich context sections are opt-in via `verbose` — on a successful search
    // they are mostly generic boilerplate costing hundreds of tokens per call.
    const relatedSearches = args.verbose ? generateRelatedSearches(args.query, results, 5) : [];
    const commonPatterns = args.verbose ? detectCommonPatterns(results) : [];
    const tips = args.verbose ? generateContextualTips(args.query, results, args.type) : [];

    let output = `Found ${results.length} matches:\n`;

    // #15: the grouped renderer below hides ordering, so call the exact match out
    // explicitly — that is the whole point of the exact-first repair.
    const exactHits = results.filter(r => isExactNameMatch(args.query, String(r.name)));
    if (exactHits.length > 0) {
      output += `\n⭐ **Exact name match:** ` +
        exactHits.map(r => `${r.name} (${r.type})`).join(', ') + '\n';
    }

    output += formatRichContext(args.query, results, {
      relatedSearches,
      commonPatterns,
      tips
    });

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
