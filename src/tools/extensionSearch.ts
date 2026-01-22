/**
 * X++ Extension Search Tool
 * Search for symbols only in custom extensions/ISV models
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const ExtensionSearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  prefix: z.string().optional().describe('Extension prefix filter (e.g., ISV_, Custom_)'),
  limit: z.number().optional().default(20).describe('Maximum results to return'),
});

export async function extensionSearchTool(request: CallToolRequest, context: XppServerContext) {
  const args = ExtensionSearchArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    // Check cache first
    const cacheKey = cache.generateExtensionSearchKey(args.query, args.prefix, args.limit);
    const cachedResults = await cache.get<any[]>(cacheKey);
    
    if (cachedResults) {
      // Group cached results by model
      const byModel = cachedResults.reduce((acc: any, symbol: any) => {
        if (!acc[symbol.model]) {
          acc[symbol.model] = [];
        }
        acc[symbol.model].push(symbol);
        return acc;
      }, {});

      const formatted = Object.entries(byModel)
        .map(([model, symbols]: [string, any]) => {
          const items = symbols
            .map((s: any) => {
              const parentPrefix = s.parentName ? `${s.parentName}.` : '';
              const signature = s.signature ? ` - ${s.signature}` : '';
              return `  [${s.type.toUpperCase()}] ${parentPrefix}${s.name}${signature}`;
            })
            .join('\n');
          return `Model: ${model}\n${items}`;
        })
        .join('\n\n');

      const customModels = symbolIndex.getCustomModels();
      const modelsInfo =
        customModels.length > 0
          ? `\n\nAvailable custom models: ${customModels.join(', ')}`
          : '';

      return {
        content: [
          {
            type: 'text',
            text: `Found ${cachedResults.length} matches in custom extensions (cached):\n\n${formatted}${modelsInfo}`,
          },
        ],
      };
    }

    // Query database
    const results = symbolIndex.searchCustomExtensions(args.query, args.prefix, args.limit);
    
    // Cache results
    if (results.length > 0) {
      await cache.set(cacheKey, results);
    }

    if (results.length === 0) {
      const prefixMsg = args.prefix ? ` with prefix "${args.prefix}"` : '';
      return {
        content: [
          {
            type: 'text',
            text: `No custom extension symbols found matching "${args.query}"${prefixMsg}`,
          },
        ],
      };
    }

    // Group results by model for better readability
    const byModel = results.reduce((acc: Record<string, typeof results>, symbol: typeof results[0]) => {
      if (!acc[symbol.model]) {
        acc[symbol.model] = [];
      }
      acc[symbol.model].push(symbol);
      return acc;
    }, {} as Record<string, typeof results>);

    let output = `Found ${results.length} matches in custom extensions:\n\n`;

    for (const [model, symbols] of Object.entries(byModel)) {
      output += `**${model}** (${(symbols as typeof results).length} symbols)\n`;
      for (const s of (symbols as typeof results)) {
        const parentPrefix = s.parentName ? `${s.parentName}.` : '';
        const signature = s.signature ? ` - ${s.signature}` : '';
        output += `  [${s.type.toUpperCase()}] ${parentPrefix}${s.name}${signature}\n`;
      }
      output += '\n';
    }

    // List available custom models
    const customModels = symbolIndex.getCustomModels();
    if (customModels.length > 0) {
      output += `\n📦 Available Custom Models: ${customModels.join(', ')}`;
    }

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
          text: `Error searching custom extensions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
