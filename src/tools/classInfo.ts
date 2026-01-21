/**
 * X++ Class Information Tool
 * Get detailed information about an X++ class including its methods
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const ClassInfoArgsSchema = z.object({
  className: z.string().describe('Name of the X++ class'),
});

export async function classInfoTool(request: CallToolRequest, context: XppServerContext) {
  const args = ClassInfoArgsSchema.parse(request.params.arguments);
  const { symbolIndex, parser, cache } = context;

  try {
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
    const classSymbol = symbolIndex.getSymbolByName(args.className);

    if (!classSymbol || classSymbol.type !== 'class') {
      return {
        content: [
          {
            type: 'text',
            text: `Class "${args.className}" not found`,
          },
        ],
        isError: true,
      };
    }

    const classInfo = await parser.parseClassFile(classSymbol.filePath);

    if (!classInfo.success || !classInfo.data) {
      return {
        content: [
          {
            type: 'text',
            text: `Error parsing class: ${classInfo.error || 'Unknown error'}`,
          },
        ],
        isError: true,
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
