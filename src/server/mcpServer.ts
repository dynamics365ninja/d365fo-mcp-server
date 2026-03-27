/**
 * MCP Server Configuration and Setup
 * Registers tools, resources, and prompts for X++ code completion
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerToolHandler } from '../tools/toolHandler.js';
import { registerClassResource } from '../resources/classResource.js';
import { registerWorkspaceResources } from '../resources/workspaceResource.js';
import { registerCodeReviewPrompt } from '../prompts/codeReview.js';
import type { XppServerContext } from '../types/context.js';
import { SERVER_MODE, LOCAL_TOOLS } from './serverMode.js';
import { getConfigManager } from '../utils/configManager.js';
import { setLastRoots, recordRootsListChanged } from '../utils/stdioSessionInfo.js';

export type { XppServerContext };
export { SERVER_MODE, LOCAL_TOOLS, WRITE_TOOLS } from './serverMode.js';
export type { ServerMode } from './serverMode.js';

/**
 * Convert a file:// URI to a local Windows path.
 * Duplicated from transport.ts to keep mcpServer.ts self-contained
 * (no circular dep between transport ↔ mcpServer).
 */
function fileUriToPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('file:///')) {
    return decodeURIComponent(uri.slice('file:///'.length)).replace(/\//g, '\\');
  }
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.slice('file://'.length)).replace(/\//g, '\\');
  }
  if (uri.length > 2 && (uri[1] === ':' || uri.startsWith('\\\\'))) return uri;
  return null;
}

/**
 * Apply MCP roots list to ConfigManager.
 * Called after InitializedNotification and RootsListChanged notification.
 * All roots are passed so that unambiguous single-project matches work correctly
 * even when VS 2022 sends multiple roots (open project folders).
 */
