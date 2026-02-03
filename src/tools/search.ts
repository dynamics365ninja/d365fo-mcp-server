/**
 * X++ Symbol Search Tool
 * Search for classes, tables, methods, and fields by name or keyword
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const SearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  type: z.enum(['class', 'table', 'field', 'method', 'enum', 'all']).optional().default('all').describe('Filter by object type (class=AxClass, table=AxTable, enum=AxEnum, all=no filter)'),
  limit: z.number().optional().default(20).describe('Maximum results to return'),
});

export async function searchTool(request: CallToolRequest, context: XppServerContext) {
  const args = SearchArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    // Check cache first
    const cacheKey = cache.generateSearchKey(args.query, args.limit, args.type);
    const cachedResults = await cache.get<any[]>(cacheKey);
    
    if (cachedResults) {
      const formatted = cachedResults
        .map((s) => {
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
