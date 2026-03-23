/**
 * X++ Class Information Tool
 * Get detailed information about an X++ class including its methods
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { validateWorkspacePath } from '../workspace/workspaceUtils.js';
import { buildObjectTypeMismatchMessage } from '../utils/metadataResolver.js';
import { tryBridgeClass } from '../bridge/bridgeAdapter.js';

const METHOD_PAGE_SIZE = 15;

const ClassInfoArgsSchema = z.object({
  className: z.string().describe('Name of the X++ class'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to search in workspace first'),
  workspacePath: z.string().optional().describe('Workspace path to search for class'),
  methodOffset: z.number().optional().default(0).describe('Offset for paginating methods (use multiples of 15)'),
  compact: z.boolean().optional().default(true).describe('Signatures only, no source bodies (default true). Set false only when you need to read a specific method body'),
});

export async function classInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ClassInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex, parser, cache, workspaceScanner } = context;
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
      const methodOffset = args.methodOffset ?? 0;
      const totalMethods = cachedClass.methods.length;
      const pagedMethods = cachedClass.methods.slice(methodOffset, methodOffset + METHOD_PAGE_SIZE);
      const hasMore = methodOffset + METHOD_PAGE_SIZE < totalMethods;

      const methodLines = pagedMethods
        .map(
          (m: any) =>
            `- \`${m.isStatic ? 'static ' : ''}${m.returnType || 'void'} ${m.name}(${m.parameters?.join(', ') || ''})\``
        )
        .join('\n');

      const extendsInfo = cachedClass.extendsClass ? `\n**Extends:** ${cachedClass.extendsClass}` : '';
      const modifiers = [];
      if (cachedClass.isFinal) modifiers.push('final');
      if (cachedClass.isAbstract) modifiers.push('abstract');
      const modifiersInfo = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : '';

      let text = `# Class: ${cachedClass.name}${modifiersInfo}${extendsInfo}\n\n`;
      text += `## Methods (${totalMethods} total, showing ${methodOffset + 1}–${Math.min(methodOffset + METHOD_PAGE_SIZE, totalMethods)})\n\n`;
      text += methodLines;
      if (hasMore) {
        text += `\n\n> ⚠️ **${totalMethods - methodOffset - METHOD_PAGE_SIZE} more methods.** Call again with \`methodOffset: ${methodOffset + METHOD_PAGE_SIZE}\` to see next page.`;
      }

      return {
        content: [{ type: 'text', text }],
      };
    }

    // Try C# bridge first (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeClass(context.bridge, args.className, args.compact !== false, args.methodOffset ?? 0);
    if (bridgeResult) return bridgeResult;

    // Query database and parse
    const classSymbol = symbolIndex.getSymbolByName(args.className, 'class');

    if (!classSymbol) {
      const typeMismatch = buildObjectTypeMismatchMessage(symbolIndex.db, args.className);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Class "${args.className}" not found in symbol index.${typeMismatch}`,
          },
        ],
        isError: true,
      };
    }

    // compact=true (default): serve entirely from DB — no filesystem access, instant response
    if (args.compact !== false) {
      return buildDbOnlyResponse(args.className, classSymbol, symbolIndex, args.methodOffset ?? 0, cache, cacheKey);
    }

    // compact=false: parse XML for source bodies, with timeout guard to avoid hanging
    let classInfo: any = { success: false };
    try {
      classInfo = await Promise.race([
        parser.parseClassFile(classSymbol.filePath),
        new Promise<{ success: false; error: string }>(resolve =>
          setTimeout(() => resolve({ success: false, error: 'timeout' }), 3000)
        ),
      ]);
    } catch {
      classInfo = { success: false, error: 'file read error' };
    }

    if (!classInfo.success || !classInfo.data) {
      // Fallback to DB when XML not available (build agent, no D365FO install, timeout)
      return buildDbOnlyResponse(args.className, classSymbol, symbolIndex, args.methodOffset ?? 0, cache, cacheKey);
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

    const methodOffset = args.methodOffset ?? 0;
    const pagedMethods = cls.methods.slice(methodOffset, methodOffset + METHOD_PAGE_SIZE);
    const totalMethods = cls.methods.length;
    const hasMore = methodOffset + METHOD_PAGE_SIZE < totalMethods;

    output += `## Methods (${totalMethods} total`;
    if (totalMethods > METHOD_PAGE_SIZE) {
      output += `, showing ${methodOffset + 1}–${Math.min(methodOffset + METHOD_PAGE_SIZE, totalMethods)}`;
    }
    output += `)\n\n`;

    for (const method of pagedMethods) {
      const params = method.parameters.map((p: { type: string; name: string }) => `${p.type} ${p.name}`).join(', ');
      if (args.compact) {
        // Compact mode: one line per method, signature only
        output += `- \`${method.visibility}${method.isStatic ? ' static' : ''} ${method.returnType} ${method.name}(${params})\`\n`;
      } else {
        output += `### ${method.name}\n\n`;
        output += `- **Visibility:** ${method.visibility}\n`;
        output += `- **Returns:** ${method.returnType}\n`;
        output += `- **Static:** ${method.isStatic ? 'Yes' : 'No'}\n`;
        output += `- **Signature:** \`${method.returnType} ${method.name}(${params})\`\n\n`;
        
        if (method.documentation) {
          output += `**Documentation:**\n${method.documentation}\n\n`;
        }
        
        output += `\`\`\`xpp\n${method.source.substring(0, 200)}${method.source.length > 200 ? '\n// ... (use get_method_signature for full body)' : ''}\n\`\`\`\n\n`;
      }
    }

    if (hasMore) {
      output += `> ⚠️ **${totalMethods - methodOffset - METHOD_PAGE_SIZE} more methods not shown.** Call again with \`methodOffset: ${methodOffset + METHOD_PAGE_SIZE}\` to see the next page.\n\n`;
    }

    // Write to cache for 24 hours (normalize to shape expected by cache-hit path)
    await cache.setClassInfo(cacheKey, {
      name: cls.name,
      extendsClass: cls.extends,
      isFinal: cls.isFinal,
      isAbstract: cls.isAbstract,
      methods: cls.methods.map((m: any) => ({
        name: m.name,
        isStatic: m.isStatic,
        returnType: m.returnType,
        parameters: m.parameters.map((p: { type: string; name: string }) => `${p.type} ${p.name}`),
      })),
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
          text: `Error getting class info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Build a response from DB data only — no filesystem access, instant.
 * Used for compact=true (default) and as fallback when XML is unavailable.
 */