function applyRootsToConfig(roots: Array<{ uri: string }>): void {
  if (!roots?.length) {
    // VS 2022 sends empty roots/list when closing a solution (transition state).
    // Log this so it's visible in diagnostics, but keep the current detection
    // result — the next roots/list_changed will bring the new solution path.
    process.stderr.write('[mcpServer] roots/list received (0 root(s)) — solution closing or no workspace open\n');
    setLastRoots([]);
    return;
  }

  // Log all received roots for diagnostics
  process.stderr.write(`[mcpServer] roots/list received (${roots.length} root(s)):\n`);
  roots.forEach((r, i) => process.stderr.write(`  [${i}] ${r.uri}\n`));

  // Persist URIs in the stdio session singleton so get_workspace_info can display them.
  setLastRoots(roots.map(r => r.uri));

  // Convert all URIs to local paths
  const paths = roots
    .map(r => fileUriToPath(r.uri))
    .filter((p): p is string => p !== null);

  if (paths.length === 0) return;

  // Pass all paths; configManager will pick the most specific unambiguous one.
  // After detection completes, log what solution/project was resolved so it's
  // easy to verify in the log that the correct project was picked.
  getConfigManager().setRuntimeContextFromRoots(paths).then(() => {
    const { modelName, source, projectPath, solutionPath, workspacePath } =
      getConfigManager().getDetectionSummary();
    process.stderr.write(
      `[mcpServer] ✅ Project detection result:\n` +
      `   Model name  : ${modelName ?? '(unknown)'} (source: ${source})\n` +
      `   Project path: ${projectPath  ?? '(not set)'}\n` +
      `   Solution    : ${solutionPath ?? '(not set)'}\n` +
      `   Workspace   : ${workspacePath ?? '(not set)'}\n`
    );
  }).catch(err => {
    process.stderr.write(`[mcpServer] setRuntimeContextFromRoots error: ${err}\n`);
  });
}

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
        logging: {},
      },
    }
  );

  // -----------------------------------------------------------------------
  // Workspace roots: VS Code (stdio mode) sends roots after initialization.
  // Request them immediately after `initialized` notification, then keep
  // up-to-date on `notifications/roots/list_changed`.
  // -----------------------------------------------------------------------
  server.setNotificationHandler(InitializedNotificationSchema, async () => {
    process.stderr.write(
      `[mcpServer ${new Date().toISOString().slice(11, 23)}] ⚡ 'initialized' notification received — requesting roots/list\n`
    );
    // Only stdio clients (VS Code, VS 2022) advertise the roots capability.
    // HTTP / Azure clients do not — skipping the call avoids a -32001 timeout
    // that would otherwise be logged as a spurious warning in Azure Monitor.
    if (!server.getClientCapabilities()?.roots) {
      process.stderr.write(`[mcpServer] ℹ️  Client has no roots capability — skipping roots/list\n`);
      return;
    }
    // HTTP transports (Azure App Service, MCP_FORCE_HTTP) are request-response only —
    // the server cannot initiate requests back to the client. Even if the client
    // declares `roots` capability, calling roots/list would always time out (-32001).
    const isHttpMode = !!process.env.WEBSITES_PORT || process.env.MCP_FORCE_HTTP === 'true';
    if (isHttpMode) {
      process.stderr.write(`[mcpServer] ℹ️  HTTP mode — skipping roots/list (transport is request-response only)\n`);
      return;
    }
    try {
      const result = await server.request(
        { method: 'roots/list', params: {} },
        ListRootsResultSchema
      );
      applyRootsToConfig(result.roots ?? []);
    } catch (e) {
      // Unlikely now that we checked capabilities first, but still guard
      // against network errors or other unexpected failures.
      process.stderr.write(`[mcpServer] ⚠️  roots/list failed: ${e}\n`);
    }
  });

  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    recordRootsListChanged();
    process.stderr.write(
      `[mcpServer ${new Date().toISOString().slice(11, 23)}] 🔄 'roots/list_changed' notification — re-requesting roots/list\n`
    );
    const isHttpMode = !!process.env.WEBSITES_PORT || process.env.MCP_FORCE_HTTP === 'true';
    if (!server.getClientCapabilities()?.roots || isHttpMode) {
      return;
    }
    try {
      const result = await server.request(
        { method: 'roots/list', params: {} },
        ListRootsResultSchema
      );
      applyRootsToConfig(result.roots ?? []);
    } catch {}
  });

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
                enum: ['class', 'table', 'field', 'method', 'enum', 'edt', 'form', 'query', 'view', 'report',
                  'security-privilege', 'security-duty', 'security-role',
                  'menu-item-display', 'menu-item-action', 'menu-item-output',
                  'table-extension', 'class-extension', 'form-extension',
                  'enum-extension', 'edt-extension', 'data-entity-extension',
                  'all'],
                description: 'Filter by object type (class=AxClass, table=AxTable, enum=AxEnum, edt=AxEdt, form=AxForm, query=AxQuery, view=AxView, report=AxReport, security-privilege/duty/role=security objects, menu-item-display/action/output=menu items, table/class/form/enum/edt-extension=extensions, data-entity-extension=DE extensions, all=no filter)',
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
                      enum: ['class', 'table', 'field', 'method', 'enum', 'edt', 'form', 'query', 'view', 'report',
                        'security-privilege', 'security-duty', 'security-role',
                        'menu-item-display', 'menu-item-action', 'menu-item-output',
                        'table-extension', 'class-extension', 'form-extension',
                        'enum-extension', 'edt-extension', 'data-entity-extension',
                        'all'],
                      default: 'all',
                      description: 'Filter by object type. Omit to inherit globalTypeFilter or default to "all"',
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
              globalTypeFilter: {
                type: 'array',
                maxItems: 5,
                description:
                  'Default type filter for queries without an explicit per-query type. ' +
                  'E.g. ["class"] restricts all untyped queries to classes. ' +
                  'Multiple values fan out each untyped query into one search per type.',
                items: {
                  type: 'string',
                  enum: [
                    'class', 'table', 'form', 'field', 'method', 'enum', 'edt', 'query', 'view', 'report',
                    'security-privilege', 'security-duty', 'security-role',
                    'menu-item-display', 'menu-item-action', 'menu-item-output',
                    'table-extension', 'class-extension', 'form-extension',
                    'enum-extension', 'edt-extension', 'data-entity-extension',
                  ],
                },
              },
              deduplicate: {
                type: 'boolean',
                default: true,
                description:
                  'When true, symbols appearing in multiple query results are collapsed. ' +
                  'Later occurrences are replaced with a reference to the query where they first appeared.',
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

⚠️ READ-ONLY REFERENCE TOOL: Results show WHERE existing objects live. The model names in results are SOURCE models of those existing objects. They are NOT suggestions for where to create new objects.
❌ NEVER use a model name from search_extensions results as the target for create_d365fo_file, create_label, or modify_d365fo_file.
✅ The target model for ALL create/modify operations is ALWAYS from .mcp.json (modelName/projectPath).

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
- "create" / "build" / "implement" / "add new" / "generate" / "make"
- "batch job" = batch-job, "helper class" = helper class, "runnable" = runnable class
- ANY request to create NEW D365FO class, batch job, form handler, data entity
- "SysOperation" / "DataContract" / "event handler" / "security privilege" / "menu item"

WORKFLOW (ALWAYS follow):
1. Call analyze_code_patterns("description") → learn from existing code patterns
2. Call generate_code(pattern, name) → get X++ source code template
3. Call create_d365fo_file(objectType="class", objectName=name, sourceCode=<from step 2>, addToProject=true)

PATTERNS (X++ code):
- "batch-job" → Batch job (extends RunBaseBatch) with dialog, pack/unpack, contract class
- "class" → Standard helper/utility class
- "runnable" → Runnable class with main() method
- "form-handler" → Form event handler (datasource/control event subscribers)
- "data-entity" → Data entity with staging table
- "table-extension" → Table extension [ExtensionOf(tableStr(TableName))]
- "sysoperation" → Full SysOperation: DataContract + Controller + Service (3 classes)
  Controller uses new() override with parmClassName/parmMethodName (standard D365FO pattern)
  Optional: serviceMethod param to name the Service method (default: "process")
- "event-handler" → Class with [SubscribesTo] handlers for table/class events

PATTERNS (XML output — use for AOT XML files):
- "security-privilege" → AxSecurityPrivilege XML (generates View + Maintain privilege pair)
- "menu-item" → AxMenuItemDisplay/Action/Output XML

EXAMPLES:
- "Create SysOperation for processing orders"
  → generate_code(pattern="sysoperation", name="ProcessOrders")
- "Create SysOperation for processing orders with custom method name"
  → generate_code(pattern="sysoperation", name="ProcessOrders", serviceMethod="processOrders")
- "Create event handler for CustTable"
  → generate_code(pattern="event-handler", name="CustTable")
- "Create security privilege for CustTable form"
  → generate_code(pattern="security-privilege", name="CustTable", targetObject="CustTable")
- "Create menu item for CustTable form"
  → generate_code(pattern="menu-item", name="CustTable", menuItemType="display", targetObject="CustTable")`,
          inputSchema: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                enum: [
                  'class', 'runnable', 'form-handler', 'data-entity', 'batch-job', 'table-extension',
                  'sysoperation', 'event-handler', 'security-privilege', 'menu-item',
                  'class-extension', 'ssrs-report-full', 'lookup-form',
                  'dialog-box', 'dimension-controller', 'number-seq-handler',
                  'display-menu-controller', 'data-entity-staging', 'service-class-ais',
                  'form-datasource-extension', 'form-control-extension', 'map-extension',
                ],
                description: 'Code pattern to generate. ' +
                  'class-extension: [ExtensionOf(classStr(...))] CoC class skeleton. ' +
                  'table-extension: [ExtensionOf(tableStr(...))] with validateWrite/insert/update. ' +
                  'form-handler: [ExtensionOf(formStr(...))] wrapping form-level methods (init, close). ' +
                  'form-datasource-extension: [ExtensionOf(formDataSourceStr(Form, DS))] — wraps DS methods (init, executeQuery, active, write, validateWrite). Pass name=FormName, baseName=DataSourceName. ' +
                  'form-control-extension: [ExtensionOf(formControlStr(Form, Control))] — wraps control methods (modified, validate, lookup). Pass name=FormName, baseName=ControlName. ' +
                  'map-extension: [ExtensionOf(mapStr(...))] for X++ maps. ' +
                  'ssrs-report-full: DataContract + DP + Controller trio. ' +
                  'lookup-form: SysTableLookup static method. ' +
                  'dialog-box: Dialog class with prompt()/parm* methods. ' +
                  'dimension-controller: DimensionDefaultingController with form hooks. ' +
                  'number-seq-handler: NumberSeqFormHandler + CoC on loadModule() + CompanyInfo extension. ' +
                  'display-menu-controller: MenuFunction::main routing class. ' +
                  'data-entity-staging: copyCustomStagingToTarget() + DMFTransferStatus. ' +
                  'service-class-ais: CRUD service class + DataContract with [SysEntryPointAttribute].',
              },
              name: { type: 'string', description: 'Name for the generated element. For extensions: base element name. For form-datasource-extension / form-control-extension: the FORM name.' },
              modelName: { type: 'string', description: 'Actual model name from .mcp.json (auto-detected from EXTENSION_PREFIX env var if omitted). NEVER use generic placeholders like "MyModel".' },
              menuItemType: {
                type: 'string',
                enum: ['display', 'action', 'output'],
                description: 'For menu-item pattern: type of menu item (display=form, action=class, output=report)',
              },
              baseName: {
                type: 'string',
                description: 'For event-handler: base class or table name. ' +
                  'For form-datasource-extension: data source name within the form (defaults to form name if omitted). ' +
                  'For form-control-extension: exact control name — use get_form_info() to find the correct name.',
              },
              targetObject: {
                type: 'string',
                description: 'For menu-item and security-privilege patterns: target form/class/report name',
              },
              serviceMethod: {
                type: 'string',
                description: 'For sysoperation pattern: name of the method on the Service class the Controller will call. ' +
                  'Defaults to "process" when omitted. ' +
                  'Example: serviceMethod="processOrders" → generates processOrders(Contract _contract) on Service class.',
              },
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
          description: `🔥 CREATE D365FO FILE - REPLACES BUILT-IN create_file FOR ALL D365FO OBJECTS!

🚨 WARNING: BUILT-IN create_file WILL CORRUPT D365FO METADATA! NEVER USE IT FOR .xml FILES!

WHEN TO USE (MUST use for ANY D365FO object creation):
- User asks to CREATE, BUILD, IMPLEMENT, GENERATE new class, table, enum, form, query, view, data entity, or SSRS report
- Keywords: "create", "build", "implement", "add new", "generate", "make"
- "batch job" = batch-job class, "helper class" = helper class, "runnable" = runnable class, "report" = objectType="report"
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
- objectType: NEW objects → class, table, enum, form, query, view, data-entity, report, edt
             SECURITY    → security-privilege (AxSecurityPrivilege)
                           security-duty      (AxSecurityDuty)       ← NOT the same as privilege!
                           security-role      (AxSecurityRole)
             MENU ITEMS  → menu-item-display, menu-item-action, menu-item-output, menu
             EXTENSIONS  → table-extension, form-extension, enum-extension, edt-extension,
                           data-entity-extension, menu-item-display-extension,
                           menu-item-action-extension, menu-item-output-extension, menu-extension
  ⚠️ SECURITY RULE: ALWAYS use the matching type — duty ≠ privilege ≠ role:
     security-privilege → AxSecurityPrivilege folder
     security-duty      → AxSecurityDuty folder
     security-role      → AxSecurityRole folder
  ⚠️ EXTENSION RULE: Extending an EXISTING standard object? ALWAYS use the -extension variant:
     "table-extension" → AxTableExtension folder, objectName = "BaseTable.PrefixExtension"
     "form-extension"  → AxFormExtension folder,  objectName = "BaseForm.PrefixExtension"
     NEVER use objectType="table" to create a table extension — wrong folder, broken AOT!
- objectName: Name of the new object (e.g., "ProcessOpenOrdersBatch" for batch job)
  For extensions: "BaseElement.PrefixExtension" (e.g., "CustTable.ContosoExtension")
- modelName: Any value (auto-corrected from .rnrproj)
- addToProject: true (to automatically add to VS project)

IF A FILE WAS CREATED WITH WRONG objectType (e.g. "table" instead of "table-extension"):
❌ NEVER use PowerShell Move-Item / Rename-Item / Copy-Item to fix it
✅ Call create_d365fo_file again with the CORRECT objectType and overwrite=true

WORKFLOW:
1. generate_code(pattern="batch-job", name="MyBatch") → Get X++ code
2. create_d365fo_file(objectType="class", objectName="MyBatch", sourceCode=<step 1>, addToProject=true)

AXCLASS sourceCode FORMAT — CRITICAL:
The sourceCode string for a class MUST follow this exact layout:
  • Class header (attributes + class keyword + extends/implements) WITH member variable
    declarations INSIDE the outer { } — this block becomes <Declaration>
  • Method bodies follow AFTER the closing } of the class header — each becomes a <Method>

Example (correct):
  [DataContractAttribute]
  public class MyClass extends MyBase
  {
      int globalPackageNumber;
      Qty totalExportedQty;
  }
  public int globalPackageNumber(int _v = globalPackageNumber)
  {
      globalPackageNumber = _v;
      return globalPackageNumber;
  }

Common mistakes:
  ❌ Putting member variables OUTSIDE the class { } (they will be lost in <Declaration>)
  ❌ Omitting the class { } block entirely (all content treated as one method)
  ❌ Putting member variables inside a method body

