/**
 * X++ Class Information Tool
 * Get detailed information about an X++ class including its methods
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { validateWorkspacePath } from '../workspace/workspaceUtils.js';

const ClassInfoArgsSchema = z.object({
  className: z.string().describe('Name of the X++ class'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to search in workspace first'),
  workspacePath: z.string().optional().describe('Workspace path to search for class'),
});

export async function classInfoTool(request: CallToolRequest, context: XppServerContext) {
  const args = ClassInfoArgsSchema.parse(request.params.arguments);
  const { symbolIndex, parser, cache, workspaceScanner } = context;

  try {
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
      const workspaceResult = await searchInWorkspace(args, workspaceScanner);
      if (workspaceResult) {
        return workspaceResult;
      }
      // If not found in workspace, continue to external search
    }

    // Check cache first
    const cacheKey = cache.generateClassKey(args.className);
    const cachedClass = await cache.get<any>(cacheKey);
    
    if (cachedClass) {
      const methods = cachedClass.methods
        .map(
          (m: any) =>
            `  ${m.isStatic ? 'static ' : ''}${m.returnType || 'void'} ${m.name}(${m.parameters?.join(', ') || ''})`
        )
        .join('\n');

      const extendsInfo = cachedClass.extendsClass ? `\nExtends: ${cachedClass.extendsClass}` : '';
      const modifiers = [];
      if (cachedClass.isFinal) modifiers.push('final');
      if (cachedClass.isAbstract) modifiers.push('abstract');
      const modifiersInfo = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Class: ${cachedClass.name}${modifiersInfo}${extendsInfo}\n\nMethods:\n${methods} (cached)`,
          },
        ],
      };
    }

    // Query database and parse
    const classSymbol = symbolIndex.getSymbolByName(args.className, 'class');

    if (!classSymbol) {
      return {
        content: [
          {
            type: 'text',
            text: `Class "${args.className}" not found in symbol index`,
          },
        ],
        isError: true,
      };
    }

    // Try to parse XML file if available, otherwise use database info
    const classInfo = await parser.parseClassFile(classSymbol.filePath);

    if (!classInfo.success || !classInfo.data) {
      // Fallback to database information
      const methods = symbolIndex.getClassMethods(args.className);
      
      let output = `# Class: ${args.className}\n\n`;
      output += `**Model:** ${classSymbol.model}\n`;
      output += `**File:** ${classSymbol.filePath}\n\n`;
      output += `_Note: Detailed XML metadata not available. Showing symbol index data._\n\n`;
      
      if (methods.length > 0) {
        output += `## Methods (${methods.length})\n\n`;
        for (const method of methods) {
          output += `- **${method.name}**`;
          if (method.signature) {
            output += `: ${method.signature}`;
          }
          output += `\n`;
        }
      } else {
        output += `No methods found in symbol index.\n`;
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

    const cls = classInfo.data;

    let output = `# Class: ${cls.name}\n\n`;
    
    if (cls.extends) {
      output += `**Extends:** ${cls.extends}\n`;
    }
    
    if (cls.implements.length > 0) {
      output += `**Implements:** ${cls.implements.join(', ')}\n`;
    }
    
    output += `**Model:** ${cls.model}\n`;
    output += `**Abstract:** ${cls.isAbstract ? 'Yes' : 'No'}\n`;
    output += `**Final:** ${cls.isFinal ? 'Yes' : 'No'}\n\n`;

    output += `## Declaration\n\`\`\`xpp\n${cls.declaration}\n\`\`\`\n\n`;

    output += `## Methods (${cls.methods.length})\n\n`;

    for (const method of cls.methods) {
      const params = method.parameters.map((p: { type: string; name: string }) => `${p.type} ${p.name}`).join(', ');
      output += `### ${method.name}\n\n`;
      output += `- **Visibility:** ${method.visibility}\n`;
      output += `- **Returns:** ${method.returnType}\n`;
      output += `- **Static:** ${method.isStatic ? 'Yes' : 'No'}\n`;
      output += `- **Signature:** \`${method.returnType} ${method.name}(${params})\`\n\n`;
      
      if (method.documentation) {
        output += `**Documentation:**\n${method.documentation}\n\n`;
      }
      
      output += `\`\`\`xpp\n${method.source.substring(0, 500)}${method.source.length > 500 ? '...' : ''}\n\`\`\`\n\n`;
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
          text: `Error getting class info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Search for class in workspace
 */
async function searchInWorkspace(
  args: z.infer<typeof ClassInfoArgsSchema>,
  scanner: any
): Promise<any | null> {
  try {
    const files = await scanner.searchInWorkspace(args.workspacePath!, args.className, 'class');
    
    if (files.length === 0) {
      return null;
    }

    const file = files[0];
    const fileWithMetadata = await scanner.getFileWithMetadata(file.path);

    if (!fileWithMetadata || !fileWithMetadata.metadata) {
      return null;
    }

    const metadata = fileWithMetadata.metadata;
    let output = `# 🔹 WORKSPACE Class: ${args.className}\n\n`;
    output += `**Location:** ${file.path}\n`;
    output += `**Last Modified:** ${file.lastModified.toISOString()}\n\n`;

    if (metadata.extends) {
      output += `**Extends:** ${metadata.extends}\n`;
    }

    if (metadata.implements && metadata.implements.length > 0) {
      output += `**Implements:** ${metadata.implements.join(', ')}\n`;
    }

    if (metadata.methods && metadata.methods.length > 0) {
      output += `\n## Methods (${metadata.methods.length})\n\n`;
      for (const method of metadata.methods) {
        output += `- **${method.name}**`;
        if (method.signature) {
          output += `: ${method.signature}`;
        }
        if (method.isStatic) {
          output += ' *(static)*';
        }
        output += `\n`;
      }
    }

    if (metadata.fields && metadata.fields.length > 0) {
      output += `\n## Fields (${metadata.fields.length})\n\n`;
      for (const field of metadata.fields) {
        output += `- **${field.name}**`;
        if (field.type || field.edt) {
          output += `: ${field.edt || field.type}`;
        }
        output += `\n`;
      }
    }

    output += `\n---\n\n💡 This class was found in your workspace. External D365FO version may also exist.\n`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    console.warn('Error searching workspace:', error);
    return null;
  }
}