async function buildDbOnlyResponse(
  className: string,
  classSymbol: any,
  symbolIndex: any,
  methodOffset: number,
  cache: any,
  cacheKey: string
): Promise<any> {
  const methods = symbolIndex.getClassMethods(className) as Array<{ name: string; signature?: string; isStatic?: boolean }>;

  // Build a concise header
  let output = `# Class: ${className}`;
  if (classSymbol.extendsClass) output += ` extends ${classSymbol.extendsClass}`;
  output += `\n**Model:** ${classSymbol.model}`;
  if (classSymbol.implementsInterfaces) output += `  **Implements:** ${classSymbol.implementsInterfaces}`;
  output += '\n\n';

  const totalMethods = methods.length;
  const paged = methods.slice(methodOffset, methodOffset + METHOD_PAGE_SIZE);
  const hasMore = methodOffset + METHOD_PAGE_SIZE < totalMethods;

  output += `## Methods (${totalMethods} total, showing ${methodOffset + 1}–${Math.min(methodOffset + METHOD_PAGE_SIZE, totalMethods)})\n\n`;
  for (const m of paged) {
    const sig = m.signature || m.name;
    output += `- \`${sig}\`\n`;
  }
  if (hasMore) {
    output += `\n> ⚠️ ${totalMethods - methodOffset - METHOD_PAGE_SIZE} more — call with \`methodOffset: ${methodOffset + METHOD_PAGE_SIZE}\`\n`;
  }
  output += `\n> 💡 Use \`get_method_signature\` for a full method body.\n`;

  // Cache so next call is instant
  await cache.setClassInfo(cacheKey, {
    name: className,
    extendsClass: classSymbol.extendsClass ?? null,
    isFinal: false,
    isAbstract: false,
    methods: methods.map((m: any) => ({
      name: m.name,
      isStatic: m.isStatic ?? false,
      returnType: m.signature ?? 'void',
      parameters: [],
    })),
  });

  return { content: [{ type: 'text', text: output }] };
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
