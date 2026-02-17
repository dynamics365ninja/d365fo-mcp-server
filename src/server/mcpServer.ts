/**
 * MCP Server Configuration and Setup
 * Registers tools, resources, and prompts for X++ code completion
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerToolHandler } from '../tools/toolHandler.js';
import { registerClassResource } from '../resources/classResource.js';
import { registerWorkspaceResources } from '../resources/workspaceResource.js';
import { registerCodeReviewPrompt } from '../prompts/codeReview.js';
import type { XppServerContext } from '../types/context.js';

export type { XppServerContext };

export function createXppMcpServer(context: XppServerContext): Server {
  const server = new Server(
    {
      name: 'xpp-code-completion-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // Register centralized tool handler
  registerToolHandler(server, context);

  // Register resources
  registerClassResource(server, context);
  registerWorkspaceResources(server, context);

  // Register prompts (includes system instructions)
  registerCodeReviewPrompt(server, context);

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'search',
          description: 'Search for X++ classes, tables, methods, and fields by name or keyword',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (class name, method name, table name, etc.)' },
              type: { 
                type: 'string', 
                enum: ['class', 'table', 'field', 'method', 'enum', 'all'],
                description: 'Filter by object type (class=AxClass, table=AxTable, enum=AxEnum, all=no filter)',
                default: 'all'
              },
              limit: { type: 'number', description: 'Maximum results to return', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'batch_search',
          description: `Execute multiple X++ symbol searches in parallel within a single request.

This tool enables efficient exploration by running independent searches concurrently,
reducing HTTP round-trip overhead and total execution time.

Use cases:
- Exploring multiple related concepts simultaneously (e.g., "dimension", "helper", "validation")
- Comparing different search queries at once
- Reducing workflow time for exploratory searches

Performance:
- 3 sequential searches: ~150ms (3 HTTP requests)
- 3 parallel searches: ~50ms (1 HTTP request) → 3x faster

Workspace-aware: Each query can optionally include workspace files by specifying
workspacePath and includeWorkspace parameters.`,
          inputSchema: {
            type: 'object',
            properties: {
              queries: {
                type: 'array',
                description: 'Array of search queries to execute in parallel (max 10 queries)',
                minItems: 1,
                maxItems: 10,
                items: {
                  type: 'object',
                  properties: {
                    query: {
                      type: 'string',
                      description: 'Search query (class name, method name, etc.)',
                    },
                    type: {
                      type: 'string',
                      enum: ['class', 'table', 'field', 'method', 'enum', 'all'],
                      default: 'all',
                      description: 'Filter by object type',
                    },
                    limit: {
                      type: 'number',
                      default: 10,
                      description: 'Maximum results to return for this query',
                    },
                    workspacePath: {
                      type: 'string',
                      description: 'Optional workspace path to search local files',
                    },
                    includeWorkspace: {
                      type: 'boolean',
                      default: false,
                      description: 'Whether to include workspace files in results',
                    },
                  },
                  required: ['query'],
                },
              },
            },
            required: ['queries'],
          },
        },
        {
          name: 'search_extensions',
          description: 'Search for symbols only in custom extensions/ISV models',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (class name, method name, etc.)' },
              prefix: { type: 'string', description: 'Extension prefix filter (e.g., ISV_, Custom_)' },
              limit: { type: 'number', description: 'Maximum results to return', default: 20 },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_class_info',
          description: 'Get detailed information about an X++ class including its methods',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the X++ class' },
            },
            required: ['className'],
          },
        },
        {
          name: 'get_table_info',
          description: 'Get detailed information about an X++ table including fields, indexes, and relations',
          inputSchema: {
            type: 'object',
            properties: {
              tableName: { type: 'string', description: 'Name of the X++ table' },
            },
            required: ['tableName'],
          },
        },
        {
          name: 'code_completion',
          description: 'Get method and field completions for classes or tables - provides IntelliSense-like code completion',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Class or table name' },
              prefix: { type: 'string', description: 'Method/field name prefix to filter', default: '' },
              includeWorkspace: { type: 'boolean', description: 'Whether to include workspace files', default: false },
              workspacePath: { type: 'string', description: 'Workspace path to search' },
            },
            required: ['className'],
          },
        },
        {
          name: 'generate_code',
          description: 'Generate X++ code templates for common patterns',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { 
                type: 'string', 
                enum: ['class', 'runnable', 'form-handler', 'data-entity', 'batch-job'],
                description: 'Code pattern to generate' 
              },
              name: { type: 'string', description: 'Name for the generated element' },
            },
            required: ['pattern', 'name'],
          },
        },
        {
          name: 'analyze_code_patterns',
          description: 'Analyze existing codebase for similar code patterns. Essential for creating code based on real D365FO patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              scenario: { type: 'string', description: 'Description of the scenario or functionality to analyze (e.g., "financial dimensions", "inventory transactions")' },
              classPattern: { type: 'string', description: 'Optional class name pattern to filter results (e.g., "Helper", "Service")' },
              limit: { type: 'number', description: 'Maximum number of pattern examples to return', default: 5 },
            },
            required: ['scenario'],
          },
        },
        {
          name: 'suggest_method_implementation',
          description: 'Suggest method body implementation based on similar methods in the codebase. Provides real examples from actual D365FO code.',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the class containing the method' },
              methodName: { type: 'string', description: 'Name of the method to implement' },
              parameters: { type: 'string', description: 'Optional method parameters to help find similar methods' },
            },
            required: ['className', 'methodName'],
          },
        },
        {
          name: 'analyze_class_completeness',
          description: 'Analyze a class and suggest missing methods based on similar classes. Helps identify methods to follow common patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the class to analyze' },
            },
            required: ['className'],
          },
        },
        {
          name: 'get_api_usage_patterns',
          description: 'Get common usage patterns for a specific API or class. Shows initialization patterns and method call sequences.',
          inputSchema: {
            type: 'object',
            properties: {
              apiName: { type: 'string', description: 'Name of the API/class to get usage patterns for' },
              context: { type: 'string', description: 'Optional context to filter patterns (e.g., "initialization", "validation")' },
            },
            required: ['apiName'],
          },
        },
        {
          name: 'create_d365fo_file',
          description: '🔥 PREFERRED FOR LOCAL DEVELOPMENT: Creates a physical D365FO XML file with UTF-8 BOM encoding and correct AOT structure (K:\\AosService\\PackagesLocalDirectory). Automatically adds file to Visual Studio project (.rnrproj) if requested. USE THIS TOOL FIRST unless server explicitly returns "requires file system access" error. Supports classes, tables, enums, forms, queries, views, data entities. ALWAYS TRY THIS BEFORE generate_d365fo_xml.',
          inputSchema: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: ['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity'],
                description: 'Type of D365FO object to create'
              },
              objectName: {
                type: 'string',
                description: 'Name of the object (e.g., MyHelperClass, MyCustomTable)'
              },
              modelName: {
                type: 'string',
                description: 'Model name (e.g., ContosoExtensions, ApplicationSuite)'
              },
              packagePath: {
                type: 'string',
                description: 'Base package path (default: K:\\AosService\\PackagesLocalDirectory)'
              },
              sourceCode: {
                type: 'string',
                description: 'X++ source code for the object (class declaration, methods, etc.)'
              },
              properties: {
                type: 'object',
                description: 'Additional properties (extends, implements, label, etc.)'
              },
              addToProject: {
                type: 'boolean',
                description: 'Whether to automatically add file to Visual Studio project (default: false)',
                default: false
              },
              projectPath: {
                type: 'string',
                description: 'Path to .rnrproj file (required if addToProject is true)'
              },
            },
            required: ['objectType', 'objectName', 'modelName'],
          },
        },
        {
          name: 'generate_d365fo_xml',
          description: '⚠️ CLOUD/AZURE ONLY - LAST RESORT: Generates D365FO XML content as TEXT (does NOT create physical file). Use ONLY when create_d365fo_file fails with "requires file system access" error (Azure/Linux deployment). Returns XML that must be manually saved using VS Code create_file tool with UTF-8 BOM encoding. ALWAYS TRY create_d365fo_file FIRST.',
          inputSchema: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: ['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity'],
                description: 'Type of D365FO object to generate'
              },
              objectName: {
                type: 'string',
                description: 'Name of the object (e.g., MyHelperClass, MyCustomTable)'
              },
              modelName: {
                type: 'string',
                description: 'Model name (e.g., ContosoExtensions, ApplicationSuite)'
              },
              sourceCode: {
                type: 'string',
                description: 'X++ source code for the object (class declaration, methods, etc.)'
              },
              properties: {
                type: 'object',
                description: 'Additional properties (extends, implements, label, etc.)'
              },
            },
            required: ['objectType', 'objectName', 'modelName'],
          },
        },
        {
          name: 'find_references',
          description: 'Find all references (where-used analysis) to a class, method, field, table, or enum. Essential for impact analysis and understanding dependencies.',
          inputSchema: {
            type: 'object',
            properties: {
              targetName: {
                type: 'string',
                description: 'Name of the target (class name, method name, field name, etc.)'
              },
              targetType: {
                type: 'string',
                enum: ['class', 'method', 'field', 'table', 'enum', 'all'],
                description: 'Type of the target to search for',
                default: 'all'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of references to return',
                default: 50
              },
            },
            required: ['targetName'],
          },
        },
        {
          name: 'modify_d365fo_file',
          description: '⚠️ WINDOWS ONLY: Safely modifies an existing D365FO XML file (class, table, enum, form, query, view). Supports adding/removing methods and fields, modifying properties. Creates automatic backup (.bak) before changes and validates XML after modification. IMPORTANT: This tool MUST run locally on Windows D365FO VM - it CANNOT work through Azure HTTP proxy (Linux).',
          inputSchema: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: ['class', 'table', 'form', 'enum', 'query', 'view'],
                description: 'Type of D365FO object to modify'
              },
              objectName: {
                type: 'string',
                description: 'Name of the object to modify (e.g., CustTable, SalesTable)'
              },
              operation: {
                type: 'string',
                enum: ['add-method', 'add-field', 'modify-property', 'remove-method', 'remove-field'],
                description: 'Type of modification to perform'
              },
              methodName: {
                type: 'string',
                description: 'Method name (required for add-method, remove-method)'
              },
              methodCode: {
                type: 'string',
                description: 'X++ code for the method body (required for add-method)'
              },
              methodModifiers: {
                type: 'string',
                description: 'Method modifiers (e.g., "public static")'
              },
              methodReturnType: {
                type: 'string',
                description: 'Return type of method (e.g., "void", "str", "boolean")'
              },
              methodParameters: {
                type: 'string',
                description: 'Method parameters (e.g., "str _param1, int _param2")'
              },
              fieldName: {
                type: 'string',
                description: 'Field name (required for add-field, remove-field)'
              },
              fieldType: {
                type: 'string',
                description: 'Extended data type or base type (required for add-field)'
              },
              fieldMandatory: {
                type: 'boolean',
                description: 'Is field mandatory (for add-field)'
              },
              fieldLabel: {
                type: 'string',
                description: 'Field label (for add-field)'
              },
              propertyPath: {
                type: 'string',
                description: 'Path to property (e.g., "Table1.Visible", for modify-property)'
              },
              propertyValue: {
                type: 'string',
                description: 'New property value (required for modify-property)'
              },
              createBackup: {
                type: 'boolean',
                description: 'Create backup before modification (default: true)',
                default: true
              },
              modelName: {
                type: 'string',
                description: 'Model name (auto-detected if not provided)'
              },
              workspacePath: {
                type: 'string',
                description: 'Path to workspace for finding file'
              },
            },
            required: ['objectType', 'objectName', 'operation'],
          },
        },
        {
          name: 'get_method_signature',
          description: 'Get the exact method signature for a class method, including parameters, return type, and modifiers. Essential for creating Chain of Command (CoC) extensions with correct signatures.',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the class containing the method'
              },
              methodName: {
                type: 'string',
                description: 'Name of the method to get signature for'
              },
            },
            required: ['className', 'methodName'],
          },
        },
        {
          name: 'get_form_info',
          description: 'Get detailed information about a D365FO form, including datasources, controls (buttons, grids, tabs), methods, and form structure. Essential for form customization and understanding form architecture.',
          inputSchema: {
            type: 'object',
            properties: {
              formName: {
                type: 'string',
                description: 'Name of the form (e.g., SalesTable, CustTable, InventTable)'
              },
              includeWorkspace: {
                type: 'boolean',
                description: 'Whether to include workspace files in search',
                default: false
              },
              workspacePath: {
                type: 'string',
                description: 'Optional workspace path to search local files'
              },
            },
            required: ['formName'],
          },
        },
        {
          name: 'get_query_info',
          description: 'Get detailed information about a D365FO query, including datasources, ranges, joins, grouping, and query structure. Essential for understanding and extending queries.',
          inputSchema: {
            type: 'object',
            properties: {
              queryName: {
                type: 'string',
                description: 'Name of the query (e.g., CustTransOpenQuery, InventTransQuery)'
              },
              includeWorkspace: {
                type: 'boolean',
                description: 'Whether to include workspace files in search',
                default: false
              },
              workspacePath: {
                type: 'string',
                description: 'Optional workspace path to search local files'
              },
            },
            required: ['queryName'],
          },
        },
        {
          name: 'get_view_info',
          description: 'Get detailed information about a D365FO view or data entity view, including mapped fields, computed columns, relations, methods, and view structure. Essential for data entity development and understanding view architecture.',
          inputSchema: {
            type: 'object',
            properties: {
              viewName: {
                type: 'string',
                description: 'Name of the view or data entity (e.g., GeneralJournalAccountEntryView, CustInvoiceJourView)'
              },
              includeWorkspace: {
                type: 'boolean',
                description: 'Whether to include workspace files in search',
                default: false
              },
              workspacePath: {
                type: 'string',
                description: 'Optional workspace path to search local files'
              },
            },
            required: ['viewName'],
          },
        },
        {
          name: 'get_enum_info',
          description: 'Get detailed information about a D365FO enum (enumeration), including all enum values, labels, and properties. Essential for understanding enum values and creating extensions.',
          inputSchema: {
            type: 'object',
            properties: {
              enumName: {
                type: 'string',
                description: 'Name of the enum (e.g., CustAccountType, SalesStatus, NoYes)'
              },
            },
            required: ['enumName'],
          },
        },
      ],
    };
  });

  return server;
}
