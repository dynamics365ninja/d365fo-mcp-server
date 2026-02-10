/**
 * X++ Symbol Search Tool
 * Search for classes, tables, methods, and fields by name or keyword
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { validateWorkspacePath } from '../workspace/workspaceUtils.js';

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
    return {
      content: [
        {
          type: 'text',
          text: `No X++ symbols found matching "${args.query}" in external metadata or workspace`,
        },
      ],
    };
  }

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

  return {
    content: [
      {
        type: 'text',
        text:
          `Found ${results.length} matches (${workspaceCount} workspace, ${externalCount} external):\n\n` +
          formatted +
          `\n\n💡 **Workspace-aware search** includes both your local project files and D365FO external metadata.`,
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
    // Check cache first
    const cacheKey = cache.generateSearchKey(args.query, args.limit, args.type);
    const cachedResults = (await cache.get(cacheKey)) as any[] | null;
    
    if (cachedResults) {
      const formatted = cachedResults
        .map((s: any) => {
          const parentPrefix = s.parentName ? `${s.parentName}.` : '';
          const signature = s.signature ? ` - ${s.signature}` : '';
          return `[${s.type.toUpperCase()}] ${parentPrefix}${s.name}${signature}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Found ${cachedResults.length} matches (cached):\n\n${formatted}`,
          },
        ],
      };
    }

    // Query database with type filter
    const types = args.type === 'all' ? undefined : [args.type];
    const results = symbolIndex.searchSymbols(args.query, args.limit, types);
    
    // Cache results
    if (results.length > 0) {
      await cache.set(cacheKey, results);
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No X++ symbols found matching "${args.query}"`,
          },
        ],
      };
    }

    const formatted = results
      .map((s: { parentName?: string; signature?: string; type: string; name: string }) => {
        const parentPrefix = s.parentName ? `${s.parentName}.` : '';
        const signature = s.signature ? ` - ${s.signature}` : '';
        return `[${s.type.toUpperCase()}] ${parentPrefix}${s.name}${signature}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} matches:\n\n${formatted}`,
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
