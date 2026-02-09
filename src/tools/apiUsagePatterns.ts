/**
 * API Usage Patterns Tool
 * Analyze how specific APIs are commonly used in the codebase
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const GetApiUsagePatternsArgsSchema = z.object({
  apiName: z.string().describe('Name of the API/class/method to analyze'),
  context: z.string().optional().describe('Optional context (e.g., "dimension", "posting", "workflow")'),
});

export async function getApiUsagePatternsTool(request: CallToolRequest, context: XppServerContext) {
  const args = GetApiUsagePatternsArgsSchema.parse(request.params.arguments);
  const { symbolIndex, cache } = context;

  try {
    // Check cache first
    const cacheKey = `api-patterns:${args.apiName}:${args.context || 'general'}`;
    const cachedResults = await cache.get<any>(cacheKey);
    
    if (cachedResults) {
      return {
        content: [{ type: 'text', text: formatPatterns(cachedResults, args.apiName) }],
      };
    }

    const patterns = symbolIndex.getApiUsagePatterns(args.apiName);
    
    // Cache results
    await cache.set(cacheKey, patterns, 1800); // Cache for 30 minutes
    
    const formatted = formatPatterns(patterns, args.apiName);
    
    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error analyzing API usage patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

function formatPatterns(patterns: any[], apiName: string): string {
  let output = `# API Usage Patterns: ${apiName}\n\n`;
  
  if (patterns.length === 0) {
    output += `No usage patterns found for "${apiName}".\n\n`;
    output += `**Suggestions:**\n`;
    output += `- Try a different API name or partial name\n`;
    output += `- Use \`search\` tool to find available APIs\n`;
    output += `- Check if the API is from a standard model (ApplicationSuite, ApplicationPlatform)\n`;
    return output;
  }
  
  output += `Found ${patterns.length} usage pattern${patterns.length === 1 ? '' : 's'} in the codebase:\n\n`;
  
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    
    output += `## Pattern ${i + 1}: ${pattern.patternType || 'General Usage'}\n\n`;
    
    if (pattern.usageCount) {
      output += `**Frequency:** Found in ${pattern.usageCount} location${pattern.usageCount === 1 ? '' : 's'}\n`;
    }
    
    if (pattern.classes && pattern.classes.length > 0) {
      output += `**Common in:** ${pattern.classes.slice(0, 5).join(', ')}${pattern.classes.length > 5 ? `, +${pattern.classes.length - 5} more` : ''}\n`;
    }
    
    output += '\n';
    
    // Initialization pattern
    if (pattern.initialization && pattern.initialization.length > 0) {
      output += `### Initialization\n\n`;
      output += `Common initialization pattern:\n\n`;
      output += '```xpp\n';
      for (const line of pattern.initialization) {
        output += `${line}\n`;
      }
      output += '```\n\n';
    }
    
    // Method sequence pattern
    if (pattern.methodSequence && pattern.methodSequence.length > 0) {
      output += `### Typical Method Sequence\n\n`;
      output += `Methods commonly called after initialization:\n\n`;
      output += '```xpp\n';
      for (const method of pattern.methodSequence) {
        output += `${method}\n`;
      }
      output += '```\n\n';
    }
    
    // Complete example
    if (pattern.completeExample) {
      output += `### Complete Example\n\n`;
      output += '```xpp\n';
      output += pattern.completeExample;
      output += '\n```\n\n';
    }
    
    // Error handling pattern
    if (pattern.errorHandling && pattern.errorHandling.length > 0) {
      output += `### Error Handling\n\n`;
      output += `Common error handling approach:\n\n`;
      output += '```xpp\n';
      for (const line of pattern.errorHandling) {
        output += `${line}\n`;
      }
      output += '```\n\n';
    }
    
    // Related APIs
    if (pattern.relatedApis && pattern.relatedApis.length > 0) {
      output += `### Related APIs\n\n`;
      output += `Often used together with:\n`;
      for (const api of pattern.relatedApis) {
        output += `- \`${api}\`\n`;
      }
      output += '\n';
    }
    
    // Common parameters
    if (pattern.commonParameters && pattern.commonParameters.length > 0) {
      output += `### Common Parameters\n\n`;
      for (const param of pattern.commonParameters) {
        output += `- **${param.name}**: ${param.description || 'No description'}\n`;
        if (param.typicalValue) {
          output += `  - Typical value: \`${param.typicalValue}\`\n`;
        }
      }
      output += '\n';
    }
    
    // Best practices
    if (pattern.bestPractices && pattern.bestPractices.length > 0) {
      output += `### Best Practices\n\n`;
      for (const practice of pattern.bestPractices) {
        output += `- ${practice}\n`;
      }
      output += '\n';
    }
  }
  
  // Overall recommendations
  output += `## 💡 Recommendations\n\n`;
  output += `**To use ${apiName} effectively:**\n\n`;
  output += `1. Follow the initialization pattern shown above\n`;
  output += `2. Call methods in the typical sequence\n`;
  output += `3. Implement proper error handling\n`;
  output += `4. Consider using related APIs for complete functionality\n\n`;
  
  output += `**Next Steps:**\n`;
  output += `- Use \`get_class_info("${apiName}")\` to see all available methods\n`;
  output += `- Use \`code_completion\` to discover method signatures\n`;
  output += `- Use \`search\` to find example implementations\n`;
  
  return output;
}
