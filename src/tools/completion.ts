/**
 * X++ Code Completion Tool
 * Get method and field completions for classes or tables
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { validateWorkspacePath } from '../workspace/workspaceUtils.js';

const CompletionArgsSchema = z.object({
  className: z.string().describe('Class or table name'),
  prefix: z.string().optional().default('').describe('Method/field name prefix to filter'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to include workspace files'),
  workspacePath: z.string().optional().describe('Workspace path to search'),
});

export async function completionTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = CompletionArgsSchema.parse(request.params.arguments);
    const { symbolIndex, cache, workspaceScanner } = context;
    // Validate workspace path if provided
    if (args.includeWorkspace && args.workspacePath) {
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

    // Try workspace first if requested
    if (args.includeWorkspace && args.workspacePath && workspaceScanner) {
      const workspaceCompletions = await getWorkspaceCompletions(args, workspaceScanner);
      if (workspaceCompletions) {
        return workspaceCompletions;
      }
    }

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

/**
 * Get completions from workspace
 */
async function getWorkspaceCompletions(
  args: z.infer<typeof CompletionArgsSchema>,
  scanner: any
): Promise<any | null> {
  try {
    // Search for class or table in workspace
    const classFiles = await scanner.searchInWorkspace(args.workspacePath!, args.className, 'class');
    const tableFiles = await scanner.searchInWorkspace(args.workspacePath!, args.className, 'table');
    
    const files = [...classFiles, ...tableFiles];
    
    if (files.length === 0) {
      return null;
    }

    const file = files[0];
    const fileWithMetadata = await scanner.getFileWithMetadata(file.path);

    if (!fileWithMetadata || !fileWithMetadata.metadata) {
      return null;
    }

    const metadata = fileWithMetadata.metadata;
    const completions: any[] = [];

    // Add methods
    if (metadata.methods) {
      for (const method of metadata.methods) {
        if (!args.prefix || method.name.toLowerCase().startsWith(args.prefix.toLowerCase())) {
          completions.push({
            label: method.name,
            kind: 'Method',
            detail: method.signature,
            documentation: method.isStatic ? 'Static method' : undefined,
          });
        }
      }
    }

    // Add fields
    if (metadata.fields) {
      for (const field of metadata.fields) {
        if (!args.prefix || field.name.toLowerCase().startsWith(args.prefix.toLowerCase())) {
          completions.push({
            label: field.name,
            kind: 'Field',
            detail: field.edt || field.type,
            documentation: field.mandatory ? 'Mandatory field' : undefined,
          });
        }
      }
    }

    if (completions.length === 0) {
      return null;
    }

    const prefixMsg = args.prefix ? ` starting with "${args.prefix}"` : '';
    let output = `# 🔹 WORKSPACE Code Completion: ${args.className}${prefixMsg}\n\n`;
    output += `Found ${completions.length} member(s) in workspace:\n\n`;

    const methods = completions.filter(c => c.kind === 'Method');
    const fields = completions.filter(c => c.kind === 'Field');

    if (methods.length > 0) {
      output += `## Methods (${methods.length})\n\n`;
      methods.forEach(m => {
        output += `- **${m.label}**`;
        if (m.detail) {
          output += `: ${m.detail}`;
        }
        if (m.documentation) {
          output += ` *(${m.documentation})*`;
        }
        output += '\n';
      });
      output += '\n';
    }

    if (fields.length > 0) {
      output += `## Fields (${fields.length})\n\n`;
      fields.forEach(f => {
        output += `- **${f.label}**`;
        if (f.detail) {
          output += `: ${f.detail}`;
        }
        if (f.documentation) {
          output += ` *(${f.documentation})*`;
        }
        output += '\n';
      });
    }

    output += `\n---\n\n💡 Completions from workspace. External D365FO completions may also be available.\n`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    console.warn('Error getting workspace completions:', error);
    return null;
  }
}
