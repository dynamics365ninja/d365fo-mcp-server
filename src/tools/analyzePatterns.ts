/**
 * Code Pattern Analysis Tool
 * Analyze existing codebase for similar patterns and implementations
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const AnalyzeCodePatternsArgsSchema = z.object({
  scenario: z.string().describe('Scenario or domain to analyze (e.g., "dimension", "validation", "customer")'),
  classPattern: z.string().optional().describe('Class name pattern filter (e.g., "Helper", "Service")'),
  limit: z.number().optional().default(20).describe('Maximum number of classes to analyze'),
});

export async function analyzeCodePatternsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = AnalyzeCodePatternsArgsSchema.parse(request.params.arguments);
    const { symbolIndex, cache } = context;
    // Check cache first
    const cacheKey = `pattern:${args.scenario}:${args.classPattern || 'all'}:${args.limit}`;
    const cachedResults = await cache.get<any>(cacheKey);
    
    if (cachedResults) {
      return {
        content: [{ type: 'text', text: formatPatternAnalysis(cachedResults) }],
      };
    }

    // Analyze patterns
    const analysis = symbolIndex.analyzeCodePatterns(args.scenario, args.classPattern, args.limit);
    
    // Cache results
    await cache.set(cacheKey, analysis, 300); // Cache for 5 minutes
    
    const formatted = formatPatternAnalysis(analysis);
    
    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error analyzing code patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

function formatPatternAnalysis(analysis: any): string {
  let output = `# Code Pattern Analysis: ${analysis.scenario || 'Unknown'}\n\n`;
  output += `**Total Matching Classes:** ${analysis.totalMatches}\n\n`;
  
  if (analysis.patterns && analysis.patterns.length > 0) {
    output += `## Detected Patterns\n\n`;
    for (const pattern of analysis.patterns) {
      output += `- **${pattern.patternType}**: ${pattern.count} classes\n`;
      if (pattern.examples && pattern.examples.length > 0) {
        output += `  Examples: ${pattern.examples.join(', ')}\n`;
      }
    }
    output += '\n';
  }
  
  if (analysis.commonMethods && analysis.commonMethods.length > 0) {
    output += `## Common Methods (Most Frequent)\n\n`;
    for (const method of analysis.commonMethods.slice(0, 10)) {
      output += `- **${method.name}**: found in ${method.frequency} classes\n`;
    }
    output += '\n';
  }
  
  if (analysis.commonDependencies && analysis.commonDependencies.length > 0) {
    output += `## Common Dependencies\n\n`;
    for (const dep of analysis.commonDependencies.slice(0, 10)) {
      output += `- **${dep.name}**: used by ${dep.frequency} classes\n`;
    }
    output += '\n';
  }
  
  if (analysis.exampleClasses && analysis.exampleClasses.length > 0) {
    output += `## Example Classes to Study\n\n`;
    for (const cls of analysis.exampleClasses) {
      output += `- ${cls}\n`;
    }
    output += '\n';
    output += `**Tip:** Use \`get_class_info\` on these classes to see their implementation details.\n`;
  }
  
  return output;
}
