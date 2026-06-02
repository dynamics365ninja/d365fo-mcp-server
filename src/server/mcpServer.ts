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
 * Convert a file:// URI to a local path.
 * Duplicated from transport.ts to keep mcpServer.ts self-contained
 * (no circular dep between transport ↔ mcpServer).
 * Handles both Windows (drive-letter) and POSIX (Linux/macOS, Azure) paths.
 */
function fileUriToPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('file:///')) {
    const decoded = decodeURIComponent(uri.slice('file:///'.length));
    if (process.platform === 'win32') {
      return decoded.replace(/\//g, '\\');
    }
    // POSIX: restore the leading slash stripped by slice('file:///'.length)
    return '/' + decoded;
  }
  if (uri.startsWith('file://')) {
    const decoded = decodeURIComponent(uri.slice('file://'.length));
    return process.platform === 'win32' ? decoded.replace(/\//g, '\\') : decoded;
  }
  // Already a local path — Windows drive letter, UNC share, or POSIX absolute
  if (uri.length > 2 && (uri[1] === ':' || uri.startsWith('\\\\') || uri.startsWith('/'))) return uri;
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
    // Instanced mode: .mcp.json / env vars already provide both model name and
    // workspace path — the workspace is fully known and immutable per instance.
    // Skipping the call avoids a -32001 timeout when mcp-remote is the transport
    // (hard-coded 60 s timeout, server-initiated requests cannot complete over HTTP).
    if (await getConfigManager().isStaticallyConfigured()) {
      process.stderr.write(`[mcpServer] ℹ️  Static config complete — skipping roots/list (instanced mode)\n`);
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
    // Instanced mode: workspace is immutable per server instance — the
    // notification is irrelevant and the request would time out over mcp-remote.
    if (await getConfigManager().isStaticallyConfigured()) {
      process.stderr.write(`[mcpServer] ℹ️  Static config complete — skipping roots/list on change (instanced mode)\n`);
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
          description: 'Search pre-indexed D365FO objects by name or keywords. Returns name, type, model. Use batch_search for multiple queries. Use get_class_info/get_table_info when you already know the exact name and need full details.',
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
              workspacePath: {
                type: 'string',
                description: 'Optional workspace path to search local project files in addition to external metadata',
              },
              includeWorkspace: {
                type: 'boolean',
                default: false,
                description: 'Whether to include workspace files in search results (workspace-aware search)',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'batch_search',
          description: 'Execute multiple symbol searches in parallel (max 10). 3x faster than sequential search calls. Supports deduplication and cross-referencing across results.',
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
              crossReference: {
                type: 'boolean',
                default: true,
                description:
                  'Append a cross-reference summary at the end listing symbols that appeared in multiple queries. ' +
                  'Useful for identifying the most relevant / commonly matched objects across all searches.',
              },
            },
            required: ['queries'],
          },
        },
        {
          name: 'search_extensions',
          description: 'Search only custom/ISV objects, filtering out Microsoft standard code. Model names in results are SOURCE models — never use them as target for create/modify operations.',
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
          description: 'Get class definition: methods (signatures or full source), inheritance, attributes. Default compact=true returns signatures only. Use get_method_source for specific method bodies. Use code_completion for name-only listing.',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the X++ class' },
              includeWorkspace: { type: 'boolean', default: false, description: 'Whether to search in workspace first' },
              workspacePath: { type: 'string', description: 'Workspace path to search for class' },
              methodOffset: { type: 'number', default: 0, description: 'Offset for paginating methods (use multiples of 15)' },
              compact: { type: 'boolean', default: true, description: 'Signatures only, no source bodies (default true). Set false only when you need to read method bodies' },
            },
            required: ['className'],
          },
        },
        {
          name: 'get_table_info',
          description: 'Get complete table schema: fields (with EDT info), indexes, relations, methods, and properties. Primary tool for any table-related query. Do NOT use code_completion for tables.',
          inputSchema: {
            type: 'object',
            properties: {
              tableName: { type: 'string', description: 'Name of the X++ table' },
              methodOffset: { type: 'number', default: 0, description: 'Offset for paginating methods (use multiples of 25)' },
            },
            required: ['tableName'],
          },
        },
        {
          name: 'code_completion',
          description: 'IntelliSense-like member name completions for CLASSES only. Returns method/field names with basic signatures. Faster than get_class_info when you only need names. For tables, use get_table_info instead.',
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
          description: 'Generate X++ code from patterns. Call analyze_code_patterns first, then generate_code, then create_d365fo_file. Patterns: batch-job, sysoperation, class, runnable, event-handler, table-extension, class-extension, form-handler, form-datasource-extension, form-control-extension, security-privilege, menu-item, ssrs-report-full, lookup-form, dialog-box, dimension-controller, number-seq-handler, data-entity, data-entity-staging, service-class-ais, business-event, custom-telemetry, feature-class, composite-entity, custom-service, er-custom-function, map-extension, display-menu-controller.',
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
          description: 'Analyze the codebase to find common classes, methods, and dependencies for a scenario. Call BEFORE generate_code to learn from existing real patterns.',
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
          description: 'Find real implementation examples of similar methods in the codebase. Shows how others implemented the same/similar method with actual code.',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Name of the class containing the method' },
              methodName: { type: 'string', description: 'Name of the method to implement' },
              parameters: {
                type: 'array',
                description: 'Method parameters',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              returnType: { type: 'string', default: 'void', description: 'Method return type' },
            },
            required: ['className', 'methodName'],
          },
        },
        {
          name: 'analyze_class_completeness',
          description: 'Analyze a class and suggest missing methods by comparing with similar classes in the codebase. Identifies gaps like missing find(), exist(), validate() methods.',
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
          description: 'Show how a specific API/class is actually used in the codebase: initialization sequences, method call patterns, and common parameters.',
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
          description: `Create D365FO AOT object file (.xml) in the correct PackagesLocalDirectory location with proper XML structure and UTF-8 BOM. Auto-adds to VS project (.rnrproj).

⚠️ THIS IS THE WRITE/COMPLETION STEP. Analysis tools (analyze_code_patterns, search, get_class_info/get_table_info, generate_code/generate_smart_*) only PREPARE the design — they do NOT create anything on disk. Once the design is known, you MUST CALL create_d365fo_file to actually write the file. Do NOT stop after analysis or after presenting generated code: the task is incomplete until this tool has run and returned success (isError=false).

On error this tool returns isError=true with a message (e.g. file already exists, Microsoft model blocked). Read it and fix/retry — never treat a ⚠️/❌ response as success.

Object types: class, table, enum, form, query, view, data-entity, report, edt, security-privilege, security-duty, security-role, menu-item-display/action/output, menu, table/class/form/enum/edt/data-entity-extension, menu-item-*-extension, menu-extension, business-event, tile, kpi.

For extensions: objectName="BaseObject.PrefixExtension" (e.g. "CustTable.ContosoExtension").
Model name auto-detected from .mcp.json. Object name prefix auto-applied from EXTENSION_PREFIX.

SourceCode format for classes: class declaration with member vars inside { }, methods after closing }.`,
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
                description: 'Actual model name (e.g., "ContosoExt", "ApplicationSuite") — determines object naming prefix. Auto-detected from .mcp.json if omitted. ALWAYS read from get_workspace_info() when calling explicitly. NEVER guess or use placeholders like "MyModel". DO NOT use model names from search results — those are source models of existing objects, not your target model.'
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
                  '• enum:            label, useEnumValue, configurationKey, isExtensible, enumValues[{name,value?,label?,helpText?}]\n' +
                  '• enum-extension:  enumValues[{name,label?,value?,countryRegionCodes?}]\n' +
                  '• table-extension: fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — fieldType defaults to AxTableFieldString; use AxTableFieldEnum for enum-based fields (also set enumType)\n' +
                  '• edt:             label, extends, edtType, stringSize\n' +
                  '• form:            caption, formTemplate, dataSource\n' +
                  '• security-privilege: label, targetObject (menu item ObjectName), objectType (MenuItemDisplay|MenuItemAction|MenuItemOutput, default: MenuItemDisplay), accessLevel (view=Read only | maintain=Read+Update+Create+Delete, default: view)\n' +
                  '• menu-item-*:     label, object, objectType\n' +
                  'Example enum: properties={"label":"@ContosoExt:Status","enumValues":[{"name":"Open","label":"@ContosoExt:Open"},{"name":"Closed","label":"@ContosoExt:Closed"}]}\n' +
                  'Example enum-extension: properties={"enumValues":[{"name":"MyValue","label":"@MyModel:MyValue","countryRegionCodes":"CZ"}]}\n' +
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
            required: ['objectType', 'objectName'],
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
- enum: label, useEnumValue, configurationKey, isExtensible, enumValues[{name,value?,label?,helpText?}]
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
          description: 'Find all references (where-used) to a class, method, field, table, or enum across the entire codebase. Essential for impact analysis before refactoring.',
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
          description: '⚠️ WINDOWS ONLY: Safely modifies an existing D365FO XML file (class, table, enum, form, query, view). Supports adding/removing/modifying methods and fields, modifying properties. Validates XML after modification. IMPORTANT: This tool MUST run locally on Windows D365FO VM - it CANNOT work through Azure HTTP proxy (Linux).\n\n⚠️ APPLIES IMMEDIATELY — there is NO dry-run/preview mode. The moment this tool is called it writes the change to disk via IMetadataProvider.Update(). Therefore: BEFORE calling, describe the exact change you intend to make in chat and let the user confirm; only then call this tool to apply it. To revert, use undo_last_modification (git checkout), or pass createBackup=true to also keep a .bak copy. On success the response reports the applied operation. On error the response has isError=true with a message — read it and fix/retry; never treat a ⚠️/❌ response as success.',
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
                  'add-method: add a new method (or CoC method) to a class/table/form, or update an existing method in place when the same name already exists so its position is preserved.\n' +
                  'remove-method: remove a method by name.\n' +
                  'replace-code: surgical in-place replacement — pass oldCode (exact snippet to find) + newCode (replacement text). This is also the preferred way to replace an entire existing method when you already know the old source. ' +
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
          description: 'Get exact method signature (modifiers, return type, parameters, attributes). REQUIRED before creating CoC extensions — incorrect signatures cause compilation errors.',
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
          description: 'Get the full X++ source code of a specific method. Only call for methods confirmed to exist via get_class_info — never guess method names.',
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
          description: 'Get form structure: datasources, control hierarchy, methods, properties. Use searchControl parameter for fast control name lookup (e.g. searchControl="General" to find tab names). Retry with filePath if disk-read warning occurs.',
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
          description: 'Get query structure: datasources, joins, ranges, field lists, sorting. Essential for understanding queries used by forms, reports, and data entities.',
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
          description: 'Get view or data entity structure: mapped fields, data sources, computed columns, relations, OData/DMF configuration. Use get_data_entity_info for OData-specific metadata.',
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
          description: 'Get enum definition: all values with names, integer values, and labels. Use for understanding available options before writing code or extending enums.',
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
          description: 'Get EDT definition: base type, extends, reference table, labels, string size. EDT names are globally unique — omit modelName if lookup fails. Use mode="hierarchy" for ancestor chain and field usages.',
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
          description: 'Read AxReport XML: datasets, fields, designs, RDL summary. Use includeRdl=true for full RDL content. Use instead of PowerShell when studying existing SSRS reports.',
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
          description: 'Full-text search across indexed D365FO label files. Search by text, label ID, or comment. Returns label IDs, translations, and @LabelFileId:LabelId reference syntax. ALWAYS search before create_label.',
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
          description: 'Get all language translations for a label ID, or list available label files in a model. Returns translations, developer comment, and @LabelFileId:LabelId reference syntax.',
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
          description: 'Add a new label to an existing AxLabelFile. Writes into every language .label.txt, creates XML descriptors if missing, updates SQLite index. ALWAYS call search_labels first. Label IDs describe meaning — never add model prefix.',
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
              sortLabels: {
                type: 'boolean',
                description:
                  'Sort labels alphabetically when writing .label.txt files (default: true). ' +
                  'Set to false to append new labels at the end preserving existing file order. ' +
                  'Defaults to LABEL_SORT_ORDER env var ("alphabetical" = true, "append" = false).',
              },
            },
            required: ['labelId', 'labelFileId', 'model', 'translations'],
          },
        },
        {
          name: 'rename_label',
          description: `Rename a D365FO label ID across all .label.txt files, X++ sources, and XML metadata in the model. Also updates the SQLite label index. Use dryRun=true first to preview impact.`,
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
          description: 'Analyze common field types, index patterns, and relation structures for D365FO tables. Filter by tableGroup (Main, Transaction, etc.) or find tables similar to a given table.',
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
          description: 'Analyze common datasource configurations, control hierarchies, and D365FO form patterns. Filter by formPattern, dataSource table name, or similarTo form.',
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
          description: 'Suggest Extended Data Types (EDT) for a field name using fuzzy matching. Returns confidence-ranked suggestions with EDT properties. Use BEFORE creating table fields to reuse existing EDTs.',
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
          description: 'AI-driven table generation with intelligent field/index/relation suggestions from pattern analysis. Strategies: copyFrom existing table, tableGroup + generateCommonFields, or fieldsHint with auto-suggested EDTs. Returns complete XML for create_d365fo_file.',
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
          description: 'AI-driven form generation with intelligent datasource/control suggestions from pattern analysis. Strategies: copyFrom existing form, dataSource + generateControls, or formPattern application. Returns complete XML for create_d365fo_file.',
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
          description: `AI-driven SSRS report generation — creates up to 5 objects (TmpTable, Contract, DP, Controller, AxReport+RDL) in one call. Use fieldsHint or fields for field specs, contractParams for dialog parameters. Never add model prefix to name — auto-applied. On Azure/Linux: call create_d365fo_file for each returned object. On Windows: files are written directly.`,
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
        description: 'Get detailed info for a D365FO security privilege, duty, or role. Walks full hierarchy: Role → Duties → Privileges → Entry Points.',
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
        description: 'Get details for a D365FO menu item including target object and full security chain (privilege → duty → role).',
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
        description: 'Find all Chain of Command (CoC) extensions and event handler subscriptions for a D365FO class or table. Use before writing a CoC extension to check for conflicts.',
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
        description: 'Get all extensions for a D365FO table across all models and show the effective merged schema (base + extension fields/indexes/methods).',
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
        description: 'Get D365FO data entity metadata: OData settings, DMF configuration, staging table, data sources, and keys. Use instead of get_view_info for OData/DMF work.',
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
        description: 'Find all event handler subscriptions (SubscribesTo, delegate +=) for a D365FO class or table. Use before adding event handlers to check for duplicates.',
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
        description: 'Show what security privileges, duties, and roles cover a D365FO object. Traces reverse chain: object → menu items → privileges → duties → roles.',
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
        description: 'Analyze available extension points for a D365FO class, table, or form. Shows CoC-eligible methods, replaceable methods, delegates, blocked methods, and which points are already extended.',
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
        description: 'Recommends the best D365FO extensibility mechanism for a given scenario (CoC, event handler, business event, data entity, etc.). Prevents common design mistakes. Returns recommendation, reasoning, risks, alternatives, and next MCP tool calls.',
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
        description: 'Validate a proposed D365FO object name against naming conventions: extension naming, ISV prefix, type-specific suffixes, and conflict detection against the symbol index.',
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
        description: `ALWAYS call FIRST at session start. Returns model name, package path, framework directory, project path, environment type, and EXTENSION_PREFIX. Flags placeholder model names and missing prefix. Use projectName/projectPath params for solution switching. This is the authoritative source for target model — not search results.`,
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
        description: 'Verify that D365FO objects exist on disk at the correct AOT path and are referenced in the .rnrproj project file. Use instead of PowerShell to check create_d365fo_file results.',
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
        description:
          'Builds a D365FO model using the X++ compiler (xppc.exe). ' +
          'Compiles the ENTIRE MODEL — not just one project file. ' +
          'Runs in the background: first call starts the build; call again to poll status and see output. ' +
          'Use fullBuild:true when xppc reports "model element has not been successfully compiled since it was last changed" (stale symbol error). ' +
          'Use buildReferencedModels:true to also build custom/ISV dependencies first (reads <ModuleReferences> from the model descriptor; skips Microsoft standard models; topological order).',
        inputSchema: {
          type: 'object',
          properties: {
            modelName: {
              type: 'string',
              description: 'D365FO model name to build (e.g. MyCustomModel). Auto-detected from workspace if omitted.',
            },
            projectPath: {
              type: 'string',
              description: '(Legacy) Absolute path to a .rnrproj file — used only to extract the model name when modelName is not provided.',
            },
            force: {
              type: 'boolean',
              description: 'Kill any running build processes for this model and restart.',
            },
            fullBuild: {
              type: 'boolean',
              description: 'Full recompile of the TARGET model only (deps stay incremental). Use when xppc reports stale symbol errors.',
            },
            buildReferencedModels: {
              type: 'boolean',
              description: 'Also build all custom/ISV models this model depends on before building the target. Skips Microsoft standard models.',
            },
          },
          required: [],
        },
      },
      {
        name: 'trigger_db_sync',
        description: 'Run a D365FO database sync (SyncEngine.exe). ' +
          'Supports partial sync of specific tables — much faster than full-model sync. ' +
          'Use partial sync after adding/renaming fields or indexes on known tables. ' +
          'Pass projectPath to auto-extract tables from .rnrproj for smart partial sync. ' +
          'Use full sync only when unsure what changed.',
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
            projectPath: { type: 'string', description: 'Path to .rnrproj file. Auto-extracts table/view names for partial sync. Auto-detected from .mcp.json when no explicit tables given.' },
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
            targetFilter: { type: 'string', description: 'Optional: filter results to a specific object name (class, table, form, enum, ...).' },
            targetElementType: { type: 'string', description: 'Element type for the filter when using xppbp 10.0.24+ (equals-style CLI). Common values: class, table, form, enum, view, query. Defaults to "class" when targetFilter is set but this is omitted.' },
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
