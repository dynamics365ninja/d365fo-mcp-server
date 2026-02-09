/**
 * Class Completeness Analysis Tool
 * Analyze class and suggest missing methods based on patterns
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const AnalyzeClassCompletenessArgsSchema = z.object({
  className: z.string().describe('Name of the class to analyze'),
});

export async function analyzeClassCompletenessTool(request: CallToolRequest, context: XppServerContext) {
  const args = AnalyzeClassCompletenessArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    const classSymbol = symbolIndex.getSymbolByName(args.className, 'class');
    
    if (!classSymbol) {
      return {
        content: [{
          type: 'text',
          text: `Class "${args.className}" not found in the index.\n\n` +
                `**Suggestions:**\n` +
                `- Check spelling of the class name\n` +
                `- Use \`search\` tool to find the correct name\n` +
                `- Ensure metadata has been extracted for this model`
        }],
        isError: true
      };
    }
    
    // Check cache first
    const cacheKey = `completeness:${args.className}`;
    const cachedResults = await cache.get<any>(cacheKey);
    
    if (cachedResults) {
      return {
        content: [{ type: 'text', text: formatAnalysis(cachedResults, classSymbol) }],
      };
    }

    const existingMethods = symbolIndex.getClassMethods(args.className);
    const suggestedMethods = symbolIndex.suggestMissingMethods(args.className);
    
    const analysis = {
      existingMethods,
      suggestedMethods
    };
    
    // Cache results
    await cache.set(cacheKey, analysis, 600); // Cache for 10 minutes
    
    const formatted = formatAnalysis(analysis, classSymbol);
    
    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error analyzing class completeness: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

function formatAnalysis(analysis: any, classSymbol: any): string {
  const { existingMethods, suggestedMethods } = analysis;
  
  let output = `# Class Completeness Analysis\n\n`;
  output += `**Class:** ${classSymbol.name}\n`;
  output += `**Model:** ${classSymbol.model}\n`;
  output += `**Pattern Type:** ${classSymbol.patternType || 'Unknown'}\n`;
  output += `**Existing Methods:** ${existingMethods.length}\n\n`;
  
  if (existingMethods.length > 0) {
    output += `## Implemented Methods\n\n`;
    output += `Current methods in ${classSymbol.name}:\n\n`;
    for (const method of existingMethods) {
      output += `- \`${method.signature || method.name}\`\n`;
    }
    output += '\n';
  }
  
  if (suggestedMethods && suggestedMethods.length > 0) {
    output += `## 💡 Suggested Missing Methods\n\n`;
    output += `Based on analysis of similar ${classSymbol.patternType || 'classes'} in your codebase:\n\n`;
    
    for (const suggestion of suggestedMethods) {
      const percentage = suggestion.percentage || 0;
      const frequency = suggestion.frequency || 0;
      const total = suggestion.totalClasses || 0;
      
      let importance = '🔵';
      if (percentage >= 80) importance = '🔴'; // Very common
      else if (percentage >= 50) importance = '🟠'; // Common
      else if (percentage >= 30) importance = '🟡'; // Somewhat common
      
      output += `${importance} **${suggestion.methodName}**: Found in ${percentage}% of similar classes (${frequency}/${total})\n`;
    }
    output += '\n';
    output += `**Legend:**\n`;
    output += `- 🔴 Very common (80%+) - Strongly recommended\n`;
    output += `- 🟠 Common (50%+) - Recommended\n`;
    output += `- 🟡 Somewhat common (30%+) - Consider adding\n`;
    output += `- 🔵 Less common - Optional\n\n`;
    
    output += `**Recommendation:** Consider implementing the 🔴 and 🟠 methods to follow common patterns in your codebase.\n\n`;
    
    output += `**Next Steps:**\n`;
    output += `1. Use \`suggest_method_implementation\` for specific methods to get implementation examples\n`;
    output += `2. Use \`search\` to find classes that implement these methods\n`;
    output += `3. Use \`get_class_info\` to study similar classes\n`;
  } else {
    output += `## ✅ Analysis Result\n\n`;
    output += `No commonly missing methods detected. Class appears complete for its ${classSymbol.patternType || 'pattern'} type.\n\n`;
    
    if (existingMethods.length === 0) {
      output += `**Note:** No existing methods found. This might be:\n`;
      output += `- A newly created class\n`;
      output += `- A class with only inherited methods\n`;
      output += `- An issue with metadata parsing\n`;
    }
  }
  
  return output;
}
