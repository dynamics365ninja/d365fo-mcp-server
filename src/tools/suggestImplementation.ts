/**
 * Method Implementation Suggestion Tool
 * Suggest method body based on similar methods in codebase
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const SuggestMethodImplementationArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method to suggest implementation for'),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string()
  })).optional().describe('Method parameters'),
  returnType: z.string().optional().default('void').describe('Method return type'),
});

export async function suggestMethodImplementationTool(request: CallToolRequest, context: XppServerContext) {
  const args = SuggestMethodImplementationArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    // Check cache first
    const cacheKey = `suggest:${args.className}:${args.methodName}`;
    const cachedResults = await cache.get<any>(cacheKey);
    
    if (cachedResults) {
      return {
        content: [{ type: 'text', text: formatSuggestion(cachedResults, args) }],
      };
    }

    // Find similar methods
    const similarMethods = symbolIndex.findSimilarMethods(args.methodName, args.className, 5);
    
    // Cache results
    await cache.set(cacheKey, similarMethods, 300); // Cache for 5 minutes
    
    if (similarMethods.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No similar methods found for "${args.methodName}". Try using more generic method names or check spelling.\n\n` +
                `**Suggestions:**\n` +
                `- Check for typos in the method name\n` +
                `- Try a more general name (e.g., "validate" instead of "validateSpecificThing")\n` +
                `- Use \`search\` tool to find related methods in the codebase`
        }]
      };
    }
    
    const formatted = formatSuggestion(similarMethods, args);
    
    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error suggesting method implementation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

function formatSuggestion(similarMethods: any[], args: any): string {
  const { className, methodName, parameters = [], returnType = 'void' } = args;
  
  let output = `# Method Implementation Suggestions\n\n`;
  output += `**Class:** ${className}\n`;
  output += `**Method:** ${returnType} ${methodName}(${parameters.map((p: any) => `${p.type} ${p.name}`).join(', ')})\n\n`;
  
  if (similarMethods.length > 0) {
    output += `## Similar Methods in Codebase\n\n`;
    output += `Found ${similarMethods.length} similar implementations to learn from:\n\n`;
    
    for (let i = 0; i < similarMethods.length; i++) {
      const similar = similarMethods[i];
      output += `### ${i + 1}. ${similar.className}.${similar.methodName}\n\n`;
      output += `**Signature:** \`${similar.signature || similar.methodName}\`\n`;
      if (similar.complexity) {
        output += `**Complexity:** ${similar.complexity}\n`;
      }
      if (similar.tags && similar.tags.length > 0) {
        output += `**Tags:** ${similar.tags.join(', ')}\n`;
      }
      if (similar.patternType) {
        output += `**Pattern:** ${similar.patternType}\n`;
      }
      output += `\n**Implementation Preview:**\n\n\`\`\`xpp\n${similar.sourceSnippet || 'Source not available'}\n\`\`\`\n\n`;
    }
  }
  
  output += `## Suggested Implementation Pattern\n\n`;
  output += `Based on similar methods in your codebase, here's a suggested implementation:\n\n`;
  output += `\`\`\`xpp\n`;
  output += `public ${returnType} ${methodName}(${parameters.map((p: any) => `${p.type} _${p.name}`).join(', ')})\n`;
  output += `{\n`;
  
  // Generate contextual implementation suggestions
  const nameL = methodName.toLowerCase();
  
  if (nameL.includes('validate') || nameL.includes('check') || nameL.includes('verify')) {
    output += `    boolean isValid = true;\n`;
    output += `    \n`;
    output += `    // Add validation logic here\n`;
    output += `    if (!condition)\n`;
    output += `    {\n`;
    output += `        isValid = false;\n`;
    output += `        error("Validation failed");\n`;
    output += `    }\n`;
    output += `    \n`;
    output += `    return isValid;\n`;
  } else if (nameL.includes('find') || nameL.includes('get') || nameL.includes('select')) {
    output += `    ${returnType} result;\n`;
    output += `    \n`;
    output += `    select firstonly result\n`;
    output += `        where /* add conditions */;\n`;
    output += `    \n`;
    output += `    return result;\n`;
  } else if (nameL.includes('create') || nameL.includes('insert') || nameL.includes('new')) {
    output += `    ${returnType} result;\n`;
    output += `    \n`;
    output += `    ttsbegin;\n`;
    output += `    \n`;
    output += `    // Initialize record\n`;
    output += `    // Set field values\n`;
    output += `    // result.insert();\n`;
    output += `    \n`;
    output += `    ttscommit;\n`;
    output += `    \n`;
    output += `    return result;\n`;
  } else if (nameL.includes('update') || nameL.includes('modify')) {
    output += `    ttsbegin;\n`;
    output += `    \n`;
    output += `    // Update logic here\n`;
    output += `    \n`;
    output += `    ttscommit;\n`;
  } else if (nameL.includes('delete') || nameL.includes('remove')) {
    output += `    ttsbegin;\n`;
    output += `    \n`;
    output += `    // Delete logic here\n`;
    output += `    // record.delete();\n`;
    output += `    \n`;
    output += `    ttscommit;\n`;
  } else if (nameL.includes('calculate') || nameL.includes('compute')) {
    output += `    ${returnType} result = 0;\n`;
    output += `    \n`;
    output += `    // Add calculation logic here\n`;
    output += `    \n`;
    output += `    return result;\n`;
  } else {
    output += `    // Add implementation here\n`;
    output += `    // TODO: Review similar methods above for guidance\n`;
  }
  
  output += `}\n`;
  output += `\`\`\`\n\n`;
  
  output += `**Next Steps:**\n`;
  output += `1. Review the similar implementations above\n`;
  output += `2. Use \`get_class_info\` on example classes to see full context\n`;
  output += `3. Adapt the patterns to your specific needs\n`;
  
  return output;
}
