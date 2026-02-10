/**
 * X++ Code Completion Tool
 * Get method and field completions for classes or tables
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const CompletionArgsSchema = z.object({
  className: z.string().describe('Class or table name'),
  prefix: z.string().optional().default('').describe('Method/field name prefix to filter'),
});

export async function completionTool(request: CallToolRequest, context: XppServerContext) {
  const args = CompletionArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    // Check cache first
    const cacheKey = `completion:${args.className}:${args.prefix}`;
    const cachedResults = await cache.get<any[]>(cacheKey);
    
    if (cachedResults) {
      return {
        content: [{ type: 'text', text: formatCompletions(cachedResults, args.className, args.prefix) }],
      };
    }

    // Use the built-in getCompletions method that properly handles both classes and tables
    const completions = symbolIndex.getCompletions(args.className, args.prefix);

    if (completions.length === 0) {
      // Check if the class/table exists at all
      const classExists = symbolIndex.searchSymbols(args.className, 1, ['class']).length > 0;
      const tableExists = symbolIndex.searchSymbols(args.className, 1, ['table']).length > 0;
      
      if (!classExists && !tableExists) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Class or table "${args.className}" not found in metadata.\n\n` +
                    `**Possible reasons:**\n` +
                    `1. The class/table doesn't exist in your D365FO environment\n` +
                    `2. Typo in the name (use \`search\` tool to find similar names)\n` +
                    `3. Metadata database hasn't been built yet\n\n` +
                    `**Next steps:**\n` +
                    `- Try: \`search("${args.className.substring(0, 5)}", type="class")\`\n` +
                    `- Try: \`search("${args.className.substring(0, 5)}", type="table")\``,
            },
          ],
        };
      }
      
      const prefixMsg = args.prefix ? ` starting with "${args.prefix}"` : '';
      return {
        content: [
          {
            type: 'text',
            text: `Found "${args.className}" but it has no methods or fields${prefixMsg}.\n\n` +
                  `This could mean:\n` +
                  `- The class/table has no members\n` +
                  `- The prefix "${args.prefix}" doesn't match any members\n` +
                  `- XML metadata is not available (only symbol index)\n\n` +
                  `Try using \`get_class_info("${args.className}")\` or \`get_table_info("${args.className}")\` for more details.`,
          },
        ],
      };
    }

    // Cache results
    await cache.set(cacheKey, completions, 300); // Cache for 5 minutes

    const formatted = formatCompletions(completions, args.className, args.prefix);

    return {
      content: [
        {
          type: 'text',
          text: formatted,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting completions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Format completions in a human-readable way
 */
function formatCompletions(completions: any[], className: string, prefix: string): string {
  const prefixMsg = prefix ? ` starting with "${prefix}"` : '';
  let output = `# Code Completion: ${className}${prefixMsg}\n\n`;
  output += `Found ${completions.length} member(s):\n\n`;

  // Group by kind
  const methods = completions.filter(c => c.kind === 'Method');
  const fields = completions.filter(c => c.kind === 'Field');

  if (methods.length > 0) {
    output += `## Methods (${methods.length})\n\n`;
    methods.forEach(m => {
      const sig = m.detail || m.signature || '';
      output += `- **${m.label}**`;
      if (sig) {
        output += `: ${sig}`;
      }
      output += '\n';
    });
    output += '\n';
  }

  if (fields.length > 0) {
    output += `## Fields (${fields.length})\n\n`;
    fields.forEach(f => {
      const sig = f.detail || f.signature || '';
      output += `- **${f.label}**`;
      if (sig) {
        output += `: ${sig}`;
      }
      output += '\n';
    });
  }

  if (prefix && completions.length < 100) {
    output += `\n---\n\n💡 **Tip:** Remove the prefix to see all available members of ${className}.`;
  }

  return output;
}
