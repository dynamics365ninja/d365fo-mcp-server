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
  objectName: z.string().describe('Class or table name'),
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
    const { objectName, prefix } = args;
    
    const completions = symbolIndex.getCompletions(objectName, prefix);

    if (completions.length === 0) {
      return {
        content: [{ 
          type: 'text', 
          text: `No members found for "${objectName}"${prefix ? ` starting with "${prefix}"` : ''}` 
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
        text: `## Completions for ${objectName}${prefix ? `.${prefix}*` : ''}\n\n\`\`\`json\n${JSON.stringify(formatted, null, 2)}\n\`\`\`` 
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
    description: 'Get method and field completions for a class or table. Use this for IntelliSense-style code completion.',
    inputSchema: CompleteMethodSchema
  },
  {
    name: 'generate_code',
    description: 'Generate X++ code templates for common patterns like runnable classes, batch jobs, form extensions, Chain of Command extensions, and event handlers.',
    inputSchema: GenerateCodeSchema
  }
];
