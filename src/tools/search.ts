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

const SearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  type: z.enum(['class', 'table', 'field', 'method', 'enum', 'all']).optional().default('all').describe('Filter by object type (class=AxClass, table=AxTable, enum=AxEnum, all=no filter)'),
  limit: z.number().optional().default(20).describe('Maximum results to return'),
  workspacePath: z.string().optional().describe('Optional workspace path to search local project files in addition to external metadata'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to include workspace files in search results (workspace-aware search)'),
});

export async function searchTool(request: CallToolRequest, context: XppServerContext) {
  const args = SearchArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    // Hybrid search if workspace is specified
    if (args.includeWorkspace && args.workspacePath) {
      return await performHybridSearch(args, context);
    }

    // Standard external metadata search
    return await performExternalSearch(args, symbolIndex, cache);
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

  // Validate workspace path
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
    // Generate intelligent suggestions using suggestion engine
    const { symbolIndex } = context;
    const allSymbolNames = symbolIndex.getAllSymbolNames();
    const symbolsByTerm = symbolIndex.getSymbolsByTerm();
    
    const suggestions = generateSearchSuggestions(
      args.query,
      allSymbolNames,
      symbolsByTerm,
      5 // max suggestions
    );
    
    let output = `No X++ symbols found matching "${args.query}" in external metadata or workspace`;
    
    // Add intelligent suggestions
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

  // Convert hybrid results to XppSymbol format for rich context
  const symbols = results.map(r => r.symbol).filter(Boolean) as any[];
  
  // Generate rich context from symbols
  const relatedSearches = generateRelatedSearches(args.query, symbols, 5);
  const commonPatterns = detectCommonPatterns(symbols);
  const tips = generateContextualTips(args.query, symbols, args.type);

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
  
  // Add rich context sections
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
  cache: any
) {
  try {
    // Check cache first with fuzzy matching
    const cacheKey = cache.generateSearchKey(args.query, args.limit, args.type);
    const cachedResults = (await cache.getFuzzy(cacheKey)) as any[] | null;
    
    let results: any[] = cachedResults || [];
    let fromCache = !!cachedResults;
    
    if (cachedResults === null) {
      // Query database with type filter
      const types = args.type === 'all' ? undefined : [args.type];
      results = symbolIndex.searchSymbols(args.query, args.limit, types) || [];
      
      // Cache results
      if (results.length > 0) {
        await cache.set(cacheKey, results);
      }
    }

    // Ensure results is not null
    if (!results || results.length === 0) {
      // Generate intelligent suggestions using suggestion engine
      const allSymbolNames = symbolIndex.getAllSymbolNames();
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();
      
      // Note: context is passed as parameter, so we can access it
      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );
      
      let output = `No X++ symbols found matching "${args.query}"`;
      
      // Add intelligent suggestions
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

    // Generate rich context
    const relatedSearches = generateRelatedSearches(args.query, results, 5);
    const commonPatterns = detectCommonPatterns(results);
    const tips = generateContextualTips(args.query, results, args.type);

    // Format output with rich context
    const cacheIndicator = fromCache ? ' (cached)' : '';
    let output = `Found ${results.length} matches${cacheIndicator}:\n`;
    
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