EXAMPLES:
- "Create batch job for processing orders" → create_d365fo_file(objectType="class", objectName="ProcessOrdersBatch", addToProject=true)
- "Create helper class for sales calculations" → create_d365fo_file(objectType="class", objectName="SalesCalculationHelper", addToProject=true)`,
          inputSchema: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: [
                  'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report', 'edt',
                  'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
                  'data-entity-extension', 'menu-item-display-extension',
                  'menu-item-action-extension', 'menu-item-output-extension', 'menu-extension',
                  'menu-item-display', 'menu-item-action', 'menu-item-output', 'menu',
                  'security-privilege', 'security-duty', 'security-role',
                  'business-event', 'tile', 'kpi',
                ],
                description:
                  'Type of D365FO object to create. ' +
                  'class-extension: [ExtensionOf(classStr(...))] final class skeleton. ' +
                  'Security types: security-privilege → AxSecurityPrivilege, ' +
                  'security-duty → AxSecurityDuty, security-role → AxSecurityRole. ' +
                  'NEVER use security-privilege for a duty or role — each maps to its own AOT folder. ' +
                  'Menu items: menu-item-display/action/output → AxMenuItemDisplay/Action/Output. ' +
                  'business-event: BusinessEventsBase class + companion BusinessEventsContract. ' +
                  'tile: AxTile XML (TileType, MenuItemName, Size, RefreshFrequency). ' +
                  'kpi: AxKPI XML (Measure, MeasureDimension, Goal, GoalType).'
              },
              objectName: {
                type: 'string',
                description: 'Base name WITHOUT model prefix (e.g., "InventoryByZones", "ProcessOrdersBatch"). The tool auto-prepends the prefix derived from EXTENSION_PREFIX env var (or modelName as fallback). Double-prefix prevention: if you already include the prefix, the tool detects it and uses name as-is. EXTENSION_PREFIX always has priority over modelName for prefix resolution. FOR EXTENSION CLASSES (ending with "_Extension"): pass only the BASE class name + "_Extension" without ANY prefix infix — e.g. "SalesFormLetter_Extension" (not "SalesFormLetterSomePrefix_Extension"). The tool injects the correct prefix infix automatically, e.g. "SalesFormLetterMY_Extension". NEVER bypass this tool to work around prefix handling.'
              },
              modelName: {
                type: 'string',
                description: 'Actual model name from .mcp.json (e.g., "ContosoExt", "WHSExt", "ApplicationSuite") — determines the object naming prefix. ALWAYS read this from get_workspace_info() or workspace context. NEVER guess or use generic placeholders like "MyModel" or "MyPackage". DO NOT use model names from search results — those are source models of existing objects, not your target model.'
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
                description: `X++ source code for the object.\n\nFOR CLASSES — the content is split into <Declaration> and <Methods> automatically:\n  • <Declaration> = class keyword line + ALL member variable declarations inside the outer { }\n  • <Methods>     = each method defined AFTER the closing } of the class header\n\nExample for a class with member variables and a method:\n  public class MyClass\n  {\n      int globalPackageNumber;\n      Qty totalExportedQty;\n  }\n  public void myMethod()\n  {\n      // body\n  }\n\nCRITICAL: member variables MUST be inside the class { } block — NOT after it.`
              },
              properties: {
                type: 'object',
                description:
                  'Additional properties for the object being created. Supported keys by objectType:\n' +
                  '• class:           extends, implements, isFinal, isAbstract\n' +
                  '• table:           label, tableGroup, tableType, titleField1, titleField2, fields[]\n' +
                  '• enum:            label, isExtensible, enumValues[{name,value?,label?,helpText?}]\n' +
                  '• table-extension: fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — fieldType defaults to AxTableFieldString; use AxTableFieldEnum for enum-based fields (also set enumType)\n' +
                  '• edt:             label, extends, edtType, stringSize\n' +
                  '• form:            caption, formTemplate, dataSource\n' +
                  '• security-privilege: label, targetObject (menu item ObjectName), objectType (MenuItemDisplay|MenuItemAction|MenuItemOutput, default: MenuItemDisplay), accessLevel (view=Read only | maintain=Read+Update+Create+Delete, default: view)\n' +
                  '• menu-item-*:     label, object, objectType\n' +
                  'Example enum: properties={"label":"@ContosoExt:Status","enumValues":[{"name":"Open","label":"@ContosoExt:Open"},{"name":"Closed","label":"@ContosoExt:Closed"}]}\n' +
                  'Example table-extension (string EDT field): properties={"fields":[{"name":"ContosoField","edt":"CustAccount","label":"@Contoso:Customer"}]}\n' +
                  'Example table-extension (enum field): properties={"fields":[{"name":"ContosoStatus","enumType":"NoYes","fieldType":"AxTableFieldEnum","label":"@Contoso:Status"}]}'
              },
              addToProject: {
                type: 'boolean',
                description: '⚠️ ALWAYS set to true — adds file to Visual Studio project (.rnrproj). Default: true. Only set false when explicitly asked.',
                default: true
              },
              projectPath: {
                type: 'string',
                description: 'Path to .rnrproj file. Strongly recommended — required for addToProject to work. Auto-detected from .mcp.json context or workspace if omitted.'
              },
              solutionPath: {
                type: 'string',
                description: 'Path to VS solution directory. Used to find .rnrproj when projectPath is not specified.'
              },
              xmlContent: {
                type: 'string',
                description:
                  'Complete XML to write verbatim instead of generating a template. ' +
                  'Use with overwrite=true to completely rewrite an existing object. ' +
                  'Also used in Azure/Linux setups: generate XML via generate_smart_table/form, then pass here.',
              },
              overwrite: {
                type: 'boolean',
                description:
                  'Allow overwriting an existing file. Use together with xmlContent when you need to ' +
                  'completely rewrite an object (e.g. table with corrupted field names, wrong TableType, \u2026). ' +
                  'Default: false. ' +
                  '\u274c NEVER use PowerShell/create_file to overwrite D365FO objects \u2014 always use overwrite=true here.',
                default: false,
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
                enum: [
                  'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
                  'table-extension', 'form-extension', 'enum-extension', 'edt-extension',
                  'data-entity-extension'
                ],
                description: 'Type of D365FO object to generate'
              },
              objectName: {
                type: 'string',
                description: 'Base name WITHOUT model prefix. Prefix is auto-applied from modelName. See create_d365fo_file for details.'
              },
              modelName: {
                type: 'string',
                description: 'Model name from .mcp.json (determines prefix). DO NOT use model names from search results.'
              },
              sourceCode: {
                type: 'string',
                description: `X++ source code for the object.\n\nFOR CLASSES — same format as create_d365fo_file:\n  • Member variable declarations MUST be inside the class { } header block → goes to <Declaration>\n  • Methods follow AFTER the closing } of the class header → each becomes a <Method>\n\nExample:\n  public class MyClass\n  {\n      int myVar;\n      Qty myQty;\n  }\n  public void myMethod() { }`
              },
              properties: {
                type: 'object',
                description: `Additional properties depending on objectType:
- class/form/query/view: extends, implements, label
- table: label, tableGroup, fields[]
- enum: label, isExtensible, enumValues[{name,value?,label?,helpText?}]
- table-extension: fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — fieldType defaults to AxTableFieldString; use AxTableFieldEnum for enum-based fields (also set enumType)
- report (ALL REQUIRED for correct XML):
    dpClassName   {string}  Data Provider class name (e.g. "ContosoInventByZoneDP")
    tmpTableName  {string}  TempDB table name        (e.g. "ContosoInventByZoneTmp")
    datasetName   {string}  Dataset name — defaults to tmpTableName if omitted
    designName    {string}  Design name              (default: "Report")
    caption       {string}  Design caption label ref (e.g. "@MyModel:MyLabel")
    style         {string}  Design style             (e.g. "TableStyleTemplate")
    fields        {Array}   [{name, alias?, dataType?, caption?}] → AxReportDataSetField entries
    rdlContent    {string}  Full RDL XML to embed in <Text><![CDATA[...]]></Text>`
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
                enum: ['class', 'method', 'field', 'table', 'enum', 'edt', 'form', 'query', 'view', 'report', 'all'],
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
          description: '⚠️ WINDOWS ONLY: Safely modifies an existing D365FO XML file (class, table, enum, form, query, view). Supports adding/removing/modifying methods and fields, modifying properties. Validates XML after modification. IMPORTANT: This tool MUST run locally on Windows D365FO VM - it CANNOT work through Azure HTTP proxy (Linux).',
          inputSchema: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: ['class', 'table', 'form', 'enum', 'query', 'view', 'edt', 'data-entity', 'report', 'table-extension', 'class-extension', 'form-extension', 'enum-extension'],
                description: 'Type of D365FO object to modify'
              },
              objectName: {
                type: 'string',
                description: 'Name of the object to modify (e.g., CustTable, SalesTable)'
              },
              operation: {
                type: 'string',
                enum: [
                  'add-method', 'remove-method', 'replace-code',
                  'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
                  'add-display-method', 'add-table-method',
                  'add-index', 'remove-index',
                  'add-relation', 'remove-relation',
                  'add-field-group', 'remove-field-group', 'add-field-to-field-group',
                  'add-field-modification',
                  'add-data-source', 'add-control',
                  'add-enum-value', 'modify-enum-value', 'remove-enum-value',
                  'add-menu-item-to-menu',
                  'modify-property',
                ],
                description:
                  'Type of modification to perform.\n' +
                  'add-method: add a new method (or CoC method) to a class/table/form.\n' +
                  'remove-method: remove a method by name.\n' +
                  'replace-code: surgical in-place replacement — pass oldCode (exact snippet to find) + newCode (replacement text). ' +
                  'For form control override methods use methodName="ControlName.methodName" (e.g. "PostButton.clicked").\n' +
                  'add-field: add a field to a table or table-extension.\n' +
                  'modify-field: change EDT/mandatory/label of an existing field.\n' +
                  'rename-field: rename a field (also fixes index DataField refs and TitleField1/2 automatically).\n' +
                  'replace-all-fields: atomically rewrite ALL fields (use when field names are corrupted).\n' +
                  'remove-field: remove a field by name.\n' +
                  'add-display-method: add a display method with [SysClientCacheDataMethodAttribute].\n' +
                  'add-table-method: generate canonical boilerplate for find/exist/findByRecId/validateWrite/validateDelete/initValue.\n' +
                  'add-index / remove-index: manage table indexes.\n' +
                  'add-relation / remove-relation: manage table relations.\n' +
                  'add-field-group / remove-field-group / add-field-to-field-group: manage field groups.\n' +
                  'add-field-modification: override base-table field label/mandatory in a table-extension.\n' +
                  'add-data-source: add a data source to a form or form-extension.\n' +
                  'add-control: add a UI control to a form-extension.\n' +
                  'add-enum-value / modify-enum-value / remove-enum-value: manage enum values.\n' +
                  'add-menu-item-to-menu: add a typed menu item entry to a menu or menu-extension.\n' +
                  'modify-property: change any table/EDT/class-level property (TableGroup, TitleField1, TableType, Extends, …).'
              },
              methodName: {
                type: 'string',
                description: 'Method name (required for add-method, remove-method)'
              },
              sourceCode: {
                type: 'string',
                description:
                  '[add-method] PREFERRED parameter — pass the FULL X++ method source: ' +
                  'access modifiers + return type + method name + parameters + body + optional attributes. ' +
                  'Example: "public void myMethod(str _param)\\n{\\n    next myMethod(_param);\\n}". ' +
                  'The tool detects that the first real code line contains an access modifier and the method ' +
                  'name followed by "(" and stores the source as-is without adding an extra signature. ' +
                  'Alias of methodCode \u2014 use this when passing a complete CoC skeleton or any full method.'
              },
              methodCode: {
                type: 'string',
                description:
                  '[add-method] X++ source for the method. Accepts either the FULL method source ' +
                  '(access modifiers + return type + name + params + body) or just the body. ' +
                  'When a full source is supplied the signature is preserved as-is. ' +
                  'When only a body is supplied the signature is assembled from methodModifiers, ' +
                  'methodReturnType, methodName, and methodParameters. ' +
                  'Alias: sourceCode (preferred \u2014 pass sourceCode instead for clarity).'
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
              oldCode: {
                type: 'string',
                description:
                  '[replace-code] REQUIRED. Exact existing X++ code snippet to find and replace. ' +
                  'Must match the source text exactly (leading/trailing whitespace is trimmed). ' +
                  'If methodName is also provided, the search is scoped to that method only. ' +
                  'For form control override methods, use methodName="ControlName.methodName" (e.g. "PostButton.clicked").'
              },
              newCode: {
                type: 'string',
                description:
                  '[replace-code] REQUIRED. Replacement X++ code snippet. ' +
                  'Replaces the first occurrence of oldCode. ' +
                  'Pass empty string "" to delete the matched oldCode snippet.'
              },
              fieldName: {
                type: 'string',
                description: 'Field name (required for add-field, modify-field, rename-field, remove-field)'
              },
              fieldNewName: {
                type: 'string',
                description:
                  'New field name (required for rename-field). ' +
                  'Also fixes index DataField refs and TitleField1/2 automatically. ' +
                  'Works even if the field in <Fields> was already renamed (e.g. by replace-all-fields) — ' +
                  'in that case only the index DataField references are updated (repair-only mode). ' +
                  'Pass fieldName=old corrupted name, fieldNewName=correct name.'
              },
              fieldType: {
                type: 'string',
                description: 'EDT name for the field (required for add-field, e.g. "InventQty", "WHSZoneId", "TransDate"). For modify-field: new EDT to set.'
              },
              fieldBaseType: {
                type: 'string',
                enum: ['String', 'Integer', 'Real', 'Date', 'DateTime', 'Int64', 'GUID', 'Enum'],
                description:
                  'Base type for add-field — determines the XML element (AxTableFieldReal, AxTableFieldDate, …). ' +
                  'REQUIRED when fieldType is an EDT name. Without it defaults to AxTableFieldString (WRONG for Real/Date/Int64!). ' +
                  'Examples: fieldType="InventQty" + fieldBaseType="Real" → AxTableFieldReal; ' +
                  'fieldType="TransDate" + fieldBaseType="Date" → AxTableFieldDate; ' +
                  'fieldType="WHSZoneId" + fieldBaseType="String" → AxTableFieldString.'
              },
              fieldMandatory: {
                type: 'boolean',
                description: 'Is field mandatory (for add-field and modify-field)'
              },
              fieldLabel: {
                type: 'string',
                description: 'Field label (for add-field and modify-field)'
              },
              fields: {
                type: 'array',
                description:
                  'Full replacement field list for replace-all-fields operation. ' +
                  'Each item: { name: string, edt?: string, type?: string, mandatory?: boolean, label?: string }. ' +
                  'Use when field names are corrupted (contain spaces, wrong casing, wrong EDT). ' +
                  'All existing fields are replaced atomically. ' +
                  '❌ NEVER use PowerShell/create_file for this — always use replace-all-fields.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name' },
                    edt:  { type: 'string', description: 'EDT name, e.g. "InventQty", "WHSZoneId"' },
                    type: {
                      type: 'string',
                      enum: ['String', 'Integer', 'Real', 'Date', 'DateTime', 'Int64', 'GUID', 'Enum'],
                      description:
                        'Base type — REQUIRED alongside edt to get the correct XML element. ' +
                        'Determines AxTableFieldReal/AxTableFieldDate/… ' +
                        'Without it defaults to AxTableFieldString (wrong for numeric/date EDTs!). ' +
                        'Example: { name:"TransQty", edt:"InventQty", type:"Real" }'
                    },
                    mandatory: { type: 'boolean' },
                    label: { type: 'string' },
                  },
                  required: ['name'],
                },
              },
              propertyPath: {
                type: 'string',
                description:
                  'Property name to set on the object.\n\n' +
                  'For **AxTable** (objectType="table"): direct child XML element — ' +
                  'TableGroup (Group/Parameter/Main/WorksheetHeader/WorksheetLine/Miscellaneous/Framework), ' +
                  'TitleField1, TitleField2, TableType (TempDB/InMemory/RegularTable), CacheLookup, ' +
                  'ClusteredIndex, PrimaryIndex, SaveDataPerCompany (Yes/No), Label, HelpText, Extends, SystemTable (Yes/No).\n\n' +
                  'For **AxTableExtension** (objectType="table-extension"): properties are stored in ' +
                  '<PropertyModifications>/<AxPropertyModification> — NOT as direct elements. ' +
                  'Supported names: Label, HelpText, TableGroup, CacheLookup, TitleField1, TitleField2, ' +
                  'ClusteredIndex, PrimaryIndex, SaveDataPerCompany, TableType, SystemTable, ' +
                  'ModifiedDateTime (Yes/No), CreatedDateTime (Yes/No), ModifiedBy (Yes/No), CreatedBy (Yes/No), ' +
                  'CountryRegionCodes (comma-separated ISO codes, e.g. "CZ,SK").\n\n' +
                  'For **AxEdt** (objectType="edt"): Extends, StringSize, Label, HelpText, ReferenceTable, ReferenceField.\n\n' +
                  'For **AxClass** (objectType="class"): Extends, Abstract (true/false), Final (true/false), Label.\n\n' +
                  'Examples: ' +
                  'propertyPath="Label" propertyValue="@MyModel:MyLabel" | ' +
                  'propertyPath="HelpText" propertyValue="@MyModel:MyHelpText" | ' +
                  'propertyPath="TableGroup" propertyValue="Group" | ' +
                  'propertyPath="TitleField1" propertyValue="ItemId" | ' +
                  'propertyPath="TableType" propertyValue="TempDB" | ' +
                  'propertyPath="ModifiedDateTime" propertyValue="Yes" (table-extension) | ' +
                  'propertyPath="CountryRegionCodes" propertyValue="CZ,SK" (table-extension) | ' +
                  'propertyPath="Extends" propertyValue="WHSZoneId" (EDT)'
              },
              propertyValue: {
                type: 'string',
                description: 'New property value (required for modify-property)'
              },
              controlName: {
                type: 'string',
                description:
                  '[add-control only] Name of the new form control. ' +
                  'e.g. "MyCustPriorityTier". Becomes <Name> inside <FormControl>. ' +
                  'MUST match the field name in the table extension so the binding works.'
              },
              parentControl: {
                type: 'string',
                description:
                  '[add-control only] Name of the existing parent tab/group in the base form. ' +
                  'e.g. "TabGeneral", "TabPageSales", "HeaderGroup". ' +
                  'Use get_form_info(formName, searchControl="General") to find the exact name.'
              },
              controlDataSource: {
                type: 'string',
                description: '[add-control only] Data source name for the control binding (e.g. "CustTable").'
              },
              controlDataField: {
                type: 'string',
                description:
                  '[add-control only] Data field name for the control binding (e.g. "MyCustPriorityTier"). ' +
                  'The field must already exist in the table or table extension before binding it here.'
              },
              controlType: {
                type: 'string',
                description:
                  '[add-control only] Form control type (default: String). ' +
                  'Values: String, Integer, Real, CheckBox, ComboBox, Date, DateTime, Int64, Group, Button, CommandButton, MenuFunctionButton. ' +
                  'Use CheckBox for NoYes/boolean. Use ComboBox for enum fields. ' +
                  'When omitted defaults to String (correct for most EDT-bound fields).'
              },
              positionType: {
                type: 'string',
                description: '[add-control only] Optional: AfterItem | BeforeItem. Omit to append at the end of the parent.'
              },
              previousSibling: {
                type: 'string',
                description: '[add-control only] Name of the sibling control to position after (used with positionType=AfterItem).'
              },
              createBackup: {
                type: 'boolean',
                description: 'Create backup before modification (default: false)',
                default: false
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
          name: 'get_method_source',
          description: `📄 Get the full X++ source code of a specific method. Use this when you need to understand the complete implementation — business logic, conditions, loops, error handling — not just the signature.

⚠️ ONLY call this for methods you have already confirmed exist via \`get_class_info\`. Never guess or infer a method name from D365FO conventions (e.g. parm*, find, exist) — the method may not be defined in this class. If unsure, call \`get_class_info\` first and pick the method name from the returned list.

Returns:
- Complete method body as X++ code
- Method signature
- Model name

Use WHEN:
- Analysing what a method actually does (not just its signature)
- Understanding business logic before writing an extension
- Reviewing validation rules, posting logic, or workflow steps
- Comparing implementations across classes

Examples:
- get_method_source("SalesTable", "validateWrite") → full validation logic
- get_method_source("CustTable", "insert") → complete insert implementation
- get_method_source("InventUpd_Reservation", "updateReservation") → full reservation logic`,
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the class containing the method',
              },
              methodName: {
                type: 'string',
                description: 'Name of the method to retrieve source code for',
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

⚡ FAST CONTROL LOOKUP — use searchControl parameter:
  get_form_info("SalesTable", searchControl="General") returns only controls whose
  name contains "General", with path, parent name, and children.
  ❌ NEVER use PowerShell Get-Content or grep to find tab names in form XML.
  ✅ ALWAYS use searchControl instead — this tool CAN read ALL D365FO forms.

⚠️ If you receive a "could not be read from disk" warning, the response will include
  a ready-to-use retry command with filePath= already filled in.
  ❌ NEVER fall back to PowerShell when this happens — just retry with filePath.

Examples:
- get_form_info("SalesTable") → full structure with datasources, grids, tab hierarchy
- get_form_info("CustTable", searchControl="General") → find the General tab exact name
- get_form_info("PurchTable", searchControl="LineView") → find the LineView grid name
- get_form_info("MyForm", filePath="K:\\\\AOSService\\\\...\\\\AxForm\\\\MyForm.xml") → bypass DB lookup`,
          inputSchema: {
            type: 'object',
            properties: {
              formName: {
                type: 'string',
                description: 'Name of the form (e.g., SalesTable, CustTable, InventTable)'
              },
              filePath: {
                type: 'string',
                description:
                  'Absolute path to the form XML file. Use this when get_form_info returned a ' +
                  '"could not be read from disk" warning \u2014 the warning includes the exact path to pass here. ' +
                  'Bypasses the DB path lookup entirely. ' +
                  'Example: "K:\\\\AOSService\\\\PackagesLocalDirectory\\\\ContosoCore\\\\ContosoCore\\\\AxForm\\\\MyForm.xml"',
              },
              searchControl: {
                type: 'string',
                description: 'Case-insensitive substring to search for in control names. ' +
                  'Returns matching controls with path, parent name, and children. ' +
                  'Use this to find exact tab/group names for form extensions. ' +
                  'NEVER use PowerShell to search form XML \u2014 use this instead.',
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
              mode: {
                type: 'string',
                enum: ['standard', 'hierarchy'],
                description: 'standard=normal EDT details (default), hierarchy=show full ancestor chain + direct children + field usages',
                default: 'standard',
              },
            },
            required: ['edtName'],
          },
        },
        {
          name: 'get_report_info',
          description: `📄 Read AxReport XML structure directly — datasets, fields, designs, RDL summary.

Use this INSTEAD of PowerShell Get-Content when studying an existing SSRS report.
Returns structured info without running any shell commands.

Returns:
- DataSets: name, DataSourceType, Query string, all AxReportDataSetField entries (Name/Alias/DataType/Caption)
- Designs: name, Caption, linked DataSet, Style, whether RDL is embedded
- RDL summary (element counts: Tablix, groups, parameters, language) — use includeRdl=true for full RDL
- DataMethods presence, EmbeddedImages count

Use WHEN:
- Studying an existing report before creating a similar one
- Checking what fields/aliases a DataSet exposes
- Verifying report structure after create_d365fo_file
- Understanding RDL design without opening Report Designer

Examples:
- get_report_info("InventValue") → datasets, fields, design structure of InventValue report
- get_report_info("ContosoInventByZone") → datasets + RDL summary
- get_report_info("ContosoInventByZone", includeRdl=true) → full embedded RDL XML`,
          inputSchema: {
            type: 'object',
            properties: {
              reportName: {
                type: 'string',
                description: 'Name of the AxReport object (e.g. "InventValue", "ContosoInventByZone")',
              },
              modelName: {
                type: 'string',
                description: 'Model name — auto-detected from .mcp.json if not provided',
              },
              includeFields: {
                type: 'boolean',
                description: 'Include AxReportDataSetField entries (default: true)',
                default: true,
              },
              includeRdl: {
                type: 'boolean',
                description: 'Include full embedded RDL content — can be large (default: false; use true only when you need to read/modify the RDL)',
                default: false,
              },
            },
            required: ['reportName'],
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
- search_labels("batch group") → finds MyFeature, BatchGroup, etc.
- search_labels("MyFeature", model="MyModel") → labels in custom MyModel model
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
                description: 'Restrict to a specific model (e.g. ContosoExt, ApplicationPlatform)',
              },
              labelFileId: {
                type: 'string',
                description: 'Restrict to a specific label file ID (e.g. ContosoExt, SYS)',
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
- get_label_info("MyFeature", model="MyModel") → all translations
- get_label_info(model="MyModel") → list label files in MyModel
- get_label_info("BatchGroup") → all languages for BatchGroup`,
          inputSchema: {
            type: 'object',
            properties: {
              labelId: {
                type: 'string',
                description: 'Exact label ID (e.g. MyFeature). Omit to list available label files.',
              },
              labelFileId: {
                type: 'string',
                description: 'Label file ID (e.g. ContosoExt, SYS)',
              },
              model: {
                type: 'string',
                description: 'Model to filter by (e.g. ContosoExt)',
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
- create_label("MyNewField", "MyModel", "MyModel", [{language:"en-US", text:"My new field"}, {language:"cs", text:"Moje nové pole"}])
- create_label with createLabelFileIfMissing=true → creates AxLabelFile structure from scratch`,
          inputSchema: {
            type: 'object',
            properties: {
              labelId: {
                type: 'string',
                description:
                  'Unique label identifier (alphanumeric). ' +
                  '⛔ NEVER add a model/object prefix — label IDs describe meaning, not ownership. ' +
                  'Good: "CustomerName", "InvoiceDate", "ErrorAmountNegative". ' +
                  'Bad (prefixed): "MyModelCustomerName", "ContosoExtInvoiceDate".',
              },
              labelFileId: {
                type: 'string',
                description: 'Label file ID (e.g. ContosoExt)',
              },
              model: {
                type: 'string',
                description: 'Model name that owns the label file (e.g. ContosoExt)',
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
              description: {
                type: 'string',
                description: 'Label description (comment line in .label.txt). Defaults to VS project name from .rnrproj when omitted, then falls back to labelFileId. Per-translation comment and defaultComment take priority.',
              },
              packagePath: {
                type: 'string',
                description: 'Root packages path. Auto-detected from environment config if omitted.',
              },
              projectPath: {
                type: 'string',
                description: 'Path to the .rnrproj project file. Auto-detected from .mcp.json if omitted.',
              },
              solutionPath: {
                type: 'string',
                description: 'Path to the .sln solution directory. Fallback to find .rnrproj if projectPath is not set.',
              },
              addToProject: {
                type: 'boolean',
                description: 'Add label file XML descriptors to the VS project (default: true)',
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
          name: 'rename_label',
          description: `🏷️ Rename a D365FO label ID everywhere it is used.

Renames the label in ALL of the following places:
1. Every .label.txt file in the model (the label entry itself)
2. Every X++ source file (.xpp) that references @LabelFileId:OldId
3. Every XML metadata file that references @LabelFileId:OldId (Label, HelpText, Caption, etc.)
4. Updates the MCP SQLite label index

⚠️ Run with dryRun=true first to preview the impact before committing!

Examples:
- rename_label(oldLabelId="OldName", newLabelId="NewName", labelFileId="MyModel", model="MyModel", dryRun=true)
- rename_label(oldLabelId="OldName", newLabelId="NewName", labelFileId="MyModel", model="MyModel")`,
          inputSchema: {
            type: 'object',
            properties: {
              oldLabelId: {
                type: 'string',
                description: 'Current label ID to rename (e.g. MyOldField)',
              },
              newLabelId: {
                type: 'string',
                description: 'New label ID — must be alphanumeric, no spaces (e.g. MyRenamedField)',
              },
              labelFileId: {
                type: 'string',
                description: 'Label file ID that owns the label (e.g. ContosoExt, SYS)',
              },
              model: {
                type: 'string',
                description: 'Model name that owns the label file (e.g. ContosoExt)',
              },
              packageName: {
                type: 'string',
                description: 'Package name for the model. Auto-resolved if omitted.',
              },
              packagePath: {
                type: 'string',
                description: 'Root PackagesLocalDirectory path. Auto-detected if omitted.',
              },
              searchPaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Additional absolute directory paths to scan for X++ / XML references.',
              },
              dryRun: {
                type: 'boolean',
                description: 'Preview changes without writing anything (default: false). Use this first!',
              },
              updateIndex: {
                type: 'boolean',
                description: 'Update the MCP label index after renaming (default: true)',
              },
            },
            required: ['oldLabelId', 'newLabelId', 'labelFileId', 'model'],
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
                description:
                  'Table group (business role). Defined by the system enum TableGroup (source: MSDN). ' +
                  'Valid values: ' +
                  '"Miscellaneous" = DEFAULT for new tables (e.g. TableExpImpDef); ' +
                  '"Main" = master table for a central business object (e.g. CustTable, VendTable); ' +
                  '"Transaction" = transaction data, not edited directly (e.g. CustTrans, VendTrans); ' +
                  '"Parameter" = setup data for a Main table, one record/company (e.g. CustParameters); ' +
                  '"Group" = categorisation for a Main table, one-to-many with Main (e.g. CustGroup); ' +
                  '"WorksheetHeader" = worksheet header, one-to-many with WorksheetLine (e.g. SalesTable); ' +
                  '"WorksheetLine" = lines to validate → transactions, may be deleted safely (e.g. SalesLine); ' +
                  '"Reference" = shared reference/lookup data; ' +
                  '"Framework" = internal Microsoft framework tables. ' +
                  '⛔ NEVER pass "TempDB" or "InMemory" here — use tableType instead.',
              },
              tableType: {
                type: 'string',
                description:
                  'Table storage type (TableType property, source: MSDN). Valid values: ' +
                  '"Regular"/"RegularTable" = DEFAULT, permanent — omit for regular tables; ' +
                  '"TempDB" = temporary table in SQL TempDB, dropped after use, joins are EFFICIENT; ' +
                  '"InMemory" = temporary ISAM file on AOS tier, joins are INEFFICIENT (= old AX2009 Temporary). ' +
                  '⛔ NEVER pass this value as tableGroup.',
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
        {
          name: 'generate_smart_report',
          description: `🎨 AI-driven SSRS report generation — creates up to 5 D365FO objects in one call.

Generates:
1. TmpTable (TempDB) — report data storage
2. Contract class (DataContractAttribute) — dialog parameters
3. DP class (SrsReportDataProviderBase) — data processing
4. Controller class (SrsReportRunController) — menu item entry point (optional)
5. AxReport XML + RDL design — dataset + tablix bound to DP/TmpTable

Strategies:
- fieldsHint: comma-separated field names → auto-suggest EDTs, build TmpTable + report fields
- fields: structured field specs with explicit EDTs and .NET data types
- contractParams: dialog parameters → Contract class with parm methods
- copyFrom: copy field structure from existing report's TmpTable
- designStyle: SimpleList (default) or GroupedWithTotals

⛔ NEVER call generate_smart_report without fieldsHint, fields, or copyFrom — no fields = no XML.
⛔ NEVER add model prefix to the name parameter — prefix is applied automatically.
⛔ On Azure/Linux: call create_d365fo_file for EACH returned object block, in order.
⛔ On Windows: DO NOT call create_d365fo_file — files are written directly.

Examples:
- generate_smart_report(name="InventByZones", fieldsHint="ItemId, ItemName, Qty, Zone", caption="Inventory by Zones")
- generate_smart_report(name="CustBalance", fieldsHint="CustAccount, Name, Balance", contractParams=[{name:"FromDate",type:"TransDate"},{name:"ToDate",type:"TransDate"}])
- generate_smart_report(name="SalesReport", copyFrom="SalesInvoice")`,
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Base report name WITHOUT model prefix (e.g. "InventByZones"). Prefix applied automatically.',
              },
              caption: {
                type: 'string',
                description: 'Human-readable caption/title for the report (e.g. "Inventory by Zones").',
              },
              fieldsHint: {
                type: 'string',
                description: 'Comma-separated field names for the TmpTable (e.g. "ItemId, ItemName, Qty, Zone"). EDTs auto-suggested.',
              },
              fields: {
                type: 'array',
                description: 'Structured field specs. Takes priority over fieldsHint.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    edt: { type: 'string' },
                    dataType: { type: 'string', description: '.NET type, e.g. "System.Double"' },
                    label: { type: 'string' },
                  },
                  required: ['name'],
                },
              },
              contractParams: {
                type: 'array',
                description: 'Dialog parameters for the Contract class.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', description: 'X++ type — EDT or primitive (e.g. "TransDate", "CustAccount")' },
                    label: { type: 'string' },
                    mandatory: { type: 'boolean' },
                  },
                  required: ['name'],
                },
              },
              generateController: {
                type: 'boolean',
                description: 'Generate Controller class (default: true)',
              },
              designStyle: {
                type: 'string',
                description: 'RDL design pattern: "SimpleList" (default) or "GroupedWithTotals"',
              },
              copyFrom: {
                type: 'string',
                description: 'Copy field structure from existing report name',
              },
              modelName: {
                type: 'string',
                description: 'Model name (auto-detected from projectPath)',
              },
              projectPath: {
                type: 'string',
                description: 'Path to .rnrproj file',
              },
              solutionPath: {
                type: 'string',
                description: 'Path to solution directory',
              },
              packagePath: {
                type: 'string',
                description: 'Base packages directory path',
              },
            },
            required: ['name'],
          },
        },
      // ── New tools: security, menu items, extensions ──────────────────────────────
      {
        name: 'get_security_artifact_info',
        description: `Get detailed info for a D365FO security privilege, duty, or role.
Walks the full hierarchy: Role → Duties → Privileges → Entry Points.

Use for:
- Auditing what a role or duty grants access to
- Finding which roles cover a specific privilege
- Understanding the entry-point/access-level details of a privilege

Examples:
  { name: "CustTableFullControl", artifactType: "privilege" }
  { name: "CustTableMaintain", artifactType: "duty", includeChain: true }
  { name: "AccountsReceivableClerk", artifactType: "role" }`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the security privilege, duty, or role' },
            artifactType: {
              type: 'string',
              enum: ['privilege', 'duty', 'role'],
              description: 'Type of security artifact to look up',
            },
            includeChain: { type: 'boolean', description: 'Walk the full hierarchy (default: true)', default: true },
          },
          required: ['name', 'artifactType'],
        },
      },
      {
        name: 'get_menu_item_info',
        description: `Get details for a D365FO menu item including target object and full security chain.

Shows the privilege → duty → role chain that grants access to this menu item.

Examples:
  { name: "CustTable", itemType: "display" }
  { name: "LedgerJournalTable", itemType: "any" }`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the menu item' },
            itemType: {
              type: 'string',
              enum: ['display', 'action', 'output', 'any'],
              description: 'Menu item type filter (default: any)',
              default: 'any',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'find_coc_extensions',
        description: `Find all Chain of Command (CoC) extensions for a D365FO class or table method.

Also shows event handler subscriptions (SubscribesTo) for the target class/table.

Use this before writing a CoC extension to:
1. Check if the method is already wrapped
2. Understand which models extend this class
3. Find potential conflicts

Examples:
  { className: "SalesFormLetter" }
  { className: "SalesLine", methodName: "validateWrite" }
  { className: "CustTable", includeEventHandlers: true }`,
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'Base class or table name being extended' },
            methodName: { type: 'string', description: 'Optional: filter to a specific method name' },
            includeEventHandlers: {
              type: 'boolean',
              description: 'Also find static event subscriptions (SubscribesTo) (default: true)',
              default: true,
            },
          },
          required: ['className'],
        },
      },
      {
        name: 'get_table_extension_info',
        description: `Get all extensions for a D365FO table and show the effective merged schema.

Lists every extension across all models that add fields, indexes, or methods to the table.

Examples:
  { tableName: "CustTable" }
  { tableName: "SalesLine", includeEffectiveSchema: true }`,
        inputSchema: {
          type: 'object',
          properties: {
            tableName: { type: 'string', description: 'Base table name whose extensions to find' },
            includeEffectiveSchema: {
              type: 'boolean',
              description: 'Merge base + extension counts (default: true)',
              default: true,
            },
          },
          required: ['tableName'],
        },
      },
      {
        name: 'get_data_entity_info',
        description: `Get D365FO-specific metadata for a data entity (AxDataEntityView).

Shows OData settings, DMF configuration, staging table, data sources, and keys.
Use instead of get_view_info when working with entities for OData/DMF integrations.

Examples:
  { entityName: "CustCustomerV3Entity" }
  { entityName: "SalesOrderHeaderV2Entity" }`,
        inputSchema: {
          type: 'object',
          properties: {
            entityName: { type: 'string', description: 'Name of the data entity (AxDataEntityView name)' },
          },
          required: ['entityName'],
        },
      },
      {
        name: 'find_event_handlers',
        description: `Find all event handler subscriptions for a D365FO class or table.

Searches for static SubscribesTo handlers and delegate += subscriptions.
Use before adding event handlers to check for duplicates.

Examples:
  { targetTable: "CustTable" }
  { targetClass: "SalesFormLetter", eventName: "onPostRun" }
  { targetTable: "SalesLine", eventName: "onValidatedWrite" }`,
        inputSchema: {
          type: 'object',
          properties: {
            targetClass: { type: 'string', description: 'Class whose events to find handlers for' },
            targetTable: { type: 'string', description: 'Table whose events to find handlers for' },
            eventName: { type: 'string', description: 'Filter to a specific event name (e.g. onInserted)' },
            handlerType: {
              type: 'string',
              enum: ['static', 'delegate', 'all'],
              description: 'Filter by handler type (default: all)',
              default: 'all',
            },
          },
        },
      },
      {
        name: 'get_security_coverage_for_object',
        description: `Show what security privileges, duties, and roles cover a D365FO object.

Traces the reverse chain: object → menu items → privileges → duties → roles.

Examples:
  { objectName: "CustTable" }
  { objectName: "LedgerJournalTable", objectType: "form" }
  { objectName: "CustTableListPage", objectType: "menu-item" }`,
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string', description: 'Name of the form, table, class, or menu item' },
            objectType: {
              type: 'string',
              enum: ['form', 'table', 'class', 'menu-item', 'auto'],
              description: 'Type of the object (default: auto-detect)',
              default: 'auto',
            },
          },
          required: ['objectName'],
        },
      },
      {
        name: 'analyze_extension_points',
        description: `Analyze available extension points for a D365FO class, table, or form.

For classes: CoC-eligible methods, replaceable methods, delegates, and blocked methods.
For tables: 8 standard table events + custom delegates.
For forms: data sources and form methods.
Shows which extension points are already used by existing extensions.

Use this before writing any extension.

Examples:
  { objectName: "SalesLine", objectType: "table" }
  { objectName: "SalesFormLetter", objectType: "class" }
  { objectName: "CustTable", showExistingExtensions: true }`,
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string', description: 'Class, table, or form name to analyze' },
            objectType: {
              type: 'string',
              enum: ['class', 'table', 'form', 'auto'],
              description: 'Object type (default: auto-detect)',
              default: 'auto',
            },
            showExistingExtensions: {
              type: 'boolean',
              description: 'Show which extension points are already extended (default: true)',
              default: true,
            },
          },
          required: ['objectName'],
        },
      },
      {
        name: 'recommend_extension_strategy',
        description: `Recommends the best D365FO extensibility mechanism for a given scenario.

Prevents common design mistakes — e.g. using CoC where a Business Event or delegate is appropriate,
or using a Business Event for inbound data where a Data Entity is correct.

Returns: recommended mechanism, reasoning, risks/caveats, alternatives, anti-patterns, and next MCP tool calls.

Use BEFORE writing any extension code to ensure the right approach.

Examples:
  { goal: "validate that SalesLine quantity is positive", objectName: "SalesLine" }
  { goal: "send order confirmation to external ERP" }
  { goal: "add custom field to CustTable form", objectName: "CustTable" }
  { goal: "import vendor data from CSV", scenario: "inbound-data" }`,
        inputSchema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'What you want to achieve — e.g. "validate that SalesLine quantity is positive"',
            },
            objectName: {
              type: 'string',
              description: 'Target D365FO object if known — e.g. "SalesTable", "CustTable"',
            },
            scenario: {
              type: 'string',
              enum: ['data-validation', 'field-defaulting', 'business-logic-change',
                     'outbound-integration', 'inbound-data', 'ui-modification',
                     'document-output', 'number-sequence', 'security-access',
                     'batch-processing', 'custom'],
              description: 'Scenario category (auto-detected from goal if omitted)',
            },
          },
          required: ['goal'],
        },
      },
      {
        name: 'validate_object_naming',
        description: `Validate a proposed D365FO object name against naming conventions.

Checks:
1. Extension naming rules: {Base}{Prefix}_Extension (class) or {Base}.{Prefix}Extension (AOT)
2. Prefix requirements: custom objects must use ISV/model prefix — two valid patterns:
   - Direct prefix:    MYVendPaymTermsMaintain    (prefix concatenated directly)
   - Prefix separator: MY_VendPaymTermsMaintain   (prefix + underscore + name — also valid)
   Underscore at any other position is an error.
3. Type-specific rules: privilege → View/Maintain suffix, data entity → Entity suffix
4. Conflict detection: exact match + similar names against the symbol index

Auto-detects the model prefix from EXTENSION_PREFIX env var (same as get_workspace_info).
Pass modelPrefix explicitly to override.

Examples:
  { proposedName: "VendTableMY_Extension", objectType: "class-extension", baseObjectName: "VendTable", modelPrefix: "MY" }
  { proposedName: "CustTable.MyExtension", objectType: "table-extension", baseObjectName: "CustTable", modelPrefix: "My" }
  { proposedName: "MY_VendPaymTermsMaintain", objectType: "security-privilege", modelPrefix: "MY" }`,
        inputSchema: {
          type: 'object',
          properties: {
            proposedName: { type: 'string', description: 'The proposed object name to validate' },
            objectType: {
              type: 'string',
              enum: ['class', 'table', 'form', 'enum', 'edt', 'query', 'view',
                'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
                'menu-item', 'security-privilege', 'security-duty', 'security-role', 'data-entity'],
              description: 'Type of the D365FO object',
            },
            baseObjectName: {
              type: 'string',
              description: 'Required for extension types: name of the object being extended',
            },
            modelPrefix: {
              type: 'string',
              description: 'Expected ISV/model prefix (2-4 uppercase letters, e.g. "WHS"). Auto-detected if omitted.',
            },
          },
          required: ['proposedName', 'objectType'],
        },
      },
      {
        name: 'get_workspace_info',
        description: `🔌 ALWAYS call this FIRST at the start of every D365FO session to verify the workspace configuration.

Returns the configured model name, package path, project path, environment type, EXTENSION_PREFIX value, and effective object prefix.
Explicitly flags whether the model name is a placeholder (MyModel, MyPackage, etc.) — if so, STOP and inform the user before doing anything else.
Also warns when EXTENSION_PREFIX is not set in the server environment (prefix will fall back to model name, which may be wrong for models with hyphens like "fm-mcp").

When the configured modelName IS a placeholder, this tool auto-detects the real model name
from the .rnrproj file and shows it as a concrete fix suggestion, so the user knows exactly
what value to put in .mcp.json.

**Solution switching (VS 2022):** When the user opens a different D365FO solution or says
"switch to <ProjectName>", call get_workspace_info with projectName (preferred) or projectPath.
  - projectName: just the model name, e.g. "ContosoEDS" — server resolves the path automatically.
  - projectPath: full path to the .rnrproj file (fallback when name is ambiguous).
The server switches context immediately without restart.
If D365FO_SOLUTIONS_PATH is configured, the output lists all available projects.

Use this instead of get_label_info or search to detect the correct model — those tools return
SOURCE models of existing objects, not the TARGET model for new objects.`,
        inputSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              description: 'Preferred way to switch projects. Just the model name, e.g. "ContosoEDS" or "ContosoBank". The server resolves the full path from D365FO_SOLUTIONS_PATH automatically. Use this when the user says "switch to <project>" or opens a different solution.',
            },
            projectPath: {
              type: 'string',
              description: 'Absolute path to a .rnrproj file. Fallback when projectName is ambiguous or D365FO_SOLUTIONS_PATH is not configured. Example: "K:\\\\repos\\\\Contoso\\\\MyProject\\\\MyProject.rnrproj"',
            },
          },
          required: [],
        },
      },
      {
        name: 'verify_d365fo_project',
        description: `Verify that D365FO objects exist on disk at the correct AOT path and are referenced in the Visual Studio project (.rnrproj) file.

Use this INSTEAD OF PowerShell to check whether create_d365fo_file placed files correctly.
Reports ✅/❌ for each object on both disk presence and project inclusion.

Examples:
  { objects: [{ objectType: "table", objectName: "MyTable" }, { objectType: "class", objectName: "MyClass" }], projectPath: "K:\\\\AosService\\\\PackagesLocalDirectory\\\\MyPkg\\\\MyModel\\\\MyModel.rnrproj" }
  { objects: [{ objectType: "menu-item-action", objectName: "MyMenuItem" }], modelName: "MyModel" }`,
        inputSchema: {
          type: 'object',
          properties: {
            objects: {
              type: 'array',
              description: 'List of objects to verify',
              items: {
                type: 'object',
                properties: {
                  objectType: {
                    type: 'string',
                    enum: ['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
                      'edt', 'edt-extension', 'table-extension', 'form-extension', 'data-entity-extension',
                      'enum-extension', 'menu-item-display', 'menu-item-action', 'menu-item-output',
                      'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
                      'menu', 'menu-extension', 'security-privilege', 'security-duty', 'security-role'],
                    description: 'Type of D365FO object',
                  },
                  objectName: { type: 'string', description: 'Name of the object' },
                },
                required: ['objectType', 'objectName'],
              },
            },
            projectPath: {
              type: 'string',
              description: 'Absolute path to the .rnrproj file. Required for project-reference check.',
            },
            modelName: {
              type: 'string',
              description: 'Model name. Auto-detected from mcp.json if omitted.',
            },
            packageName: { type: 'string', description: 'Package name. Auto-resolved from model name if omitted.' },
            packagePath: { type: 'string', description: 'Base package path (default: K:\\AosService\\PackagesLocalDirectory)' },
          },
          required: ['objects'],
        },
      },
      // ── SDLC & Build Tools ────────────────────────────────────────────────────
      {
        name: 'update_symbol_index',
        description: 'Index a newly generated or modified D365FO XML file immediately so references to it work without restarting the server. Call this after create_d365fo_file to make the new object instantly searchable.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute path to the modified or created XML file (e.g. K:\\\\AosService\\\\PackagesLocalDirectory\\\\MyModel\\\\MyModel\\\\AxClass\\\\MyClass.xml)' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'build_d365fo_project',
        description: 'Run MSBuild compilation on a D365FO Visual Studio project (.rnrproj) to capture X++ compiler errors without opening Visual Studio. Returns build output including errors and warnings.',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .rnrproj file (e.g. K:\\\\repos\\\\MySolution\\\\MyProject\\\\MyProject.rnrproj). Auto-detected from .mcp.json if omitted.' },
          },
          required: [],
        },
      },
      {
        name: 'trigger_db_sync',
        description: 'Run a D365FO database sync (SyncEngine.exe). ' +
          'Supports partial sync of specific tables — much faster than full-model sync. ' +
          'Use partial sync after adding/renaming fields or indexes on known tables. ' +
          'Use full sync after creating new tables or when unsure what changed.',
        inputSchema: {
          type: 'object',
          properties: {
            modelName: { type: 'string', description: 'Model to sync. Auto-detected from .mcp.json if omitted.' },
            tables: {
              type: 'array',
              items: { type: 'string' },
              description: 'Partial sync: sync only these tables (faster). Example: ["CustTable", "MyNewTable"]. Omit for full-model sync.',
            },
            tableName: { type: 'string', description: 'Single-table shorthand — equivalent to tables=["tableName"]. Kept for backwards compatibility.' },
            syncViews: { type: 'boolean', description: 'Also sync views and data entities. Required after creating/modifying data entities. Default: false.' },
            connectionString: { type: 'string', description: 'SQL Server connection string. Default: "Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True".' },
            packagePath: { type: 'string', description: 'PackagesLocalDirectory root. Auto-detected from .mcp.json if omitted.' },
          },
          required: [],
        },
      },
      {
        name: 'run_bp_check',
        description: 'Run Microsoft Best Practices checker (xppbp.exe) on a D365FO project. Returns BP warnings and errors with rule codes (e.g. BPErrorLabelIsText, BPXmlDocNoDocumentationComments).',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute path to the .rnrproj file to analyze. Auto-detected from .mcp.json if omitted.' },
            targetFilter: { type: 'string', description: 'Optional: filter results to a specific class, table, or object name' },
            modelName: { type: 'string', description: 'Model name to check. Auto-detected from .mcp.json if omitted.' },
            packagePath: { type: 'string', description: 'PackagesLocalDirectory root path. Auto-detected from .mcp.json if omitted.' },
          },
          required: [],
        },
      },
      {
        name: 'run_systest_class',
        description: 'Execute a D365FO unit test class using SysTestRunner.exe or xppbp.exe. Returns pass/fail results for each test method.',
        inputSchema: {
          type: 'object',
          properties: {
            className: { type: 'string', description: 'The name of the SysTest class to run (e.g. "MyModuleTest")' },
            modelName: { type: 'string', description: 'The model containing the test class. Auto-detected from .mcp.json if omitted.' },
            packagePath: { type: 'string', description: 'PackagesLocalDirectory root path. Auto-detected from .mcp.json if omitted.' },
            testMethod: { type: 'string', description: 'Optional: run only this specific test method within the class (e.g. "testValidation").' },
          },
          required: ['className'],
        },
      },
      // ── Code Review & Source Control ─────────────────────────────────────────
      {
        name: 'review_workspace_changes',
        description: 'Analyze uncommitted X++ changes in a local git repository (git diff HEAD) and perform an AI-based D365FO code review. Checks for BP violations, missing labels, CoC patterns, and other best practices.\n\n⚠️ Local companion tool: available only in write-only/local mode (Windows VM).\n\n⚠️ This tool is for CODE REVIEW ONLY — NOT for verifying that a modify_d365fo_file or create_d365fo_file call succeeded. For post-edit verification use verify_d365fo_project (disk + .rnrproj) and get_class_info / get_method_source after update_symbol_index.\n\n⚠️ The diff output may be large. If it appears truncated, do NOT use built-in file-reading tools (read_file, grep_search, get_file) to supplement it — those tools are forbidden on .xml/.xpp files. Instead, accept the visible portion and proceed or ask the user to narrow the scope.',
        inputSchema: {
          type: 'object',
          properties: {
            directoryPath: { type: 'string', description: 'Absolute path to the local git repository root (e.g. K:\\\\repos\\\\MySolution)' },
          },
          required: ['directoryPath'],
        },
      },
      {
        name: 'undo_last_modification',
        description: 'Safely revert the last change to a specific file. If the file is tracked by git, runs git checkout HEAD to restore it. If the file is untracked (newly created), deletes it. Use this to safely roll back incorrectly generated code.\n\n⚠️ Local companion tool: available only in write-only/local mode (Windows VM).',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute path to the file to revert or delete' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_d365fo_error_help',
        description:
          'Diagnose D365FO / X++ compiler and runtime errors. ' +
          'Provide an error message or error code and receive a structured explanation, ' +
          'root-cause analysis, step-by-step fix instructions, and an X++ code example. ' +
          'Covers: TTS level mismatch, UpdateConflict (OCC), CSUV1 illegal assignment, ' +
          'SYS10028 missing next call, overlayering not allowed, BPUpgradeCodeToday (today() deprecated), ' +
          'forupdate missing, record not found, number sequence not configured, and more.',
        inputSchema: {
          type: 'object',
          properties: {
            errorText: {
              type: 'string',
              description: 'Full error message text as displayed in the X++ compiler or event log',
            },
            errorCode: {
              type: 'string',
              description: 'Optional error code (e.g. SYS10028, CSUV1, BPUpgradeCodeToday)',
            },
          },
          required: ['errorText'],
        },
      },
      {
        name: 'get_xpp_knowledge',
        description:
          'Queryable knowledge base of D365FO X++ patterns, best practices, and AX2012→D365FO migration guidance. ' +
          'Returns distilled, verified patterns with code examples. Use BEFORE generating code to avoid deprecated ' +
          'APIs and AX2012 anti-patterns. Topics: batch jobs, transactions, queries, CoC/extensions, security, ' +
          'data entities, temp tables, number sequences, form patterns, set-based operations, error handling, ' +
          'SysOperation framework, and more.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description:
                'Topic to query — e.g. "batch job", "ttsbegin", "RunBase vs SysOperation", ' +
                '"set-based operations", "CoC", "data entities", "number sequences", "security", ' +
                '"temp tables", "today() deprecated", "query patterns", "form patterns"',
            },
            format: {
              type: 'string',
              enum: ['concise', 'detailed'],
              default: 'concise',
              description: 'concise = quick reference (default), detailed = full explanation with code examples',
            },
          },
          required: ['topic'],
        },
      },
    ],
    };

    // Apply server mode filter
    if (SERVER_MODE === 'read-only') {
      allTools.tools = allTools.tools.filter(t => !LOCAL_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for read-only mode: ${allTools.tools.length} tools (local tools excluded)`);
    } else if (SERVER_MODE === 'write-only') {
      allTools.tools = allTools.tools.filter(t => LOCAL_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for write-only mode: ${allTools.tools.length} tools (${Array.from(LOCAL_TOOLS).join(', ')})`);
    } else {
      console.error(`[MCP Server] Tool list in full mode: ${allTools.tools.length} tools (no filtering)`);
    }

    return allTools;
  });

  return server;
}
