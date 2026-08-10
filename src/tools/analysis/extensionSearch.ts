/**
 * X++ Extension Search Tool
 * Search for symbols only in custom extensions/ISV models
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';

const ExtensionSearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  prefix: z.string().optional().describe('Extension prefix filter (e.g., ISV_, Custom_)'),
  limit: z.number().optional().default(20).describe('Maximum results to return'),
  // search(scope="extensions", type="method") forwards `type` here. It used to be
  // dropped silently by this schema — z.object() strips unknown keys — so a typed
  // extension search answered as if no filter had been asked for.
  type: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Symbol type filter, e.g. "method" or ["class-extension","table-extension"]'),
});

export async function extensionSearchTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ExtensionSearchArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;

    const types = args.type === undefined
      ? undefined
      : (Array.isArray(args.type) ? args.type : [args.type]);

    // Query database
    const results = symbolIndex.searchCustomExtensions(args.query, args.prefix, args.limit, types);

    if (results.length === 0) {
      const prefixMsg = args.prefix ? ` with prefix "${args.prefix}"` : '';
      const typeMsg = types ? ` of type ${types.join('/')}` : '';
      // The scope is now defined by the custom-model list, so an empty list means every
      // extension search returns nothing — a configuration fault, not an empty result set.
      // Worth naming, or it reads as "this workspace has no extensions".
      const noCustomModels = symbolIndex.getCustomModels().length === 0;
      return {
        content: [
          {
            type: 'text',
            text: noCustomModels
              ? `⚠️ No custom/ISV models are known to the index, so scope="extensions" can never match.\n` +
                `Set CUSTOM_MODELS or EXTENSION_PREFIX, or drop scope="extensions" to search the whole index.`
              : `No custom extension symbols${typeMsg} found matching "${args.query}"${prefixMsg}.\n` +
                `This scope covers CUSTOM/ISV models only. For the standard corpus drop scope="extensions".`,
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
      output += `\n\u26a0\ufe0f Available Custom Models (READ-ONLY reference \u2014 these are SOURCE models of existing objects. Do NOT use these as the target model for new objects. Always use the model from .mcp.json): ${customModels.join(', ')}`;
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
