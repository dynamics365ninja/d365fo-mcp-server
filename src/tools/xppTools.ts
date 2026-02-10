/**
 * X++ MCP Tools
 * MCP tool definitions for X++ code completion
 */

import { z } from 'zod';
import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import type { XppMetadataParser } from '../metadata/xmlParser.js';

// ============================================
// Tool Input Schemas
// ============================================

export const SearchSchema = z.object({
  query: z.string().describe('Search query (class name, method name, table name, etc.)'),
  types: z.array(z.enum(['class', 'table', 'method', 'field', 'enum', 'edt']))
    .optional()
    .describe('Filter by symbol types'),
  limit: z.number().optional().default(20).describe('Maximum results to return')
});

export const SearchExtensionsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  prefix: z.string().optional().describe('Extension prefix filter (e.g., ISV_, Custom_)'),
  limit: z.number().optional().default(20).describe('Maximum results to return')
});

export const GetClassSchema = z.object({
  className: z.string().describe('Name of the X++ class')
});

export const GetTableSchema = z.object({
  tableName: z.string().describe('Name of the X++ table')
});

export const CompleteMethodSchema = z.object({
  className: z.string().describe('Class or table name'),
  prefix: z.string().optional().default('').describe('Method/field name prefix to filter')
});

export const GenerateCodeSchema = z.object({
  pattern: z.enum([
    'class',
    'runnable',
    'form-handler',
    'data-entity',
    'batch-job',
    'coc-extension',
    'event-handler',
    'service-class'
  ]).describe('Code pattern to generate'),
  name: z.string().describe('Name for the generated element'),
  options: z.object({
    baseClass: z.string().optional(),
    tableName: z.string().optional(),
    formName: z.string().optional()
  }).optional().describe('Additional options for code generation')
});

export const AnalyzeCodePatternsSchema = z.object({
  scenario: z.string().describe('Scenario or domain to analyze (e.g., "dimension", "validation", "customer")'),
  classPattern: z.string().optional().describe('Class name pattern filter (e.g., "Helper", "Service")'),
  limit: z.number().optional().default(20).describe('Maximum number of classes to analyze')
});

export const SuggestMethodImplementationSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method to suggest implementation for'),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string()
  })).optional().describe('Method parameters'),
  returnType: z.string().optional().default('void').describe('Method return type')
});

export const AnalyzeClassCompletenessSchema = z.object({
  className: z.string().describe('Name of the class to analyze')
});

export const GetApiUsagePatternsSchema = z.object({
  className: z.string().describe('Name of the class/API to get usage patterns for')
});

// ============================================
// Tool Result Types
// ============================================

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ============================================
// Tool Implementations
// ============================================

export function createSearchTool(symbolIndex: XppSymbolIndex) {
  return async (args: z.infer<typeof SearchSchema>): Promise<ToolResult> => {
    const { query, types, limit } = args;
    
    const results = types && types.length > 0
      ? symbolIndex.searchByPrefix(query, types, limit)
      : symbolIndex.searchSymbols(query, limit);

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No X++ symbols found matching "${query}"` }]
      };
    }

    const formatted = results.map((s: { parentName?: string; name: string; type: string; signature?: string }) => {
      const qualified = s.parentName ? `${s.parentName}.${s.name}` : s.name;
      return `[${s.type.toUpperCase()}] ${qualified}${s.signature ? ` - ${s.signature}` : ''}`;
    }).join('\n');

    return {
      content: [{ 
        type: 'text', 
        text: `Found ${results.length} matches:\n\n${formatted}` 
      }]
    };
  };
}

export function createGetClassTool(symbolIndex: XppSymbolIndex, parser: XppMetadataParser) {
  return async (args: z.infer<typeof GetClassSchema>): Promise<ToolResult> => {
    const { className } = args;
    
    const classSymbol = symbolIndex.getSymbolByName(className, 'class');
    
    if (!classSymbol) {
      return {
        content: [{ type: 'text', text: `Class "${className}" not found` }],
        isError: true
      };
    }

    const result = await parser.parseClassFile(classSymbol.filePath, classSymbol.model);
    
    if (!result.success || !result.data) {
      return {
        content: [{ type: 'text', text: `Error parsing class "${className}": ${result.error}` }],
        isError: true
      };
    }

    const cls = result.data;
    let output = `# Class: ${cls.name}\n\n`;
    output += `**Model:** ${cls.model}\n`;
    output += cls.extends ? `**Extends:** ${cls.extends}\n` : '';
    output += cls.implements.length ? `**Implements:** ${cls.implements.join(', ')}\n` : '';
    output += cls.isAbstract ? '**Abstract:** Yes\n' : '';
    output += cls.isFinal ? '**Final:** Yes\n' : '';
    
    output += `\n## Declaration\n\`\`\`xpp\n${cls.declaration}\n\`\`\`\n`;
    
    output += `\n## Methods (${cls.methods.length})\n`;
    
    for (const method of cls.methods) {
      const params = method.parameters.map((p: { type: string; name: string }) => `${p.type} ${p.name}`).join(', ');
      output += `\n### ${method.visibility} ${method.returnType} ${method.name}(${params})\n`;
      if (method.isStatic) output += `- Static method\n`;
      if (method.documentation) output += `\n${method.documentation}\n`;
      output += `\n\`\`\`xpp\n${method.source}\n\`\`\`\n`;
    }

    return {
      content: [{ type: 'text', text: output }]
    };
  };
}

