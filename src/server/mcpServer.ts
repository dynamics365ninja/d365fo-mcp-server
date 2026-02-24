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
import { SERVER_MODE, WRITE_TOOLS } from './serverMode.js';

export type { XppServerContext };
export { SERVER_MODE, WRITE_TOOLS } from './serverMode.js';
export type { ServerMode } from './serverMode.js';

export function createXppMcpServer(context: XppServerContext): Server {
  const serverNameSuffix = SERVER_MODE !== 'full' ? ` (${SERVER_MODE})` : '';
  const server = new Server(
    {
      name: `d365fo-mcp-server${serverNameSuffix}`,
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
    const allTools = {
      tools: [
        {
          name: 'search',
          description: `🔍 Search 584,799+ pre-indexed D365FO objects by exact name (e.g., "CustTable", "SalesFormLetter") or keywords (e.g., "dimension helper", "validation table"). Returns basic info: name, type, model.

Use WHEN:
- You don't know the exact object name
- Exploring what exists in standard D365FO
- Quick discovery before detailed analysis with get_class_info() or get_table_info()

Use get_class_info() or get_table_info() INSTEAD when:
- You already know the exact name AND need full source code/methods
- You need complete structure (all methods with implementations)

Use batch_search() INSTEAD when:
- You need to search for multiple objects at once → 3x faster

Examples:
- "CustTable" → finds CustTable table
- "sales helper" → finds SalesHelper, SalesFormLetterHelper, etc.
- "dimension" with type="class" → finds all classes with "dimension" in name`,
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
          description: `🔍 Search ONLY custom/ISV code, filtering out 500,000+ Microsoft standard objects. Essential for finding YOUR modifications vs. Microsoft's standard code.

Filters to models tagged as:
- Custom (your company's modifications)
- ISV (third-party vendor extensions)  
- VAR (partner extensions)

Use WHEN:
- Finding "what did WE change?"
- Identifying custom extensions for a standard object (e.g., "CustTable")
- Avoiding confusion between Microsoft standard code and your modifications
- You only want to see custom/ISV classes, not the 500K+ Microsoft objects

Examples:
- "CustTable" → finds only YourCompany_CustTable_Extension (NOT Microsoft's CustTable)
- "sales" with prefix="Contoso" → finds ContosoSalesHelper, ContosoSalesValidator
- "dimension" → finds only YOUR custom dimension classes`,
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
          description: `📊 Get COMPLETE class definition with ALL methods, full source code, inheritance chain, and attributes. Returns the ENTIRE class as if you opened the file in Visual Studio.

Returns:
- All methods with FULL signatures AND source code implementations
- Inheritance (extends, implements interfaces)
- Class attributes ([ExtensionOf], [SysObsolete], etc.)
- All private/protected/public/static methods
- Class-level properties

Use WHEN:
- You need to see method implementations (not just names)
- Understanding class architecture before extending it
- Creating Chain of Command (CoC) extensions (combine with get_method_signature())
- Analyzing how a specific class works internally

Use code_completion() INSTEAD when:
- You only need method/field NAMES (IntelliSense-like)
- You don't need source code implementations

Use search() FIRST when:
- You don't know the exact class name yet

Examples:
- get_class_info("SalesFormLetter") → returns full class with 50+ methods and complete source
- get_class_info("CustTable") → returns table with fields + methods like validateWrite(), insert()`,
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
          description: `📊 PRIMARY TOOL for ALL table queries! Get complete table schema with all fields, indexes, relations, AND table methods.

⭐ USE THIS for ANY question about table methods, fields, or structure!

Returns:
- All table METHODS with signatures and source code (calcAmount, validateWrite, etc.)
- All fields with explicit EDT marker when present (format: EDT: <Name> (base: <Type>)), otherwise base type (format: Type: <Type>)
- Indexes: primary key, unique indexes, clustered indexes
- Relations: foreign keys to other tables with cardinality
- Table properties: caching strategy, TableGroup, SaveDataPerCompany, etc.

Use WHEN (includes all table-related queries):
- ✅ "What methods are on SalesTable?" → get_table_info("SalesTable")
- ✅ "Methods related to totals on SalesTable" → get_table_info("SalesTable")
- ✅ "Show me calc methods on CustTable" → get_table_info("CustTable")
- ✅ Understanding table structure before writing X++ queries
- ✅ Creating table extensions with new fields
- ✅ Understanding data relationships (foreign keys, navigation)
- ✅ Before writing data migration or integration scripts
- ✅ Analyzing table methods and validation logic

DO NOT USE code_completion() for tables - it doesn't work!

Examples:
- get_table_info("SalesTable") → ALL methods (calcAmount, validateWrite, etc.) + fields + relations
- get_table_info("CustTable") → 100+ fields, methods, relations to DirParty/LogisticsPostalAddress
- get_table_info("InventTable") → product master fields, methods, relations to EcoResProduct`,
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
          description: `⚡ Get IntelliSense-like method and field name completions for CLASSES only. Faster than get_class_info() when you only need member names, not implementations.

⚠️ CLASSES ONLY - For TABLES use get_table_info() instead!

Returns:
- Method names with basic signatures (parameters, return types)
- Field names with types
- Filtered by prefix if specified (e.g., "calc*" finds calcAmount, calcDiscount)

Use WHEN:
- Working with X++ CLASSES (not tables)
- Writing code and need to see available methods quickly
- You want to filter by prefix for faster discovery
- You don't need to see method source code

DO NOT USE for TABLES:
- ❌ code_completion("SalesTable") → Use get_table_info("SalesTable") instead
- ❌ code_completion("CustTable") → Use get_table_info("CustTable") instead
- ❌ For ANY table, always use get_table_info()

Use get_class_info() INSTEAD when:
- You need to see method SOURCE CODE implementations
- You need to understand HOW methods work internally
- Creating Chain of Command extensions (need full method body)

Examples (CLASSES only):
- code_completion("SalesFormLetter") → lists methods/fields of the CLASS
- code_completion("NumberSeq", prefix="get") → getNum, getVoucher, etc.
- code_completion("DimensionHelper", prefix="validate") → validation methods`,
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
          description: `🎯 GENERATE X++ CODE - Call this FIRST when user asks to CREATE/BUILD D365FO objects!

WHEN TO USE (keywords):
- "vytvoř" / "create" / "build" / "implement" / "add new" / "generate" / "make"
- "dávková úloha" = batch-job, "pomocná třída" = helper class, "runnable" = runnable class
- ANY request to create NEW D365FO class, batch job, form handler, data entity

WORKFLOW (ALWAYS follow):
1. Call analyze_code_patterns("description") → learn from existing code patterns
2. Call generate_code(pattern, name) → get X++ source code template
3. Call create_d365fo_file(objectType="class", objectName=name, sourceCode=<from step 2>, addToProject=true)

PATTERNS:
- "batch-job" → Dávková úloha (extends RunBaseBatch) with dialog, pack/unpack, contract class
- "class" → Standard helper/utility class
- "runnable" → Runnable class with main() method
- "form-handler" → Form event handler (datasource/control event subscribers)
- "data-entity" → Data entity with staging table
- "table-extension" → Table extension [ExtensionOf(tableStr(TableName))]

EXAMPLES:
- "Vytvoř dávkovou úlohu pro zpracování objednávek" 
  → generate_code(pattern="batch-job", name="ProcessOpenOrdersBatch")
- "Create helper class for sales calculations"
  → generate_code(pattern="class", name="SalesCalculationHelper")
- "Make runnable class for testing"
  → generate_code(pattern="runnable", name="MyTestRunnable")`,
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { 
                type: 'string', 
                enum: ['class', 'runnable', 'form-handler', 'data-entity', 'batch-job', 'table-extension'],
                description: 'Code pattern to generate. Use table-extension for [ExtensionOf(tableStr(...))] CoC extensions.' 
              },
              name: { type: 'string', description: 'Name for the generated element' },
            },
            required: ['pattern', 'name'],
          },
        },
        {
          name: 'analyze_code_patterns',
          description: `🧠 Analyze YOUR actual codebase to find most common classes, methods, and dependencies used in a scenario. Essential for creating code based on REAL D365FO patterns, not generic examples.

Searches YOUR codebase and returns:
- Most frequently used classes for the scenario
- Common method patterns and naming conventions
- Typical dependencies and imports
- Real-world implementation examples

⚠️ CALL THIS FIRST before generating new code to learn from existing patterns.

Use WHEN:
- Before creating new classes → see how similar classes are structured
- Before implementing business logic → find similar implementations  
- Learning D365FO conventions in your organization
- Understanding how others solved similar problems

Examples:
- analyze_code_patterns("ledger journal creation") → finds LedgerJournalEngine, journal posting classes
- analyze_code_patterns("sales order validation") → finds SalesTable validation patterns
- analyze_code_patterns("dimension", classPattern="Helper") → finds dimension helper classes`,
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
          description: `🧠 Find REAL implementation examples of similar methods in YOUR codebase. Shows how others implemented the same/similar method, not generic templates.

Searches YOUR codebase and returns:
- Real method implementations with similar name/purpose
- Common patterns for method signature (parameters, return type)
- Typical method body structure and logic flow
- Dependencies and classes commonly used together

Use WHEN:
- Implementing a standard D365FO method (validateWrite, insert, update, etc.)
- You know the method name but not how to implement it
- Want to see real examples from your codebase
- Creating Chain of Command extensions based on existing patterns

Examples:
- suggest_method_implementation("CustTable", "validateWrite") → shows how others validate customer data
- suggest_method_implementation("SalesTable", "insert") → shows common insert() patterns
- suggest_method_implementation("MyHelper", "calculate") → finds similar calculation methods`,
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
          description: `🧠 Analyze a class and suggest missing methods by comparing with similar classes. Helps ensure your class follows common D365FO patterns and conventions.

Analyzes YOUR codebase and returns:
- Methods that similar classes have but your class is missing
- Common method patterns in the same class category
- Suggestions for standard methods (validateWrite, find, exist, etc.)
- Completeness score based on similar classes

Use WHEN:
- After creating a new class → check if you're missing important methods
- Reviewing existing class → ensure it follows patterns
- Before code review → identify gaps
- Learning what methods a class typically needs

Examples:
- analyze_class_completeness("MyCustomerHelper") → suggests missing find(), exist(), validate()
- analyze_class_completeness("MySalesProcessor") → compares with other processor classes`,
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
          description: `🧠 Shows how a specific API/class is ACTUALLY used in YOUR codebase. Returns real initialization patterns and method call sequences, not documentation.

Searches YOUR codebase and returns:
- Common initialization patterns (how to create instances)
- Typical method call sequences (what methods are called together and in what order)
- Required setup/configuration before using the API
- Common parameters and return value usage
- Real usage examples from your code

Use WHEN:
- First time using a complex D365FO API/class
- Need to understand correct initialization sequence
- Want to see real examples instead of reading documentation
- Understanding how others use a specific class

Examples:
- get_api_usage_patterns("LedgerJournalEngine") → shows initialization + posting sequence
- get_api_usage_patterns("NumberSeq") → shows how to generate number sequences  
- get_api_usage_patterns("DimensionAttributeValueSet") → dimension creation patterns`,
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
          description: `🔥 VYTVOŘ/CREATE D365FO FILE - REPLACES BUILT-IN create_file FOR ALL D365FO OBJECTS!

🚨 WARNING: BUILT-IN create_file WILL CORRUPT D365FO METADATA! NEVER USE IT FOR .xml FILES!

WHEN TO USE (MUST use for ANY D365FO object creation):
- User asks to CREATE, BUILD, IMPLEMENT, GENERATE new class, table, enum, form, query, view, or data entity
- Keywords: "vytvoř", "create", "build", "implement", "add new", "generate", "make"
- "dávková úloha" = batch-job class, "pomocná třída" = helper class, "runnable" = runnable class
- ANY request to create a new D365FO object

WHY NOT create_file:
❌ create_file → Wrong XML structure, no UTF-8 BOM, doesn't add to VS project, breaks AOT
✅ create_d365fo_file → Correct AOT location, UTF-8 BOM, auto-adds to .rnrproj, validates structure

WHAT IT DOES:
- Creates physical XML file in correct AOT location (K:\\AosService\\PackagesLocalDirectory\\{Model}\\{Model}\\AxClass\\{Name}.xml)
- Automatically adds file to Visual Studio project (.rnrproj) if addToProject=true
- Auto-detects correct model name from workspace .rnrproj file
- Generates proper XML structure with UTF-8 BOM encoding

REQUIRED PARAMETERS:
- objectType: class, table, enum, form, query, view, data-entity
- objectName: Name of the new object (e.g., "ProcessOpenOrdersBatch" for batch job)
- modelName: Any value (auto-corrected from .rnrproj)
- addToProject: true (to automatically add to VS project)

WORKFLOW:
1. generate_code(pattern="batch-job", name="MyBatch") → Get X++ code
2. create_d365fo_file(objectType="class", objectName="MyBatch", sourceCode=<step 1>, addToProject=true)

EXAMPLES:
- "Vytvoř dávkovou úlohu pro zpracování objednávek" → create_d365fo_file(objectType="class", objectName="ProcessOrdersBatch", addToProject=true)
- "Create helper class for sales calculations" → create_d365fo_file(objectType="class", objectName="SalesCalculationHelper", addToProject=true)`,
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
              packageName: {
                type: 'string',
                description: 'Package name (e.g., CustomExtensions, ApplicationSuite). Auto-resolved from model name if omitted. Required when package name differs from model name.',
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
          description: `🔍 Find ALL references (where-used analysis) to a class, method, field, table, or enum across entire D365FO codebase. Essential for impact analysis before making changes.

Searches 584,799+ objects and returns:
- All classes/methods that reference the target
- File locations and line numbers
- Context of how it's used (method calls, instantiation, etc.)
- Dependencies and impact scope

Use WHEN:
- Before modifying/deleting a class, method, or field → understand impact
- Finding all places that use a specific API
- Understanding dependencies and coupling
- Impact analysis for refactoring
- "Who calls this method?"

Examples:
- find_references("DimensionAttributeValueSet") → finds all classes using dimensions
- find_references("validateWrite", targetType="method") → finds all validateWrite() calls
- find_references("CustTable.AccountNum", targetType="field") → finds all uses of AccountNum field
- find_references("SalesStatus", targetType="enum") → finds all SalesStatus enum usage`,
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
              packageName: {
                type: 'string',
                description: 'Package name. Auto-resolved if omitted.',
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
          description: `⚙️ Get EXACT method signature including parameters, return type, and modifiers. CRITICAL for creating Chain of Command (CoC) extensions - incorrect signatures cause compilation errors.

Returns:
- Complete method signature with modifiers (public, protected, private, static, final)
- All parameters with types and default values
- Return type
- Method attributes ([Hookable], [Replaceable], etc.)

MANDATORY WORKFLOW for CoC extensions:
1. get_method_signature(className, methodName) → get EXACT signature
2. Copy signature EXACTLY (parameters, types, modifiers must match)
3. Create extension with [ExtensionOf(classStr(...))] attribute
4. Implement with next keyword for CoC pattern

Use WHEN:
- Creating Chain of Command extensions (REQUIRED)
- Before overriding/extending methods
- Need exact parameter types and default values
- Verifying method accessibility (public/protected/private)

Examples:
- get_method_signature("CustTable", "validateWrite") → returns: public boolean validateWrite(boolean _insertMode = false)
- get_method_signature("SalesTable", "insert") → returns: public void insert()
- get_method_signature("NumberSeq", "num") → returns: public static NumberSeqCode num()`,
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
          description: `📋 Get complete D365FO form structure including datasources, control hierarchy (buttons, grids, tabs, groups), methods, and form architecture. Essential for form customization and extensions.

Returns:
- Datasources with fields, methods, and data source configuration
- Control tree: ButtonGroups, Grids, Tabs, TabPages, Groups, Fields
- Form methods (init, run, close, datasource methods)
- Control properties (Visible, Enabled, Mandatory, etc.)
- Event handlers and overrides

Use WHEN:
- Customizing forms with extensions
- Understanding form structure before modifications
- Finding control names for code extensions
- Analyzing datasource relationships
- Creating form event handlers

Examples:
- get_form_info("SalesTable") → SalesTable/SalesLine datasources, Overview/LineView grids, header/line fields
- get_form_info("CustTable") → CustTable datasource, addresses grid, contact info tabs
- get_form_info("PurchTable") → purchase order form structure with header/lines`,
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
          description: `📊 Get complete D365FO query structure including datasources, joins, ranges, field lists, sorting, and grouping. Essential for understanding and extending queries used by forms, reports, and data entities.

Returns:
- All datasources in the query hierarchy
- Joins between datasources (inner, outer, exists, notexists) with relations
- Ranges (WHERE clause filters) with field, value, enabled status
- Field lists (SELECT clause)
- Sorting and grouping configuration
- Query methods and dynamic behavior

Use WHEN:
- Understanding query logic before modification
- Creating query extensions to add datasources/ranges
- Analyzing report or form data sources
- Debugging query performance issues
- Understanding data relationships in queries

Examples:
- get_query_info("CustTransOpenQuery") → open customer transactions query with date/status ranges
- get_query_info("InventTransQuery") → inventory transactions with item/site joins
- get_query_info("LedgerJournalTransQuery") → journal lines query structure`,
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
          description: `📊 Get complete D365FO view or data entity structure including mapped fields, data sources, computed columns, relations, methods, and view architecture. Essential for data entity development and OData integration.

Returns:
- All fields with data source mappings
- Computed columns (unmapped fields with methods)
- Underlying tables and relations
- View methods and business logic
- Data entity properties (Public, IsPublic, DataManagementEnabled)
- Staging table configuration (for data entities)

Use WHEN:
- Developing data entities for integration
- Understanding OData API structure
- Creating view extensions with new fields
- Analyzing data entity business logic
- Understanding DMF (Data Management Framework) entities

Examples:
- get_view_info("GeneralJournalAccountEntryView") → ledger entry view with dimension fields
- get_view_info("CustCustomerV3Entity") → customer OData entity with party/address mappings
- get_view_info("SalesOrderHeaderV2Entity") → sales order integration entity`,
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
          description: `🔢 Get complete D365FO enum (enumeration) definition including all enum values, integer values, labels, and properties. Essential for understanding enum options and creating enum extensions.

Returns:
- All enum values with their names
- Integer value for each enum element
- Labels/descriptions for each value
- Enum properties (UseEnumValue, ConfigurationKey, etc.)
- Style configuration (for display)

Use WHEN:
- Understanding available enum values for a field
- Creating enum extensions with new values
- Writing code that checks enum values
- Understanding enum integer values for database queries
- Documenting enum options

Examples:
- get_enum_info("SalesStatus") → None=0, Backorder=1, Delivered=2, Invoiced=3, Canceled=4
- get_enum_info("NoYes") → No=0, Yes=1 (most common boolean enum)
- get_enum_info("CustAccountType") → Customer=0, Vendor=1, Employee=2, etc.
- get_enum_info("BOMType") → BOM types for production orders`,
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
        {
          name: 'get_edt_info',
          description: `📊 Get complete Extended Data Type (EDT) definition including base type, labels, reference table, and EDT properties. EDT names are UNIQUE ACROSS ALL MODELS.

Returns:
- Core EDT properties (Extends, EnumType, ReferenceTable, StringSize, DisplayLength, etc.)
- Label/help/configuration metadata
- Additional raw EDT properties when present

Use WHEN:
- You need to inspect an EDT before using it on table fields
- You need reference table / relation metadata from AxEdt
- You need to validate EDT inheritance (Extends) and display constraints

FALLBACK Strategy (if EDT not found with modelName):
- EDT names are globally unique, so omit modelName and retry
- Call get_edt_info(edtName="MyEdt") without modelName → will search ALL models
- If first call fails with a specific modelName, ALWAYS retry without modelName

Examples:
- get_edt_info("WhsInboundShipmentOrderMessageRecId") → finds EDT regardless of model
- If model-specific lookup fails, retry: get_edt_info("WhsInboundShipmentOrderMessageRecId") (no modelName)
- get_edt_info("CustAccount") → Customer account number EDT`,
          inputSchema: {
            type: 'object',
            properties: {
              edtName: {
                type: 'string',
                description: 'Name of the Extended Data Type (EDT)'
              },
              modelName: {
                type: 'string',
                description: 'Model name (optional). CAUTION: If EDT not found with specific modelName, omit this and retry - EDT names are globally unique'
              },
            },
            required: ['edtName'],
          },
        },
        {
          name: 'search_labels',
          description: `🏷️ Full-text search across indexed D365FO AxLabelFile labels. Search by text, label ID or comment to find existing labels before creating new ones.

Returns matching label IDs, their translated text, developer comment and the X++ reference syntax (@LabelFileId:LabelId).

Use WHEN:
- Looking for an existing label to reuse (always do this BEFORE create_label!)
- Finding the correct reference syntax for a label
- Discovering what labels exist in a custom model
- Searching for labels by keyword (e.g. "customer", "batch", "error")

Examples:
- search_labels("batch group") → finds ACFeature, BatchGroup, etc.
- search_labels("ACFeature", model="AslCore") → labels in custom AslCore model
- search_labels("feature", language="cs") → Czech translations`,
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search text — searches label ID, text and developer comment',
              },
              language: {
                type: 'string',
                description: 'Language/locale to search in (default: en-US). Examples: cs, de, sk',
              },
              model: {
                type: 'string',
                description: 'Restrict to a specific model (e.g. AslCore, ApplicationPlatform)',
              },
              labelFileId: {
                type: 'string',
                description: 'Restrict to a specific label file ID (e.g. AslCore, SYS)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default 30)',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_label_info',
          description: `🏷️ Get all language translations for a D365FO label ID, or list available AxLabelFile IDs in a model.

Returns:
- All translations (en-US, cs, de, sk, and other indexed languages)
- Developer comment
- X++ reference syntax: @LabelFileId:LabelId
- Ready-to-use code snippets for X++ and metadata XML

Use WHEN:
- Verifying that a label has translations in all required languages
- Getting the correct @LabelFileId:LabelId reference to use in code
- Listing which label files exist in a custom model (omit labelId)

Examples:
- get_label_info("ACFeature", model="AslCore") → all translations
- get_label_info(model="AslCore") → list label files in AslCore
- get_label_info("BatchGroup") → all languages for BatchGroup`,
          inputSchema: {
            type: 'object',
            properties: {
              labelId: {
                type: 'string',
                description: 'Exact label ID (e.g. ACFeature). Omit to list available label files.',
              },
              labelFileId: {
                type: 'string',
                description: 'Label file ID (e.g. AslCore, SYS)',
              },
              model: {
                type: 'string',
                description: 'Model to filter by (e.g. AslCore)',
              },
            },
            required: [],
          },
        },
        {
          name: 'create_label',
          description: `🏷️ Add a new label to an existing AxLabelFile in a custom D365FO model.

Writes the label into EVERY language .label.txt file that exists in the model (inserts alphabetically), creates XML descriptors if missing, and updates the MCP label index.

⚠️ ALWAYS call search_labels first to check if a suitable label already exists!

Process:
1. Reads each existing .label.txt file for the model
2. Checks for duplicate label ID
3. Inserts the new label in alphabetical position
4. Writes the updated file back to disk
5. Updates the SQLite label index

Examples:
- create_label("MyNewField", "AslCore", "AslCore", [{language:"en-US", text:"My new field"}, {language:"cs", text:"Moje nové pole"}])
- create_label with createLabelFileIfMissing=true → creates AxLabelFile structure from scratch`,
          inputSchema: {
            type: 'object',
            properties: {
              labelId: {
                type: 'string',
                description: 'Unique label identifier (alphanumeric), e.g. MyNewField',
              },
              labelFileId: {
                type: 'string',
                description: 'Label file ID (e.g. AslCore)',
              },
              model: {
                type: 'string',
                description: 'Model name that owns the label file (e.g. AslCore)',
              },
              packageName: {
                type: 'string',
                description: 'Package name for the model. Auto-resolved if omitted.',
              },
              translations: {
                type: 'array',
                description: 'Translations for each language. Provide at least en-US.',
                items: {
                  type: 'object',
                  properties: {
                    language: { type: 'string', description: 'Locale code, e.g. en-US, cs, de, sk' },
                    text: { type: 'string', description: 'Label text' },
                    comment: { type: 'string', description: 'Developer comment (optional)' },
                  },
                  required: ['language', 'text'],
                },
              },
              defaultComment: {
                type: 'string',
                description: 'Developer comment for languages without explicit comment',
              },
              packagePath: {
                type: 'string',
                description: 'Root packages path. Auto-detected from environment config if omitted.',
              },
              createLabelFileIfMissing: {
                type: 'boolean',
                description: 'Create AxLabelFile structure if missing (default: false)',
              },
              updateIndex: {
                type: 'boolean',
                description: 'Update MCP label index after writing (default: true)',
              },
            },
            required: ['labelId', 'labelFileId', 'model', 'translations'],
          },
        },
        {
          name: 'get_table_patterns',
          description: `📊 Analyze common field types, index patterns, and relation structures for D365FO tables.

Helps understand table design patterns before creating new tables. Use tableGroup to analyze patterns in standard table groups (Main, Transaction, Parameter, etc.) or similarTo to find tables with similar structure.

Examples:
- get_table_patterns(tableGroup="Transaction") → Analyze common fields/indexes in transaction tables
- get_table_patterns(similarTo="CustTable") → Find tables with similar structure to CustTable`,
          inputSchema: {
            type: 'object',
            properties: {
              tableGroup: {
                type: 'string',
                enum: ['Main', 'Transaction', 'Parameter', 'Group', 'Reference', 'Miscellaneous', 'WorksheetHeader', 'WorksheetLine'],
                description: 'Table group type to analyze (choose one)',
              },
              similarTo: {
                type: 'string',
                description: 'Name of table to find similar patterns (alternative to tableGroup)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of pattern examples (default: 10)',
                default: 10,
              },
            },
          },
        },
        {
          name: 'get_form_patterns',
          description: `📋 Analyze common datasource configurations, control hierarchies, and D365FO form patterns.

Helps understand form design patterns before creating new forms. Use formPattern to analyze D365FO standard patterns, dataSource to find forms using a specific table, or similarTo for specific form analysis.

Examples:
- get_form_patterns(formPattern="SimpleList") → Analyze SimpleList pattern forms
- get_form_patterns(dataSource="CustTable") → Find all forms using CustTable
- get_form_patterns(similarTo="CustTableListPage") → Find forms similar to CustTableListPage`,
          inputSchema: {
            type: 'object',
            properties: {
              formPattern: {
                type: 'string',
                enum: ['DetailsTransaction', 'ListPage', 'SimpleList', 'SimpleListDetails', 'Dialog', 'DropDialog', 'FormPart', 'Lookup'],
                description: 'D365FO form pattern to analyze',
              },
              dataSource: {
                type: 'string',
                description: 'Table name - find forms using this table',
              },
              similarTo: {
                type: 'string',
                description: 'Form name to find similar patterns',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of pattern examples (default: 10)',
                default: 10,
              },
            },
          },
        },
        {
          name: 'suggest_edt',
          description: `🔍 Suggest Extended Data Types (EDT) for a field name using fuzzy matching and pattern analysis.

Analyzes indexed EDT metadata to recommend appropriate Extended Data Types based on field name patterns and optional context. Returns confidence-ranked suggestions with EDT properties (base type, enum, reference table, label).

Use BEFORE creating table fields to ensure you reuse existing EDTs instead of primitive types.

Examples:
- suggest_edt(fieldName="CustomerAccount") → Suggests CustAccount EDT
- suggest_edt(fieldName="OrderAmount", context="sales order") → Suggests AmountCur, SalesAmountCur, etc.
- suggest_edt(fieldName="TransDate") → Suggests TransDate EDT`,
          inputSchema: {
            type: 'object',
            properties: {
              fieldName: {
                type: 'string',
                description: 'Field name to suggest EDT for (e.g., "CustomerAccount", "OrderAmount")',
              },
              context: {
                type: 'string',
                description: 'Optional context (e.g., "sales order") to improve suggestions',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of suggestions (default: 5)',
                default: 5,
              },
            },
            required: ['fieldName'],
          },
        },
        {
          name: 'generate_smart_table',
          description: `🎨 AI-driven table generation with intelligent field/index/relation suggestions.

Generates AxTable XML using pattern analysis from indexed metadata. Supports multiple strategies:
1. Copy structure from existing table (copyFrom parameter)
2. Analyze table group patterns and generate common fields (tableGroup + generateCommonFields)
3. Use field hints and suggest EDTs (fieldsHint parameter)
4. Combine all strategies for comprehensive generation

Returns complete XML ready for create_d365fo_file or manual save.

Examples:
- generate_smart_table(name="MyOrderTable", tableGroup="Transaction", generateCommonFields=true)
- generate_smart_table(name="MyTable", copyFrom="CustTable")
- generate_smart_table(name="MyTable", fieldsHint="RecId, Name, Amount")`,
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Table name (e.g., "MyCustomTable")',
              },
              label: {
                type: 'string',
                description: 'Optional label for the table',
              },
              tableGroup: {
                type: 'string',
                description: 'Table group (Main, Transaction, Parameter, etc.)',
              },
              copyFrom: {
                type: 'string',
                description: 'Optional: Copy structure from existing table name',
              },
              fieldsHint: {
                type: 'string',
                description: 'Optional: Comma-separated field hints (e.g., "RecId, Name, Amount")',
              },
              generateCommonFields: {
                type: 'boolean',
                description: 'If true, auto-generate common fields based on table group patterns',
              },
              modelName: {
                type: 'string',
                description: 'Model name (auto-detected from projectPath)',
              },
              projectPath: {
                type: 'string',
                description: 'Path to .rnrproj file for model extraction',
              },
              solutionPath: {
                type: 'string',
                description: 'Path to solution directory (alternative to projectPath)',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'generate_smart_form',
          description: `🎨 AI-driven form generation with intelligent datasource/control suggestions.

Generates AxForm XML using pattern analysis from indexed metadata. Supports multiple strategies:
1. Copy structure from existing form (copyFrom parameter)
2. Auto-generate datasource and grid from table (dataSource + generateControls)
3. Analyze form pattern and apply structure (formPattern parameter)
4. Combine strategies for comprehensive generation

Returns complete XML ready for create_d365fo_file or manual save.

Examples:
- generate_smart_form(name="MyOrderForm", dataSource="MyOrderTable", generateControls=true)
- generate_smart_form(name="MyForm", copyFrom="CustTableListPage")
- generate_smart_form(name="MyForm", formPattern="SimpleList", dataSource="MyTable")`,
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Form name (e.g., "MyCustomForm")',
              },
              label: {
                type: 'string',
                description: 'Optional label for the form',
              },
              caption: {
                type: 'string',
                description: 'Optional caption/title',
              },
              dataSource: {
                type: 'string',
                description: 'Optional: Table name for primary datasource',
              },
              formPattern: {
                type: 'string',
                description: 'Optional: Form pattern (SimpleList, DetailsTransaction, etc.)',
              },
              copyFrom: {
                type: 'string',
                description: 'Optional: Copy structure from existing form name',
              },
              generateControls: {
                type: 'boolean',
                description: 'If true, auto-generate grid controls for datasource',
              },
              modelName: {
                type: 'string',
                description: 'Model name (auto-detected from projectPath)',
              },
              projectPath: {
                type: 'string',
                description: 'Path to .rnrproj file for model extraction',
              },
              solutionPath: {
                type: 'string',
                description: 'Path to solution directory (alternative to projectPath)',
              },
            },
            required: ['name'],
          },
        },
      ],
    };

    // Apply server mode filter
    if (SERVER_MODE === 'read-only') {
      allTools.tools = allTools.tools.filter(t => !WRITE_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for read-only mode: ${allTools.tools.length} tools (write tools excluded)`);
    } else if (SERVER_MODE === 'write-only') {
      allTools.tools = allTools.tools.filter(t => WRITE_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for write-only mode: ${allTools.tools.length} tools (${Array.from(WRITE_TOOLS).join(', ')})`);
    } else {
      console.error(`[MCP Server] Tool list in full mode: ${allTools.tools.length} tools (no filtering)`);
    }

    return allTools;
  });

  return server;
}