export function createGetTableTool(symbolIndex: XppSymbolIndex, parser: XppMetadataParser) {
  return async (args: z.infer<typeof GetTableSchema>): Promise<ToolResult> => {
    const { tableName } = args;
    
    const tableSymbol = symbolIndex.getSymbolByName(tableName, 'table');
    
    if (!tableSymbol) {
      return {
        content: [{ type: 'text', text: `Table "${tableName}" not found` }],
        isError: true
      };
    }

    const result = await parser.parseTableFile(tableSymbol.filePath, tableSymbol.model);
    
    if (!result.success || !result.data) {
      return {
        content: [{ type: 'text', text: `Error parsing table "${tableName}": ${result.error}` }],
        isError: true
      };
    }

    const tbl = result.data;
    let output = `# Table: ${tbl.name}\n\n`;
    output += `**Model:** ${tbl.model}\n`;
    output += `**Label:** ${tbl.label}\n`;
    output += `**Table Group:** ${tbl.tableGroup}\n`;
    if (tbl.primaryIndex) output += `**Primary Index:** ${tbl.primaryIndex}\n`;
    if (tbl.clusteredIndex) output += `**Clustered Index:** ${tbl.clusteredIndex}\n`;
    
    output += `\n## Fields (${tbl.fields.length})\n\n`;
    output += '| Name | Type | EDT | Mandatory | Label |\n';
    output += '|------|------|-----|-----------|-------|\n';
    for (const field of tbl.fields) {
      output += `| ${field.name} | ${field.type} | ${field.extendedDataType || '-'} | ${field.mandatory ? 'Yes' : 'No'} | ${field.label || '-'} |\n`;
    }

    if (tbl.indexes.length > 0) {
      output += `\n## Indexes (${tbl.indexes.length})\n\n`;
      for (const idx of tbl.indexes) {
        output += `- **${idx.name}**: [${idx.fields.join(', ')}]`;
        if (idx.unique) output += ' (unique)';
        if (idx.clustered) output += ' (clustered)';
        output += '\n';
      }
    }

    if (tbl.relations.length > 0) {
      output += `\n## Relations (${tbl.relations.length})\n\n`;
      for (const rel of tbl.relations) {
        const constraints = rel.constraints.map((c: { field: string; relatedField: string }) => `${c.field} = ${c.relatedField}`).join(', ');
        output += `- **${rel.name}** → ${rel.relatedTable} (${constraints})\n`;
      }
    }

    if (tbl.methods.length > 0) {
      output += `\n## Methods (${tbl.methods.length})\n\n`;
      for (const method of tbl.methods) {
        const params = method.parameters.map((p: { type: string; name: string }) => `${p.type} ${p.name}`).join(', ');
        output += `- \`${method.returnType} ${method.name}(${params})\`\n`;
      }
    }

    return {
      content: [{ type: 'text', text: output }]
    };
  };
}

export function createCompleteMethodTool(symbolIndex: XppSymbolIndex) {
  return async (args: z.infer<typeof CompleteMethodSchema>): Promise<ToolResult> => {
    const { className, prefix } = args;
    
    const completions = symbolIndex.getCompletions(className, prefix);

    if (completions.length === 0) {
      return {
        content: [{ 
          type: 'text', 
          text: `No members found for "${className}"${prefix ? ` starting with "${prefix}"` : ''}` 
        }]
      };
    }

    const formatted = completions.map((c: { label: string; kind: string; detail?: string; documentation?: string }) => ({
      label: c.label,
      kind: c.kind,
      detail: c.detail,
      documentation: c.documentation
    }));

    return {
      content: [{ 
        type: 'text', 
        text: `## Completions for ${className}${prefix ? `.${prefix}*` : ''}\n\n\`\`\`json\n${JSON.stringify(formatted, null, 2)}\n\`\`\`` 
      }]
    };
  };
}

export function createGenerateCodeTool() {
  return async (args: z.infer<typeof GenerateCodeSchema>): Promise<ToolResult> => {
    const { pattern, name, options = {} } = args;

    const templates: Record<string, string> = {
      'class': `/// <summary>
/// ${name} class
/// </summary>
public class ${name}${options.baseClass ? ` extends ${options.baseClass}` : ''}
{
    /// <summary>
    /// Main entry point
    /// </summary>
    public void run()
    {
        // TODO: Implement
    }
}`,

      'runnable': `/// <summary>
/// Runnable class ${name}
/// </summary>
internal final class ${name}
{
    /// <summary>
    /// Main entry point for the runnable class
    /// </summary>
    /// <param name="_args">Arguments passed to the class</param>
    public static void main(Args _args)
    {
        ${name} instance = new ${name}();
        instance.run();
    }

    /// <summary>
    /// Executes the business logic
    /// </summary>
    public void run()
    {
        // TODO: Implement business logic
        info("${name} executed successfully");
    }
}`,

      'form-handler': `/// <summary>
/// Form extension for ${options.formName || name}
/// </summary>
[ExtensionOf(formStr(${options.formName || name}))]
final class ${name}Form_Extension
{
    /// <summary>
    /// Form initialization
    /// </summary>
    public void init()
    {
        next init();
        // TODO: Add initialization logic
    }

    /// <summary>
    /// Form close handler
    /// </summary>
    public void close()
    {
        // TODO: Add cleanup logic
        next close();
    }
}`,

      'data-entity': `/// <summary>
/// Data entity for ${options.tableName || name}
/// </summary>
public class ${name}Entity extends common
{
    /// <summary>
    /// Finds a record by RecId
    /// </summary>
    /// <param name="_recId">Record ID to find</param>
    /// <param name="_forUpdate">Select for update flag</param>
    /// <returns>The found entity record</returns>
    public static ${name}Entity find(RecId _recId, boolean _forUpdate = false)
    {
        ${name}Entity entity;
        
        entity.selectForUpdate(_forUpdate);
        
        select firstonly entity
            where entity.RecId == _recId;
            
        return entity;
    }

    /// <summary>
    /// Checks if record exists
    /// </summary>
    /// <param name="_recId">Record ID to check</param>
    /// <returns>True if exists</returns>
    public static boolean exist(RecId _recId)
    {
        return _recId && (select firstonly RecId from ${name}Entity
            where ${name}Entity.RecId == _recId).RecId != 0;
    }
}`,

      'batch-job': `/// <summary>
/// Batch job ${name}
/// </summary>
class ${name} extends SysOperationServiceController
{
    /// <summary>
    /// Main entry point
    /// </summary>
    /// <param name="_args">Arguments</param>
    public static void main(Args _args)
    {
        ${name} controller = new ${name}();
        controller.parmArgs(_args);
        controller.startOperation();
    }

    /// <summary>
    /// Constructor
    /// </summary>
    protected void new()
    {
        super();
        this.parmClassName(classStr(${name}Service));
        this.parmMethodName(methodStr(${name}Service, process));
        this.parmDialogCaption("${name}");
    }

    /// <summary>
    /// Provides description for batch job
    /// </summary>
    /// <returns>Description string</returns>
    public ClassDescription defaultCaption()
    {
        return "${name}";
    }
}`,

      'coc-extension': `/// <summary>
/// Chain of Command extension for ${options.baseClass || 'TargetClass'}
/// </summary>
[ExtensionOf(classStr(${options.baseClass || 'TargetClass'}))]
final class ${name}_Extension
{
    /// <summary>
    /// Extended method implementation
    /// </summary>
    public void methodName()
    {
        // Pre-processing logic
        
        next methodName();
        
        // Post-processing logic
    }
}`,

      'event-handler': `/// <summary>
/// Event handler class for ${name}
/// </summary>
public class ${name}EventHandler
{
    /// <summary>
    /// Handles the onValidating event
    /// </summary>
    /// <param name="_sender">Event sender</param>
    /// <param name="_e">Event arguments</param>
    [DataEventHandler(tableStr(${options.tableName || 'TargetTable'}), DataEventType::Inserting)]
    public static void onInserting(Common _sender, DataEventArgs _e)
    {
        ${options.tableName || 'TargetTable'} record = _sender as ${options.tableName || 'TargetTable'};
        
        // TODO: Implement event handling logic
    }

    /// <summary>
    /// Post-event handler
    /// </summary>
    [PostHandlerFor(classStr(${options.baseClass || 'TargetClass'}), methodStr(${options.baseClass || 'TargetClass'}, targetMethod))]
    public static void postTargetMethod(XppPrePostArgs _args)
    {
        // TODO: Implement post-event logic
    }
}`,

      'service-class': `/// <summary>
/// Service class ${name}
/// </summary>
class ${name}Service extends SysOperationServiceBase
{
    /// <summary>
    /// Main processing method
    /// </summary>
    /// <param name="_contract">Data contract with parameters</param>
    public void process(${name}Contract _contract)
    {
        ttsbegin;
        
        try
        {
            this.processInternal(_contract);
        }
        catch (Exception::Error)
        {
            error("An error occurred during processing");
            throw Exception::Error;
        }
        
        ttscommit;
        
        info("Processing completed successfully");
    }

    /// <summary>
    /// Internal processing logic
    /// </summary>
    /// <param name="_contract">Data contract</param>
    private void processInternal(${name}Contract _contract)
    {
        // TODO: Implement business logic
    }
}`
    };

    const code = templates[pattern];
    
    if (!code) {
      return {
        content: [{ type: 'text', text: `Unknown pattern: ${pattern}` }],
        isError: true
      };
    }

    return {
      content: [{ 
        type: 'text', 
        text: `## Generated X++ Code: ${pattern}\n\n\`\`\`xpp\n${code}\n\`\`\`` 
      }]
    };
  };
}

export function createAnalyzeCodePatternsTool(symbolIndex: XppSymbolIndex) {
  return async (args: z.infer<typeof AnalyzeCodePatternsSchema>): Promise<ToolResult> => {
    const { scenario, classPattern, limit } = args;
    
    const analysis = symbolIndex.analyzeCodePatterns(scenario, classPattern, limit);
    
    let output = `# Code Pattern Analysis: ${scenario}\n\n`;
    output += `**Total Matching Classes:** ${analysis.totalMatches}\n\n`;
    
    if (analysis.patterns.length > 0) {
      output += `## Detected Patterns\n\n`;
      for (const pattern of analysis.patterns) {
        output += `- **${pattern.patternType}**: ${pattern.count} classes\n`;
        output += `  Examples: ${pattern.examples.join(', ')}\n`;
      }
      output += '\n';
    }
    
    if (analysis.commonMethods.length > 0) {
      output += `## Common Methods (Top 10)\n\n`;
      for (const method of analysis.commonMethods.slice(0, 10)) {
        output += `- **${method.name}**: found in ${method.frequency} classes\n`;
      }
      output += '\n';
    }
    
    if (analysis.commonDependencies.length > 0) {
      output += `## Common Dependencies\n\n`;
      for (const dep of analysis.commonDependencies.slice(0, 10)) {
        output += `- **${dep.name}**: used by ${dep.frequency} classes\n`;
      }
      output += '\n';
    }
    
    if (analysis.exampleClasses.length > 0) {
      output += `## Example Classes\n\n`;
      for (const cls of analysis.exampleClasses) {
        output += `- ${cls}\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  };
}

export function createSuggestMethodImplementationTool(symbolIndex: XppSymbolIndex, _parser: XppMetadataParser) {
  return async (args: z.infer<typeof SuggestMethodImplementationSchema>): Promise<ToolResult> => {
    const { className, methodName, parameters = [], returnType = 'void' } = args;
    
    // Find similar methods
    const similarMethods = symbolIndex.findSimilarMethods(methodName, className, 5);
    
    if (similarMethods.length === 0) {
      return {
        content: [{ 
          type: 'text', 
          text: `No similar methods found for "${methodName}". Try using more generic method names or check spelling.` 
        }]
      };
    }
    
    let output = `# Method Implementation Suggestions\n\n`;
    output += `**Class:** ${className}\n`;
    output += `**Method:** ${returnType} ${methodName}(${parameters.map(p => `${p.type} ${p.name}`).join(', ')})\n\n`;
    
    output += `## Similar Methods Found\n\n`;
    
    for (let i = 0; i < similarMethods.length; i++) {
      const similar = similarMethods[i];
      output += `### ${i + 1}. ${similar.className}.${similar.methodName}\n\n`;
      output += `**Signature:** \`${similar.signature}\`\n`;
      output += `**Complexity:** ${similar.complexity || 'N/A'}\n`;
      if (similar.tags.length > 0) {
        output += `**Tags:** ${similar.tags.join(', ')}\n`;
      }
      output += `\n**Implementation Preview:**\n\n\`\`\`xpp\n${similar.sourceSnippet || 'Source not available'}\n\`\`\`\n\n`;
    }
    
    output += `## Suggested Implementation Pattern\n\n`;
    output += `Based on similar methods, consider implementing:\n\n`;
    output += `\`\`\`xpp\n`;
    output += `public ${returnType} ${methodName}(${parameters.map(p => `${p.type} _${p.name}`).join(', ')})\n`;
    output += `{\n`;
    output += `    // TODO: Implement method based on similar patterns above\n`;
    
    // Add common patterns based on method name
    if (methodName.toLowerCase().includes('validate')) {
      output += `    boolean isValid = true;\n`;
      output += `    \n`;
      output += `    // Add validation logic here\n`;
      output += `    \n`;
      output += `    return isValid;\n`;
    } else if (methodName.toLowerCase().includes('find') || methodName.toLowerCase().includes('get')) {
      output += `    ${returnType} result;\n`;
      output += `    \n`;
      output += `    // Add query logic here\n`;
      output += `    \n`;
      output += `    return result;\n`;
    } else if (methodName.toLowerCase().includes('create') || methodName.toLowerCase().includes('insert')) {
      output += `    ttsbegin;\n`;
      output += `    \n`;
      output += `    // Add creation logic here\n`;
      output += `    \n`;
      output += `    ttscommit;\n`;
    } else {
      output += `    // Add implementation here\n`;
    }
    
    output += `}\n`;
    output += `\`\`\`\n`;
    
    return {
      content: [{ type: 'text', text: output }]
    };
  };
}

export function createAnalyzeClassCompletenessTool(symbolIndex: XppSymbolIndex) {
  return async (args: z.infer<typeof AnalyzeClassCompletenessSchema>): Promise<ToolResult> => {
    const { className } = args;
    
    const classSymbol = symbolIndex.getSymbolByName(className, 'class');
    
    if (!classSymbol) {
      return {
        content: [{ type: 'text', text: `Class "${className}" not found` }],
        isError: true
      };
    }
    
    const existingMethods = symbolIndex.getClassMethods(className);
    const suggestedMethods = symbolIndex.suggestMissingMethods(className);
    
    let output = `# Class Completeness Analysis: ${className}\n\n`;
    output += `**Model:** ${classSymbol.model}\n`;
    output += `**Pattern Type:** ${classSymbol.patternType || 'Unknown'}\n`;
    output += `**Existing Methods:** ${existingMethods.length}\n\n`;
    
    if (existingMethods.length > 0) {
      output += `## Implemented Methods\n\n`;
      for (const method of existingMethods) {
        output += `- \`${method.signature || method.name}\`\n`;
      }
      output += '\n';
    }
    
    if (suggestedMethods.length > 0) {
      output += `## Suggested Missing Methods\n\n`;
      output += `Based on analysis of similar ${classSymbol.patternType || 'classes'}:\n\n`;
      
      for (const suggestion of suggestedMethods) {
        output += `- **${suggestion.methodName}**: Found in ${suggestion.percentage}% of similar classes (${suggestion.frequency}/${suggestion.totalClasses})\n`;
      }
      output += '\n';
      output += `**Recommendation:** Consider implementing these methods to follow common patterns in your codebase.\n`;
    } else {
      output += `## Analysis Result\n\n`;
      output += `No missing methods detected. Class appears complete for its pattern type.\n`;
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  };
}

export function createGetApiUsagePatternsTool(symbolIndex: XppSymbolIndex) {
  return async (args: z.infer<typeof GetApiUsagePatternsSchema>): Promise<ToolResult> => {
    const { className } = args;
    
    const patterns = symbolIndex.getApiUsagePatterns(className);
    
    let output = `# API Usage Patterns: ${className}\n\n`;
    output += `**Usage Count:** ${patterns.usageCount} places in codebase\n\n`;
    
    if (patterns.usageCount === 0) {
      output += `No usage found for ${className}. This might be:\n`;
      output += `- A new class not yet used\n`;
      output += `- An internal/private class\n`;
      output += `- Misspelled class name\n`;
      return {
        content: [{ type: 'text', text: output }]
      };
    }
    
    if (patterns.commonMethodCalls && patterns.commonMethodCalls.length > 0) {
      output += `## Most Common Method Calls\n\n`;
      for (const call of patterns.commonMethodCalls) {
        output += `- **${call.method}**: called ${call.frequency} times\n`;
      }
      output += '\n';
    }
    
    if (patterns.initPatterns && patterns.initPatterns.length > 0) {
      output += `## Common Initialization Patterns\n\n`;
      for (let i = 0; i < patterns.initPatterns.length; i++) {
        output += `### Pattern ${i + 1}\n\n`;
        output += `\`\`\`xpp\n${patterns.initPatterns[i]}\n\`\`\`\n\n`;
      }
    }
    
    if (patterns.usedInClasses && patterns.usedInClasses.length > 0) {
      output += `## Used In Classes\n\n`;
      for (const cls of patterns.usedInClasses) {
        output += `- ${cls}\n`;
      }
      output += '\n';
    }
    
    output += `## Usage Recommendation\n\n`;
    output += `Based on codebase analysis, the typical usage flow is:\n`;
    if (patterns.commonMethodCalls && patterns.commonMethodCalls.length > 0) {
      output += `1. Initialize ${className}\n`;
      for (let i = 0; i < Math.min(3, patterns.commonMethodCalls.length); i++) {
        output += `${i + 2}. Call ${patterns.commonMethodCalls[i].method}()\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  };
}

// ============================================
// Tool Definitions for MCP Server
// ============================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'search',
    description: 'Search for X++ classes, tables, methods, fields, enums, and EDTs by name or keyword. Use this to find symbols in the D365 Finance & Operations codebase.',
    inputSchema: SearchSchema
  },
  {
    name: 'search_extensions',
    description: 'Search for symbols only in custom extensions/ISV models. Use this to filter results to custom code only.',
    inputSchema: SearchExtensionsSchema
  },
  {
    name: 'get_class_info',
    description: 'Get detailed information about an X++ class including its declaration, inheritance, and all methods with source code.',
    inputSchema: GetClassSchema
  },
  {
    name: 'get_table_info',
    description: 'Get detailed information about an X++ table including fields, indexes, relations, and methods.',
    inputSchema: GetTableSchema
  },
  {
    name: 'code_completion',
    description: '🔍 Get all methods and fields for a class or table (IntelliSense-style completion). Use this to discover what members are available on a D365FO object. Optionally filter by prefix. Leave prefix empty to see ALL members. Works for both classes and tables.',
    inputSchema: CompleteMethodSchema
  },
  {
    name: 'generate_code',
    description: '⚡ ALWAYS USE THIS for creating new X++ code! Generates production-ready X++ code using D365FO best practices and patterns. Creates runnable classes, batch jobs, form extensions, Chain of Command extensions, event handlers, and service classes. DO NOT generate X++ code manually - use this tool to ensure correct D365FO patterns, naming conventions, and structure.',
    inputSchema: GenerateCodeSchema
  },
  {
    name: 'analyze_code_patterns',
    description: '🔍 MANDATORY FIRST STEP before generating any X++ code! Analyzes existing codebase for similar code patterns. Finds common methods, dependencies, classes, and real implementation patterns. Always call this BEFORE generate_code to learn what D365FO classes and methods to use from the actual codebase, not from generic knowledge.',
    inputSchema: AnalyzeCodePatternsSchema
  },
  {
    name: 'suggest_method_implementation',
    description: 'Suggest method body implementation based on similar methods in the codebase. Provides real examples and implementation patterns from actual D365FO code.',
    inputSchema: SuggestMethodImplementationSchema
  },
  {
    name: 'analyze_class_completeness',
    description: 'Analyze a class and suggest missing methods based on similar classes. Helps identify what methods should be added to follow common patterns.',
    inputSchema: AnalyzeClassCompletenessSchema
  },
  {
    name: 'get_api_usage_patterns',
    description: 'Get common usage patterns for a specific API or class. Shows how other code in the codebase uses this class, including initialization patterns and method call sequences.',
    inputSchema: GetApiUsagePatternsSchema
  }
];
