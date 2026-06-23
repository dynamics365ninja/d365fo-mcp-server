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
import { registerResources } from '../resources/index.js';
import { registerCodeReviewPrompt } from '../prompts/codeReview.js';
import type { XppServerContext } from '../types/context.js';
import { SERVER_MODE, LOCAL_TOOLS, ALWAYS_TOOLS } from './serverMode.js';
import { TOOL_ANNOTATIONS } from './toolAnnotations.js';
import { getConfigManager } from '../utils/configManager.js';

const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';
import { setLastRoots, recordRootsListChanged } from '../utils/stdioSessionInfo.js';
import { OBJECT_INFO_TYPES, BATCH_INFO_TYPES } from '../tools/objectInfoRegistry.js';

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
    // Keep the current detection result — the next roots/list_changed will update it.
    if (DEBUG_LOGGING) {
      process.stderr.write('[mcpServer] roots/list received (0 root(s)) — solution closing or no workspace open\n');
    }
    setLastRoots([]);
    return;
  }

  // Log all received roots for diagnostics
  if (DEBUG_LOGGING) {
    process.stderr.write(`[mcpServer] roots/list received (${roots.length} root(s)):\n`);
    roots.forEach((r, i) => process.stderr.write(`  [${i}] ${r.uri}\n`));
  }

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
    if (DEBUG_LOGGING) {
      const { modelName, source, projectPath, solutionPath, workspacePath } =
        getConfigManager().getDetectionSummary();
      process.stderr.write(
        `[mcpServer] ✅ Project detection result:\n` +
        `   Model name  : ${modelName ?? '(unknown)'} (source: ${source})\n` +
        `   Project path: ${projectPath  ?? '(not set)'}\n` +
        `   Solution    : ${solutionPath ?? '(not set)'}\n` +
        `   Workspace   : ${workspacePath ?? '(not set)'}\n`
      );
    }
  }).catch(err => {
    process.stderr.write(`[mcpServer] ⚠️ setRuntimeContextFromRoots error: ${err}\n`);
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
    if (DEBUG_LOGGING) {
      process.stderr.write(
        `[mcpServer ${new Date().toISOString().slice(11, 23)}] ⚡ 'initialized' notification received — requesting roots/list\n`
      );
    }
    // Only stdio clients (VS Code, VS 2022) advertise the roots capability.
    // HTTP / Azure clients do not — skipping the call avoids a -32001 timeout
    // that would otherwise be logged as a spurious warning in Azure Monitor.
    if (!server.getClientCapabilities()?.roots) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  Client has no roots capability — skipping roots/list\n`);
      }
      return;
    }
    // HTTP transports (Azure App Service, MCP_FORCE_HTTP) are request-response only —
    // the server cannot initiate requests back to the client. Even if the client
    // declares `roots` capability, calling roots/list would always time out (-32001).
    const isHttpMode = !!process.env.WEBSITES_PORT || process.env.MCP_FORCE_HTTP === 'true';
    if (isHttpMode) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  HTTP mode — skipping roots/list (transport is request-response only)\n`);
      }
      return;
    }
    // Instanced mode
    if (await getConfigManager().isStaticallyConfigured()) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  Static config complete — skipping roots/list (instanced mode)\n`);
      }
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
    if (DEBUG_LOGGING) {
      process.stderr.write(
        `[mcpServer ${new Date().toISOString().slice(11, 23)}] 🔄 'roots/list_changed' notification — re-requesting roots/list\n`
      );
    }
    const isHttpMode = !!process.env.WEBSITES_PORT || process.env.MCP_FORCE_HTTP === 'true';
    if (!server.getClientCapabilities()?.roots || isHttpMode) {
      return;
    }
    // Instanced mode: workspace is immutable per server instance — the
    // notification is irrelevant and the request would time out over mcp-remote.
    if (await getConfigManager().isStaticallyConfigured()) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  Static config complete — skipping roots/list on change (instanced mode)\n`);
      }
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

  // Register resources (single dispatcher — class + workspace schemes)
  registerResources(server, context);

  // Register prompts (includes system instructions)
  registerCodeReviewPrompt(server, context);

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = {
      tools: [
        {
          name: 'search',
          description:
            'Search pre-indexed D365FO objects by name or keyword. Three modes in ONE tool:\n' +
            '• single (default) → pass `query`; returns name, type, model.\n' +
            '• batch → pass `queries[]` (max 10) to run searches in parallel (3× faster, with dedup + cross-reference).\n' +
            '• extensions → set `scope:"extensions"` to restrict to custom/ISV models only (filters out Microsoft standard code). Model names in those results are SOURCE models — never use them as create/modify targets.\n' +
            'Use get_object_info(objectType, name) when you already know the exact name and need full details.',
          inputSchema: {
            type: 'object',
            properties: {
              scope: {
                type: 'string',
                enum: ['all', 'extensions'],
                default: 'all',
                description: '[single] Search the whole index ("all", default) or only custom/ISV models ("extensions"). Ignored when `queries[]` is provided.',
              },
              query: { type: 'string', description: '[single|extensions] Search query (class name, method name, table name, etc.). REQUIRED unless using batch `queries[]`.' },
              type: {
                type: 'string',
                enum: ['class', 'table', 'field', 'method', 'enum', 'edt', 'form', 'query', 'view', 'report',
                  'security-privilege', 'security-duty', 'security-role',
                  'menu-item-display', 'menu-item-action', 'menu-item-output',
                  'table-extension', 'class-extension', 'form-extension',
                  'enum-extension', 'edt-extension', 'data-entity-extension',
                  'all'],
                description: '[single] Filter by object type (class=AxClass, table=AxTable, enum=AxEnum, edt=AxEdt, form=AxForm, query=AxQuery, view=AxView, report=AxReport, security-privilege/duty/role=security objects, menu-item-display/action/output=menu items, table/class/form/enum/edt-extension=extensions, data-entity-extension=DE extensions, all=no filter)',
                default: 'all'
              },
              prefix: { type: 'string', description: '[extensions] Extension prefix filter (e.g., ISV_, Custom_).' },
              limit: { type: 'number', description: '[single|extensions] Maximum results to return', default: 20 },
              workspacePath: {
                type: 'string',
                description: '[single] Optional workspace path to search local project files in addition to external metadata',
              },
              includeWorkspace: {
                type: 'boolean',
                default: false,
                description: '[single] Whether to include workspace files in search results (workspace-aware search)',
              },
              queries: {
                type: 'array',
                description: '[batch] Array of search queries to execute in parallel (max 10). When provided, runs in batch mode and `scope`/`query` are ignored.',
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
                  '[batch] Default type filter for queries without an explicit per-query type. ' +
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
                  '[batch] When true, symbols appearing in multiple query results are collapsed. ' +
                  'Later occurrences are replaced with a reference to the query where they first appeared.',
              },
              crossReference: {
                type: 'boolean',
                default: true,
                description:
                  '[batch] Append a cross-reference summary at the end listing symbols that appeared in multiple queries. ' +
                  'Useful for identifying the most relevant / commonly matched objects across all searches.',
              },
            },
          },
        },
        {
          name: 'batch_get_info',
          description: 'Get detailed metadata for multiple D365FO objects in ONE call — the batch counterpart of get_object_info. All lookups run in parallel. Use when you already know 2+ exact object names instead of calling get_object_info one by one.',
          inputSchema: {
            type: 'object',
            properties: {
              objects: {
                type: 'array',
                minItems: 1,
                maxItems: 10,
                description: 'Objects to fetch in parallel (max 10)',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Exact object name (use search first if unsure)' },
                    type: {
                      type: 'string',
                      enum: [...BATCH_INFO_TYPES],
                      description: 'Object type — selects the underlying get_*_info tool',
                    },
                  },
                  required: ['name', 'type'],
                },
              },
            },
            required: ['objects'],
          },
        },
        {
          name: 'generate_object',
          description:
            'Generate X++/AOT code. Choose a `mode`:\n' +
            '• pattern → a named X++ skeleton from the pattern enum (text only, no write). Call analyze_code(mode="patterns") first, then generate_object(mode="pattern"), then d365fo_file(action="create").\n' +
            '• scaffold → pattern-aware whole-object generation (table/form/report) with intelligent field/index/relation or form-pattern suggestions; set objectType.\n' +
            'For a single existing object definition\'s XML use d365fo_file(action="generate") instead.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['pattern', 'scaffold'],
                description: 'pattern = named X++ skeleton (text); scaffold = whole table/form/report (set objectType).',
              },
              // ── shared identity / placement ────────────────────────────────
              name: { type: 'string', description: 'REQUIRED. [pattern] name for the generated element (extensions: base element name; form-datasource/control-extension: the FORM name). [scaffold] object name (report: BASE name WITHOUT model prefix).' },
              modelName: { type: 'string', description: 'Actual model name from .mcp.json (auto-detected if omitted). NEVER use generic placeholders like "MyModel".' },
              projectPath: { type: 'string', description: '[scaffold] Path to .rnrproj file for model extraction.' },
              solutionPath: { type: 'string', description: '[scaffold] Path to solution directory (alternative to projectPath).' },
              // ── mode=pattern ───────────────────────────────────────────────
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
                description: '[pattern] REQUIRED. Pattern to generate. CoC skeletons: class-extension, table-extension, form-handler (form-level methods), ' +
                  'form-datasource-extension (name=FormName, baseName=DataSourceName), form-control-extension (name=FormName, baseName=ControlName), map-extension. ' +
                  'Other: ssrs-report-full (Contract+DP+Controller), lookup-form, dialog-box, dimension-controller, ' +
                  'number-seq-handler, display-menu-controller, data-entity-staging, service-class-ais (CRUD service + contract).',
              },
              menuItemType: {
                type: 'string',
                enum: ['display', 'action', 'output'],
                description: '[pattern] For menu-item pattern: type of menu item (display=form, action=class, output=report)',
              },
              baseName: {
                type: 'string',
                description: '[pattern] For event-handler: base class or table name. ' +
                  'For form-datasource-extension: data source name within the form (defaults to form name if omitted). ' +
                  'For form-control-extension: exact control name — use get_object_info(objectType="form", name=...) to find the correct name.',
              },
              targetObject: {
                type: 'string',
                description: '[pattern] For menu-item and security-privilege patterns: target form/class/report name',
              },
              serviceMethod: {
                type: 'string',
                description: '[pattern] For sysoperation pattern: name of the method on the Service class the Controller will call. ' +
                  'Defaults to "process" when omitted. Example: serviceMethod="processOrders".',
              },
              // ── mode=scaffold ──────────────────────────────────────────────
              objectType: {
                type: 'string',
                enum: ['table', 'form', 'report'],
                description: '[scaffold] REQUIRED. Kind of object to generate.',
              },
              label: { type: 'string', description: '[scaffold:table|form] Optional label for the generated object.' },
              caption: { type: 'string', description: '[scaffold:form|report] Optional caption/title (form: window title; report: human-readable report title).' },
              packagePath: { type: 'string', description: '[scaffold:report] Base packages directory path.' },
              tableGroup: {
                type: 'string',
                description: '[scaffold:table] Business role (TableGroup enum): Main, Transaction, Parameter, Group, WorksheetHeader/WorksheetLine, Reference, Miscellaneous, Framework. ⛔ NEVER pass "TempDB"/"InMemory" here — that is tableType.',
              },
              tableType: {
                type: 'string',
                description: '[scaffold:table] Storage type: Regular (default, omit), TempDB, InMemory. ⛔ NEVER pass as tableGroup.',
              },
              generateCommonFields: { type: 'boolean', description: '[scaffold:table] Auto-generate common fields based on table group patterns.' },
              dataSource: { type: 'string', description: '[scaffold:form] Optional: Table name for primary datasource.' },
              formPattern: {
                type: 'string',
                description: '[scaffold:form] Optional: Form pattern (SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, DropDialog, TableOfContents, Lookup, ListPage, Workspace).',
              },
              cloneFrom: {
                type: 'string',
                description: '[scaffold:form] PREFERRED: clone a reference form\'s full XML (controls + patterns), re-bound via tableMapping. Methods except classDeclaration are stripped; fields missing on target tables are dropped and reported.',
              },
              tableMapping: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: '[scaffold:form] With cloneFrom: sourceTable → targetTable map, e.g. {"CustGroup": "MyRentalGroup"}.',
              },
              includeMethodStubs: { type: 'boolean', description: '[scaffold:form] Inject pattern-appropriate lifecycle method stubs with TODO markers.' },
              generateControls: { type: 'boolean', description: '[scaffold:form] Auto-generate grid controls for datasource.' },
              fields: {
                type: 'array',
                description: '[scaffold:report] Structured TmpTable field specs. Takes priority over fieldsHint.',
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
                description: '[scaffold:report] Dialog parameters for the Contract class.',
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
              generateController: { type: 'boolean', description: '[scaffold:report] Generate Controller class (default: true).' },
              designStyle: { type: 'string', description: '[scaffold:report] RDL design pattern: "SimpleList" (default) or "GroupedWithTotals".' },
              copyFrom: { type: 'string', description: '[scaffold:table|form|report] Copy structure from existing object (table fields/indexes/relations; form datasources — prefer cloneFrom; report field structure).' },
              fieldsHint: { type: 'string', description: '[scaffold:table|report] Comma-separated field names (e.g. "RecId, Name, Amount"). EDTs auto-suggested from the indexed metadata. ⚠️ Custom EDTs/enums created in the SAME SESSION are not yet indexed — call update_symbol_index first, then scaffold, so the new EDTs are found and used. Without this step those fields will default to String255.' },
            },
            required: ['mode'],
          },
        },
        {
          name: 'analyze_code',
          description:
            'Learn from the existing codebase. Choose a `mode`:\n' +
            '• patterns → common classes/methods/dependencies for a scenario (call BEFORE generate_object(mode="pattern")).\n' +
            '• implementations → real implementation examples of a similar method (actual code).\n' +
            '• completeness → missing standard methods on a class (find/exist/validate gaps).\n' +
            '• api-usage → how an API/class is initialized and called in practice.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['patterns', 'implementations', 'completeness', 'api-usage'],
                description: 'Which analysis to run.',
              },
              // ── mode=patterns ──────────────────────────────────────────────
              scenario: { type: 'string', description: '[patterns] REQUIRED. Scenario/functionality to analyze (e.g., "financial dimensions", "inventory transactions").' },
              classPattern: { type: 'string', description: '[patterns] Optional class name pattern to filter results (e.g., "Helper", "Service").' },
              // ── mode=implementations ───────────────────────────────────────
              methodName: { type: 'string', description: '[implementations] REQUIRED. Name of the method to implement.' },
              parameters: {
                type: 'array',
                description: '[implementations] Method parameters.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              returnType: { type: 'string', default: 'void', description: '[implementations] Method return type.' },
              // ── mode=implementations|completeness ──────────────────────────
              className: { type: 'string', description: '[implementations|completeness] REQUIRED. Class to analyze / containing the method.' },
              // ── mode=api-usage ─────────────────────────────────────────────
              apiName: { type: 'string', description: '[api-usage] REQUIRED. Name of the API/class to get usage patterns for.' },
              context: { type: 'string', description: '[api-usage] Optional context to filter patterns (e.g., "initialization", "validation").' },
              // ── shared ─────────────────────────────────────────────────────
              limit: { type: 'number', description: '[patterns] Maximum number of pattern examples to return', default: 5 },
            },
            required: ['mode'],
          },
        },
        {
          name: 'd365fo_file',
          description: `Create, modify, or generate a D365FO AOT object. Choose an \`action\`:
• create → write a NEW object file (.xml) into PackagesLocalDirectory (UTF-8 BOM, auto-added to .rnrproj). THIS IS THE WRITE STEP — the task is incomplete until it returns isError=false. Never treat a ⚠️/❌ response as success. Extensions: objectName="BaseObject.PrefixExtension". (Windows)
• modify → edit an EXISTING object via IMetadataProvider (methods, fields, indexes, relations, controls, enum values, properties). APPLIES IMMEDIATELY, no dry-run — describe the change and get user confirmation BEFORE calling. Revert with undo_last_modification. Requires \`operation\`. (Windows)
• generate → produce the XML as TEXT only, no file written (Azure/Linux fallback when create reports "requires file system access"). Save it yourself with UTF-8 BOM. ALWAYS try action=create first.

Model from .mcp.json; prefix auto-applied from EXTENSION_PREFIX. Classes: member vars inside the class { }, methods after the closing }.`,
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['create', 'modify', 'generate'],
                description: 'create = new object file (write); modify = edit existing object (write); generate = XML text only (no write).',
              },
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
                  'Type of D365FO object. Each security/menu-item type maps to its own AOT folder — ' +
                  'NEVER use security-privilege for a duty or role. ' +
                  'class-extension = [ExtensionOf] final class skeleton; business-event = BusinessEventsBase + Contract pair. ' +
                  '[modify] supported: class, table, form, enum, query, view, edt, data-entity, report and their *-extension variants. ' +
                  '[generate] supported: class, table, enum, form, query, view, data-entity, report and table/form/enum/edt/data-entity-extension.'
              },
              objectName: {
                type: 'string',
                description: 'Base name WITHOUT model prefix — the tool prepends it from EXTENSION_PREFIX (priority) or modelName, and detects an already-present prefix. Extension classes: pass "{Base}_Extension" with NO prefix infix (e.g. "SalesFormLetter_Extension" → tool produces "SalesFormLetterMY_Extension"). NEVER hand-build the prefix.'
              },
              modelName: {
                type: 'string',
                description: 'Target model name — auto-detected from .mcp.json if omitted. NEVER guess, use placeholders, or take model names from search results (those are source models).'
              },
              packageName: {
                type: 'string',
                description: 'Package name (e.g., CustomExtensions, ApplicationSuite). Auto-resolved from model name if omitted. Required when package name differs from model name.',
              },
              packagePath: {
                type: 'string',
                description: 'Base package path (default: K:\\AosService\\PackagesLocalDirectory). Also used by [modify] to locate objects whose metadata lives outside the default PackagesLocalDirectory (e.g. a repo checkout). Note: bridge-backed modify operations resolve objects via the C# bridge\'s startup roots — if the model is outside them, set context.customPackagesPath / D365FO_CUSTOM_PACKAGES_PATH instead, or pass an explicit filePath.'
              },
              sourceCode: {
                type: 'string',
                description: `X++ source code for the object.\n\nFOR CLASSES — the content is split into <Declaration> and <Methods> automatically:\n  • <Declaration> = class keyword line + ALL member variable declarations inside the outer { }\n  • <Methods>     = each method defined AFTER the closing } of the class header\n\nExample for a class with member variables and a method:\n  public class MyClass\n  {\n      int globalPackageNumber;\n      Qty totalExportedQty;\n  }\n  public void myMethod()\n  {\n      // body\n  }\n\nCRITICAL: member variables MUST be inside the class { } block — NOT after it.`
              },
              properties: {
                type: 'object',
                description:
                  'Additional properties by objectType:\n' +
                  '• class: extends, implements, isFinal, isAbstract\n' +
                  '• table: label, tableGroup, tableType, titleField1/2, fields[{name,type?|edt?|fieldType?,enumType?,label?,mandatory?}] — enum fields need enumType (+ optionally fieldType:"AxTableFieldEnum")\n' +
                  '• enum: label, useEnumValue, configurationKey, isExtensible, enumValues[{name,value?,label?,helpText?}]\n' +
                  '• enum-extension: enumValues[{name,label?,value?,countryRegionCodes?}]\n' +
                  '• table-extension: fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — enum fields need fieldType:"AxTableFieldEnum" + enumType\n' +
                  '• edt: label, extends, edtType, stringSize\n' +
                  '• form: caption, formTemplate, dataSource\n' +
                  '• security-privilege: label, targetObject, objectType (MenuItemDisplay|Action|Output), accessLevel (view|maintain)\n' +
                  '• security-duty: label, privileges[] (privilege names — array or comma-separated)\n' +
                  '• security-role: label, duties[] (duty names), privileges[] (privilege names)\n' +
                  '• menu-item-*: label, object, objectType\n' +
                  'Example: properties={"fields":[{"name":"ContosoStatus","enumType":"NoYes","fieldType":"AxTableFieldEnum","label":"@Contoso:Status"}]}'
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
                  'Also used in Azure/Linux setups: generate XML via generate_smart/form, then pass here.',
              },
              overwrite: {
                type: 'boolean',
                description:
                  'Allow overwriting an existing file (use with xmlContent to fully rewrite an object). ' +
                  'NEVER overwrite D365FO objects via PowerShell/create_file \u2014 always use overwrite=true here.',
                default: false,
              },
              groundingToken: {
                type: 'string',
                description:
                  'Provenance token from prepare(change/create). Required for *-extension objectTypes when ' +
                  'GROUNDING_ENFORCE=true; object-bound — only valid for the object it was issued for.',
              },
              // ── action=modify only ──────────────────────────────────────────
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
                  '[modify] REQUIRED. Modification to perform. Non-obvious ones:\n' +
                  'add-method: adds OR updates in place when the method name exists (position preserved).\n' +
                  'replace-code: surgical oldCode→newCode replacement; preferred for rewriting a known method. Form control overrides: methodName="ControlName.methodName".\n' +
                  'rename-field: also fixes index DataField refs and TitleField1/2.\n' +
                  'replace-all-fields: atomic rewrite of ALL fields (corrupted field names).\n' +
                  'add-display-method: display method with [SysClientCacheDataMethodAttribute].\n' +
                  'add-table-method: canonical find/exist/findByRecId/validateWrite/validateDelete/initValue boilerplate.\n' +
                  'add-field-modification: override base-table field label/mandatory in a table-extension.\n' +
                  'modify-property: any object-level property (TableGroup, TitleField1, TableType, Extends, …) — see propertyPath.'
              },
              methodName: {
                type: 'string',
                description: '[modify] Method name (required for add-method, remove-method)'
              },
              methodCode: {
                type: 'string',
                description:
                  '[modify:add-method] Full X++ method source: modifiers + return type + name + params + body + attributes ' +
                  '(alias of sourceCode). A bare body gets its signature assembled from methodModifiers/methodReturnType/methodName/methodParameters.'
              },
              methodModifiers: {
                type: 'string',
                description: '[modify] Method modifiers (e.g., "public static")'
              },
              methodReturnType: {
                type: 'string',
                description: '[modify] Return type of method (e.g., "void", "str", "boolean")'
              },
              methodParameters: {
                type: 'string',
                description: '[modify] Method parameters (e.g., "str _param1, int _param2")'
              },
              oldCode: {
                type: 'string',
                description:
                  '[modify:replace-code] REQUIRED. Exact existing snippet to find (whitespace-trimmed match). ' +
                  'With methodName the search is scoped to that method.'
              },
              newCode: {
                type: 'string',
                description:
                  '[modify:replace-code] REQUIRED. Replacement for the first occurrence of oldCode; "" deletes the snippet.'
              },
              fieldName: {
                type: 'string',
                description: '[modify] Field name (required for add-field, modify-field, rename-field, remove-field)'
              },
              fieldNewName: {
                type: 'string',
                description:
                  '[modify:rename-field] New field name. Index DataField refs and TitleField1/2 are fixed automatically; ' +
                  'if the field was already renamed, only the index refs are repaired.'
              },
              fieldType: {
                type: 'string',
                description: '[modify] EDT name for the field (required for add-field, e.g. "InventQty", "WHSZoneId", "TransDate"). For modify-field: new EDT to set.'
              },
              fieldBaseType: {
                type: 'string',
                enum: ['String', 'Integer', 'Real', 'Date', 'DateTime', 'Int64', 'GUID', 'Enum'],
                description:
                  '[modify] Base type for add-field — REQUIRED when fieldType is an EDT name; selects the XML element ' +
                  '(e.g. edt "InventQty" + "Real" → AxTableFieldReal). Defaults to String, which is WRONG for Real/Date/Int64.'
              },
              fieldMandatory: {
                type: 'boolean',
                description: '[modify] Is field mandatory (for add-field and modify-field)'
              },
              fieldLabel: {
                type: 'string',
                description: '[modify] Field label (for add-field and modify-field)'
              },
              fieldHelpText: {
                type: 'string',
                description: '[modify:modify-field] Field help text.'
              },
              fieldEnumType: {
                type: 'string',
                description: '[modify:modify-field] Enum name to set on an enum-typed field.'
              },
              fieldStringSize: {
                type: 'string',
                description: '[modify:modify-field] String size to set on a string-typed field.'
              },
              fields: {
                type: 'array',
                description:
                  '[modify:replace-all-fields] Full replacement field list (atomic; for corrupted field names). ' +
                  'NEVER use PowerShell/create_file for this.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name' },
                    edt:  { type: 'string', description: 'EDT name, e.g. "InventQty", "WHSZoneId"' },
                    type: {
                      type: 'string',
                      enum: ['String', 'Integer', 'Real', 'Date', 'DateTime', 'Int64', 'GUID', 'Enum'],
                      description:
                        'Base type — REQUIRED alongside edt; selects AxTableFieldReal/Date/… (defaults to String, wrong for numeric/date EDTs).'
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
                  '[modify:modify-property] Property name to set. Supported names by objectType:\n' +
                  'table: TableGroup, TitleField1/2, TableType (TempDB/InMemory/RegularTable), CacheLookup, ClusteredIndex, PrimaryIndex, SaveDataPerCompany, Label, HelpText, Extends, SystemTable.\n' +
                  'table-extension (stored as <AxPropertyModification>): the table names above plus ModifiedDateTime, CreatedDateTime, ModifiedBy, CreatedBy (Yes/No), CountryRegionCodes ("CZ,SK").\n' +
                  'edt: Extends, StringSize, Label, HelpText, ReferenceTable, ReferenceField.\n' +
                  'class: Extends, Abstract, Final, Label.\n' +
                  'Example: propertyPath="TableGroup" propertyValue="Group".'
              },
              propertyValue: {
                type: 'string',
                description: '[modify:modify-property] New property value (required for modify-property)'
              },
              controlName: {
                type: 'string',
                description:
                  '[modify:add-control] Name of the new form control. e.g. "MyCustPriorityTier". Becomes <Name> inside <FormControl>. ' +
                  'MUST match the field name in the table extension so the binding works.'
              },
              parentControl: {
                type: 'string',
                description:
                  '[modify:add-control] Name of the existing parent tab/group in the base form. e.g. "TabGeneral", "TabPageSales", "HeaderGroup". ' +
                  'Use get_object_info(objectType="form", name=formName, options={searchControl:"General"}) to find the exact name.'
              },
              controlDataSource: {
                type: 'string',
                description: '[modify:add-control] Data source name for the control binding (e.g. "CustTable").'
              },
              controlDataField: {
                type: 'string',
                description:
                  '[modify:add-control] Data field name for the control binding (e.g. "MyCustPriorityTier"). ' +
                  'The field must already exist in the table or table extension before binding it here.'
              },
              controlType: {
                type: 'string',
                description:
                  '[modify:add-control] Control type: String (default), Integer, Real, CheckBox (NoYes/boolean), ComboBox (enums), ' +
                  'Date, DateTime, Int64, Group, Button, CommandButton, MenuFunctionButton.'
              },
              controlLabel: {
                type: 'string',
                description: '[modify:add-control] Optional label for the new control.'
              },
              positionType: {
                type: 'string',
                description: '[modify:add-control] Optional: AfterItem | BeforeItem. Omit to append at the end of the parent.'
              },
              previousSibling: {
                type: 'string',
                description: '[modify:add-control] Name of the sibling control to position after (used with positionType=AfterItem).'
              },
              baseFormName: {
                type: 'string',
                description: '[modify:add-control] Base form name for auto-resolving parentControl when the extension name does not contain it (e.g. objectName="SalesOrder.MyExt" → "SalesOrder"). Pass only when auto-detection fails.'
              },
              // ── action=modify: add-table-method / add-display-method ─────────
              tableMethodType: {
                type: 'string',
                enum: ['find', 'exist', 'findByRecId', 'validateWrite', 'validateDelete', 'initValue'],
                description:
                  '[modify:add-table-method] Standard table method to auto-generate (method name is implied). ' +
                  'find/exist also need tableKeyField. Omit and pass methodName+sourceCode for a custom method instead.'
              },
              tableKeyField: {
                type: 'string',
                description: '[modify:add-table-method] Primary key field for find/exist generation (e.g. "ItemId", "SalesId").'
              },
              displayMethodReturnEdt: {
                type: 'string',
                description: '[modify:add-display-method] EDT/type the display method returns (e.g. "Name", "AmountMST"). With methodName, auto-generates a display-method stub. Omit and pass sourceCode for a custom body.'
              },
              // ── action=modify: add-index / remove-index ─────────────────────
              indexName: {
                type: 'string',
                description: '[modify:add-index/remove-index] Index name.'
              },
              indexFields: {
                type: 'array',
                description: '[modify:add-index] Fields that make up the index (required for add-index).',
                items: {
                  type: 'object',
                  properties: {
                    fieldName: { type: 'string', description: 'Field name.' },
                    direction: { type: 'string', enum: ['Asc', 'Desc'], description: 'Sort direction (optional).' },
                  },
                  required: ['fieldName'],
                },
              },
              indexAllowDuplicates: {
                type: 'boolean',
                description: '[modify:add-index] Allow duplicates (default: false = unique).'
              },
              indexAlternateKey: {
                type: 'boolean',
                description: '[modify:add-index] Mark the index as an alternate key.'
              },
              indexEnabled: {
                type: 'boolean',
                description: '[modify:add-index] Whether the index is enabled (default: true).'
              },
              // ── action=modify: add-relation / remove-relation ───────────────
              relationName: {
                type: 'string',
                description: '[modify:add-relation/remove-relation] Relation name.'
              },
              relatedTable: {
                type: 'string',
                description: '[modify:add-relation] Related (foreign key) table name.'
              },
              relationConstraints: {
                type: 'array',
                description: '[modify:add-relation] Field constraints (field = relatedField pairs).',
                items: {
                  type: 'object',
                  properties: {
                    fieldName: { type: 'string', description: 'Local field name.' },
                    relatedFieldName: { type: 'string', description: 'Field name in the related table.' },
                  },
                  required: ['fieldName', 'relatedFieldName'],
                },
              },
              relationCardinality: {
                type: 'string',
                description: '[modify:add-relation] Local-side cardinality: ZeroMore | ZeroOne | ExactlyOne (default: ZeroMore).'
              },
              relatedTableCardinality: {
                type: 'string',
                description: '[modify:add-relation] Related-side cardinality: ZeroMore | ZeroOne | ExactlyOne (default: ExactlyOne).'
              },
              relationshipType: {
                type: 'string',
                description: '[modify:add-relation] Association | Composition | Aggregation | Link | Specialization (default: Association).'
              },
              // ── action=modify: field groups ─────────────────────────────────
              fieldGroupName: {
                type: 'string',
                description: '[modify:add-field-group/remove-field-group/add-field-to-field-group] Field group name.'
              },
              fieldGroupFields: {
                type: 'array',
                description: '[modify:add-field-group] Initial field names (may be empty — add later with add-field-to-field-group).',
                items: { type: 'string' },
              },
              fieldGroupLabel: {
                type: 'string',
                description: '[modify:add-field-group] Field group label (optional).'
              },
              extendBaseFieldGroup: {
                type: 'boolean',
                description: '[modify:add-field-to-field-group] table-extension only: true extends an existing base-table field group (<FieldGroupExtensions>); false/omitted adds to a new group defined in the extension.'
              },
              // ── action=modify: add-data-source (form-extension) ─────────────
              dataSourceName: {
                type: 'string',
                description: '[modify:add-data-source] Data source reference name (e.g. "MyTable_1").'
              },
              dataSourceTable: {
                type: 'string',
                description: '[modify:add-data-source] Base table for the data source (e.g. "MyTable").'
              },
              joinSource: {
                type: 'string',
                description: '[modify:add-data-source] Optional existing data source on the form to join the new one to.'
              },
              linkType: {
                type: 'string',
                description: '[modify:add-data-source] Optional join/link type when joinSource is set: InnerJoin | OuterJoin | ExistJoin | NotExistJoin | Delayed | Active | Passive.'
              },
              // ── action=modify: enum values ──────────────────────────────────
              enumValueName: {
                type: 'string',
                description: '[modify:add-enum-value/modify-enum-value/remove-enum-value] Enum value name (e.g. "Approved").'
              },
              enumValueLabel: {
                type: 'string',
                description: '[modify:add-enum-value/modify-enum-value] Label reference (e.g. "@MyModel:Approved").'
              },
              enumValueHelpText: {
                type: 'string',
                description: '[modify:add-enum-value] Help-text reference (optional).'
              },
              enumValueInt: {
                type: 'number',
                description: '[modify:add-enum-value] Explicit integer value; if omitted the next available value is assigned. With modify-enum-value, changes the integer (rare).'
              },
              enumValueCountryRegionCodes: {
                type: 'string',
                description: '[modify:add-enum-value] ISO country/region codes, comma-separated (e.g. "CZ,SK").'
              },
              // ── action=modify: add-menu-item-to-menu ────────────────────────
              menuItemToAdd: {
                type: 'string',
                description: '[modify:add-menu-item-to-menu] Name of the menu item to add (e.g. "MyCustomForm").'
              },
              menuItemToAddType: {
                type: 'string',
                enum: ['display', 'action', 'output'],
                description: '[modify:add-menu-item-to-menu] Menu item kind: display (form), action (class), output (report). Default: display.'
              },
              createBackup: {
                type: 'boolean',
                description: '[modify] Create backup before modification (default: false)',
                default: false
              },
              filePath: {
                type: 'string',
                description: '[modify] Absolute path to the XML file — bypasses symbol-DB lookup. Use when the object was just created and the path is known.'
              },
              workspacePath: {
                type: 'string',
                description: '[modify] Path to workspace for finding file'
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'find_references',
          description: 'Find all references (where-used) to a class, method, field, table, or enum. Essential for impact analysis before refactoring. For a method, SCOPE it to its declaring type — pass "Owner.method" (e.g. "SalesTable.initFromSalesQuotationTable"), set ownerName alongside a bare method name, or pass an AOT path ("/Tables/SalesTable/Methods/initFromSalesQuotationTable"). A bare method name (no owner) matches that name on every type and over-reports.',
          inputSchema: {
            type: 'object',
            properties: {
              targetName: {
                type: 'string',
                description: 'Target name. Method where-used: qualify as "Owner.method" or pass an AOT path "/Tables/<Table>/Methods/<method>" for a result scoped to one declaring type (matches Visual Studio xref). A bare method name is name-only and over-reports.'
              },
              targetType: {
                type: 'string',
                enum: ['class', 'method', 'field', 'table', 'enum', 'edt', 'form', 'query', 'view', 'report', 'all'],
                description: 'Type of the target to search for',
                default: 'all'
              },
              ownerName: {
                type: 'string',
                description: 'Declaring table/class/form that owns the method, when targetName is the bare method name. Scopes the where-used to that single type.'
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
          name: 'get_method',
          description:
            'Read a method off a class. Choose `include`:\n' +
            '• signature → modifiers/return type/params/attributes only (cheap). REQUIRED before creating CoC extensions — wrong signatures cause compile errors.\n' +
            '• source → full X++ body of the method.\n' +
            '• both (default) → signature followed by source.\n' +
            'Only call for methods confirmed to exist via get_object_info(objectType="class", ...) — never guess method names.',
          inputSchema: {
            type: 'object',
            properties: {
              include: {
                type: 'string',
                enum: ['signature', 'source', 'both'],
                default: 'both',
                description: 'What to return: signature, source, or both (default).',
              },
              className: {
                type: 'string',
                description: 'Name of the class containing the method'
              },
              methodName: {
                type: 'string',
                description: 'Name of the method'
              },
            },
            required: ['className', 'methodName'],
          },
        },
        {
          name: 'get_object_info',
          description: 'Read one D365FO object\'s metadata. Pick the kind via objectType: class, table, form, query, view, enum, edt, report, data-entity, menu-item, service, map, config-key, security-policy, macro. Extension types (table-extension, form-extension, enum-extension, edt-extension, data-entity-extension) list all extensions of a base object — pass the base object name or a full extension name (the dot suffix is stripped automatically). Type-specific flags go in options, e.g. {"includeRdl":true} (report), {"searchControl":"General"} (form), {"compact":false} (class), {"filter":"Path"} (macro), {"mode":"hierarchy"} (edt). For CLASSES, {"members":"names"} (optional {"prefix":...}) returns a fast IntelliSense-style member-name list instead of full metadata. For 2+ objects use batch_get_info. Replaces the former get_<type>_info and code_completion tools.',
          inputSchema: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: [...OBJECT_INFO_TYPES],
                description: 'Kind of object to read (incl. *-extension types — pass base object name or full extension name)',
              },
              name: {
                type: 'string',
                description: 'Exact object name (use search first if unsure)',
              },
              options: {
                type: 'object',
                description: 'Optional type-specific flags forwarded to the reader (e.g. includeRdl, includeFields, searchControl, compact, includeOperations, filter, mode, modelName).',
              },
            },
            required: ['objectType', 'name'],
          },
        },
        {
          name: 'labels',
          description:
            'Unified label operations — read and write. Choose an `action`:\n' +
            '• search → full-text query across indexed label files (read). Always run before action=create.\n' +
            '• info → all language translations for a labelId, OR list available label files when labelId is omitted. Pass labelFileId (without labelId) to get that label file plus the physical .label.txt path per language (read).\n' +
            '• create → add a new label to an AxLabelFile, write into every language .label.txt, create XML descriptors if missing (write). Label IDs describe MEANING — never add a model prefix. Target the model\'s ORIGINAL label file, never a label file extension (…_Extension…). Fails if the label already exists. For many labels at once pass labels:[{labelId, translations}, …] with the shared labelFileId/model at the top level — they are created in one call and reported together.\n' +
            '• update → overwrite the text of an EXISTING label (e.g. fix a wrong/duplicate translation in cs/de). Same args as create; provide the corrected translations[] (write).\n' +
            '• rename → rename a label ID across .label.txt + X++ + XML metadata + SQLite index. Use dryRun=true first (write).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['search', 'info', 'create', 'update', 'rename', 'list', 'list-files'],
                description: 'Label operation to perform. "list"/"list-files" are aliases of "info" (lists label files).',
              },
              // ── shared filters ─────────────────────────────────────────────
              model: {
                type: 'string',
                description: '[search|info|create|update|rename] Model that owns the label file (e.g. ContosoExt).',
              },
              labelFileId: {
                type: 'string',
                description: '[search|info|create|update|rename] AxLabelFile ID (e.g. ContosoExt, SYS). For action=info with no labelId, returns the physical .label.txt path per language. For create/update/rename use the model\'s ORIGINAL label file, not an extension (…_Extension…).',
              },
              language: {
                type: 'string',
                description: '[search] Language/locale (default: en-US). Examples: cs, de, sk.',
              },
              limit: {
                type: 'number',
                description: '[search] Maximum number of results (default 30).',
              },
              // ── action=search ──────────────────────────────────────────────
              query: {
                type: 'string',
                description: '[search] REQUIRED. Search text — matches label ID, text and developer comment.',
              },
              // ── action=info ────────────────────────────────────────────────
              labelId: {
                type: 'string',
                description: '[info] Exact label ID. Omit for action=info to list available label files for the model.',
              },
              // ── action=create ──────────────────────────────────────────────
              labels: {
                type: 'array',
                description:
                  '[create] OPTIONAL bulk mode — create several labels in one call. Each entry is { labelId, translations[], description?, defaultComment? }. ' +
                  'Shared fields (labelFileId, model, languages, paths…) stay at the top level. When present, top-level labelId/translations are ignored. ' +
                  'Each label is created via the normal single-label path and results are aggregated into one report (a failed entry does not abort the batch).',
                items: {
                  type: 'object',
                  properties: {
                    labelId: { type: 'string', description: 'Label ID for this entry — alphanumeric, no model prefix.' },
                    translations: {
                      type: 'array',
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
                  },
                  required: ['labelId', 'translations'],
                },
              },
              translations: {
                type: 'array',
                description: '[create] REQUIRED for single-label create (omit when using labels[]). Translations for each language. Provide at least en-US.',
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
                description: '[create] Developer comment for languages without explicit comment.',
              },
              description: {
                type: 'string',
                description:
                  '[create] Label description (comment line in .label.txt). Defaults to VS project name from .rnrproj when omitted, then falls back to labelFileId. ' +
                  'Per-translation comment and defaultComment take priority.',
              },
              packageName: {
                type: 'string',
                description: '[create|rename] Package name for the model. Auto-resolved if omitted.',
              },
              packagePath: {
                type: 'string',
                description: '[create|rename] Root packages path. Auto-detected from environment config if omitted.',
              },
              projectPath: {
                type: 'string',
                description: '[create] Path to the .rnrproj project file. Auto-detected from .mcp.json if omitted.',
              },
              solutionPath: {
                type: 'string',
                description: '[create] Path to the .sln solution directory. Fallback to find .rnrproj if projectPath is not set.',
              },
              addToProject: {
                type: 'boolean',
                description: '[create] Add label file XML descriptors to the VS project (default: true).',
              },
              createLabelFileIfMissing: {
                type: 'boolean',
                description: '[create] Create the AxLabelFile structure if missing (default: true). A wrong-path guard still fails loudly when the model directory is not found, so no phantom file is produced. Set false to fail fast instead.',
              },
              sortLabels: {
                type: 'boolean',
                description:
                  '[create] Sort labels alphabetically when writing .label.txt files (default: true). ' +
                  'Set to false to append new labels at the end preserving existing file order. ' +
                  'Defaults to LABEL_SORT_ORDER env var ("alphabetical" = true, "append" = false).',
              },
              languages: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '[create] Restrict which language .label.txt files are written/created (e.g. ["en-US"] for English-only). ' +
                  'When omitted, the label is written to every language folder already present in the model.',
              },
              // ── action=rename ──────────────────────────────────────────────
              oldLabelId: {
                type: 'string',
                description: '[rename] REQUIRED. Current label ID (e.g. MyOldField).',
              },
              newLabelId: {
                type: 'string',
                description: '[rename] REQUIRED. New label ID — must be alphanumeric, no spaces.',
              },
              searchPaths: {
                type: 'array',
                items: { type: 'string' },
                description: '[rename] Additional absolute directory paths to scan for X++ / XML references.',
              },
              dryRun: {
                type: 'boolean',
                description: '[rename] Preview changes without writing anything (default: false). Use this first!',
              },
              // ── shared write knob ──────────────────────────────────────────
              updateIndex: {
                type: 'boolean',
                description: '[create|rename] Update the MCP label index after writing (default: true).',
              },
              allowExtensionLabelFile: {
                type: 'boolean',
                description:
                  '[create|rename] Allow operating on a label file EXTENSION (labelFileId carrying the "_Extension" marker). ' +
                  'Default false: new labels belong in the model\'s ORIGINAL label file, never an extension. ' +
                  'Leave false unless you genuinely intend to write to an extension.',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'object_patterns',
          description:
            'Pattern toolkit. Choose a `domain`:\n' +
            '• table → common field types, index patterns and relation structures for D365FO tables. Filter by tableGroup (Main, Transaction, …) or similarTo a given table.\n' +
            '• form → form-pattern toolkit; pick an `action`:\n' +
            '   - analyze → pattern advisor + usage analysis. RECOMMEND (preferred for a new form): pass recommend={entityKind, hasHeaderLines, fieldCount, usageIntent, tableName} for the right pattern via the Microsoft decision tree + reference forms to clone. Or filter by formPattern / dataSource / similarTo.\n' +
            '   - spec → full structure spec of a pattern or sub-pattern (required hierarchy/ordering, allowed children, reference forms, lifecycle). Call after analyze, before building.\n' +
            '   - validate → structural validator of AxForm XML (<50 ms, offline): container hierarchy/order, sub-patterns, PatternVersion. Returns FP001-FP010 violations. Call before action=create on d365fo_file.',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                enum: ['table', 'form'],
                description: 'table = table field/index/relation patterns; form = form-pattern toolkit (set action). Optional — inferred from the other params (action/pattern/xml/formName → form; tableGroup → table). Alias: patternType.',
              },
              // ── domain=table ───────────────────────────────────────────────
              tableGroup: {
                type: 'string',
                enum: ['Main', 'Transaction', 'Parameter', 'Group', 'Reference', 'Miscellaneous', 'WorksheetHeader', 'WorksheetLine'],
                description: '[table] Table group type to analyze (choose one).',
              },
              // ── domain=form ────────────────────────────────────────────────
              action: {
                type: 'string',
                enum: ['analyze', 'validate', 'spec'],
                description: '[form] Which form-pattern operation to run.',
              },
              // ── domain=form, action=analyze ────────────────────────────────
              formPattern: {
                type: 'string',
                enum: ['DetailsTransaction', 'ListPage', 'SimpleList', 'SimpleListDetails', 'Dialog', 'DropDialog', 'FormPart', 'Lookup'],
                description: '[analyze] D365FO form pattern to analyze',
              },
              dataSource: {
                type: 'string',
                description: '[form/analyze] Table name - find forms using this table',
              },
              similarTo: {
                type: 'string',
                description: '[table] table name to find similar table patterns; [form/analyze] form name to find similar form patterns.',
              },
              recommend: {
                type: 'object',
                description: '[analyze] Pattern advisor: describe requirements, get a recommended pattern + reference forms to clone.',
                properties: {
                  entityKind: {
                    type: 'string',
                    enum: ['master', 'transaction', 'setup', 'parameters', 'inquiry', 'lookup', 'workspace', 'dialogTask'],
                    description: 'Kind of entity: master (customers), transaction (orders+lines), setup (group tables), parameters, inquiry (read-only), lookup, workspace, dialogTask',
                  },
                  hasHeaderLines: {
                    type: 'boolean',
                    description: 'True when data is a header with line items',
                  },
                  fieldCount: {
                    type: 'number',
                    description: 'Approximate fields users see/edit per record (<10 → SimpleList, ≥10 → SimpleListDetails)',
                  },
                  usageIntent: {
                    type: 'string',
                    enum: ['maintain', 'viewOnly', 'pickValue', 'quickCreate', 'dashboard', 'wizard'],
                    description: 'Primary user activity on the form',
                  },
                  tableName: {
                    type: 'string',
                    description: 'Main table — pulls field count and existing-form evidence from the index',
                  },
                },
              },
              limit: {
                type: 'number',
                description: '[analyze] Maximum number of pattern examples (default: 10)',
                default: 10,
              },
              // ── action=spec ────────────────────────────────────────────────
              pattern: {
                type: 'string',
                description: '[spec] REQUIRED. Pattern name (id, xmlName, or alias) — e.g. "SimpleList", "DetailsMaster", or a sub-pattern like "FieldsFieldGroups".',
              },
              // ── action=validate ────────────────────────────────────────────
              xml: {
                type: 'string',
                description: '[validate] Complete AxForm XML to validate. Provide this OR formName/filePath.',
              },
              formName: {
                type: 'string',
                description: '[validate] Name of an indexed form — XML is loaded from the metadata store.',
              },
              filePath: {
                type: 'string',
                description: '[form/validate] Explicit path to an AxForm XML file (e.g. a freshly created form not yet indexed).',
              },
            },
            // domain is optional: objectPatternsTool infers it from the other
            // params (and accepts the `patternType` alias). Marking it required
            // here made clients pre-reject otherwise-valid calls.
            required: [],
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
      // ── New tools: security, menu items, extensions ──────────────────────────────
      {
        name: 'security_info',
        description:
          'D365FO security lookup. Choose a `mode`:\n' +
          '• artifact → details + full hierarchy of a named privilege/duty/role (Role → Duties → Privileges → Entry Points).\n' +
          '• coverage → reverse chain for an object: which privileges/duties/roles grant access (object → menu items → privileges → duties → roles).',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['artifact', 'coverage'],
              description: 'artifact = look up a named privilege/duty/role; coverage = who can access an object.',
            },
            // ── mode=artifact ──────────────────────────────────────────────
            name: { type: 'string', description: '[artifact] REQUIRED. Name of the security privilege, duty, or role' },
            artifactType: {
              type: 'string',
              enum: ['privilege', 'duty', 'role'],
              description: '[artifact] REQUIRED. Type of security artifact to look up',
            },
            includeChain: { type: 'boolean', description: '[artifact] Walk the full hierarchy (default: true)', default: true },
            // ── mode=coverage ──────────────────────────────────────────────
            objectName: { type: 'string', description: '[coverage] REQUIRED. Name of the form, table, class, or menu item' },
            objectType: {
              type: 'string',
              enum: ['form', 'table', 'class', 'menu-item', 'auto'],
              description: '[coverage] Type of the object (default: auto-detect)',
              default: 'auto',
            },
          },
          required: ['mode'],
        },
      },
      {
        name: 'extension_info',
        description:
          'D365FO extensibility analyzer. Choose a `mode`:\n' +
          '• coc → Chain of Command extensions + event subscriptions for a class/table. Use before writing a CoC extension to check for conflicts.\n' +
          '• events → event handler subscriptions (SubscribesTo, delegate +=) for a class/table. Use before adding handlers to check for duplicates.\n' +
          '• table-merge → all extensions of a table across models + effective merged schema (base + extension fields/indexes/methods).\n' +
          '• points → available extension points (CoC-eligible/replaceable methods, delegates, blocked methods) and which are already extended.\n' +
          '• strategy → recommends the best extensibility mechanism for a goal (CoC, event handler, business event, data entity, …) with reasoning, risks, alternatives, next steps.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['coc', 'events', 'table-merge', 'points', 'strategy'],
              description: 'coc/events/table-merge/points need `target`; strategy needs `goal`.',
            },
            target: {
              type: 'string',
              description: 'The base object: [coc] class/table being extended; [events] class/table whose handlers to find; [table-merge] base table; [points] class/table/form; [strategy] optional target object.',
            },
            method: {
              type: 'string',
              description: '[coc] filter to a specific method name; [events] filter to a specific event name (e.g. onInserted).',
            },
            objectType: {
              type: 'string',
              enum: ['class', 'table', 'form', 'auto'],
              description: '[events] set "table" when target is a table (else class is assumed); [points] object type (default: auto-detect).',
              default: 'auto',
            },
            goal: {
              type: 'string',
              description: '[strategy] REQUIRED. What you want to achieve — e.g. "validate that SalesLine quantity is positive".',
            },
            scenario: {
              type: 'string',
              enum: ['data-validation', 'field-defaulting', 'field-change-reaction', 'business-logic-change',
                     'outbound-integration', 'inbound-data', 'ui-modification',
                     'document-output', 'number-sequence', 'security-access',
                     'batch-processing', 'custom'],
              description: '[strategy] Scenario category (auto-detected from goal if omitted). field-defaulting = set defaults on NEW records (initValue); field-change-reaction = react when a user/code CHANGES a field (modifiedField).',
            },
            handlerType: {
              type: 'string',
              enum: ['static', 'delegate', 'all'],
              description: '[events] Filter by handler type (default: all).',
              default: 'all',
            },
            includeEventHandlers: {
              type: 'boolean',
              description: '[coc] Also find static event subscriptions (SubscribesTo) (default: true).',
              default: true,
            },
            includeEffectiveSchema: {
              type: 'boolean',
              description: '[table-merge] Merge base + extension counts (default: true).',
              default: true,
            },
            showExistingExtensions: {
              type: 'boolean',
              description: '[points] Show which extension points are already extended (default: true).',
              default: true,
            },
          },
          required: ['mode'],
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
        description: 'Verify that D365FO objects exist on disk at the correct AOT path and are referenced in the .rnrproj project file. Use instead of PowerShell to check d365fo_file(action="create") results.',
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
        description: 'Index a newly generated or modified D365FO XML file immediately so references to it work without restarting the server. Call this after d365fo_file(action="create") to make the new object instantly searchable.',
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
          'Build a D365FO model with xppc.exe (compiles the ENTIRE model, not one project). ' +
          'Blocks until done — call ONCE per build, do NOT poll (wait:false = legacy polling mode). ' +
          'fullBuild:true fixes "not been successfully compiled since it was last changed" stale-symbol errors; ' +
          'buildReferencedModels:true builds custom/ISV dependencies first.',
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
            wait: {
              type: 'boolean',
              description: 'When true (default) the tool blocks until the build finishes and returns the final result in a single call. The agent should make exactly one call per requested build. Set false for legacy fire-and-forget polling behaviour.',
            },
            waitTimeoutMs: {
              type: 'number',
              description: 'Maximum time (ms) to block when wait:true before returning a "still running" snapshot. Defaults to 30 minutes. The build itself continues in the background.',
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
        description: 'Code review of uncommitted X++ changes (git diff HEAD): BP violations, missing labels, CoC patterns. ' +
          'Windows/local mode only. NOT for verifying writes (use verify_d365fo_project + get_object_info instead). ' +
          'If the diff looks truncated, do NOT read .xml/.xpp via built-in tools — proceed with the visible portion or narrow the scope.',
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
        description: 'Safely roll back incorrectly generated code by restoring a file to its last committed state. If the file is tracked by git, runs git checkout HEAD — this discards ALL uncommitted changes to the file, not just the most recent edit (the "last modification" name is historical). If the file is untracked (newly created), deletes it.\n\nAlso re-syncs the symbol/label index to the restored content — prefer this over a manual git revert or editor undo, which leave the index stale and (for .xml/.xpp) can desync the VS 2022 in-memory model.\n\n⚠️ Local companion tool: available only in write-only/local mode (Windows VM).',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute path to the file to restore to HEAD (or delete, if untracked)' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_knowledge',
        description:
          'X++ knowledge lookup. Choose a `kind`:\n' +
          '• knowledge → queryable X++ rulebook: verified patterns, BP rules, AX2012→D365FO migration. Use BEFORE generating code. Topics incl.: select-statement, coc-authoring, bp-rules, sysoperation, event-handlers, workflow, number-sequences, security, sysda, form patterns.\n' +
          '• error → diagnose a D365FO/X++ compiler or runtime error: structured root cause + step-by-step fix + corrected X++ example (TTS mismatch, UpdateConflict, CSUV1, SYS10028 missing next, overlayering, BP errors, …). Call this instead of guessing — X++ error semantics differ from C#/.NET.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['knowledge', 'error'],
              description: 'knowledge = look up an X++ topic/rule; error = diagnose an error message.',
            },
            // ── kind=knowledge ─────────────────────────────────────────────
            topic: {
              type: 'string',
              description:
                '[knowledge] REQUIRED. Topic to query — e.g. "batch job", "ttsbegin", "RunBase vs SysOperation", ' +
                '"set-based operations", "CoC", "data entities", "number sequences", "security", ' +
                '"temp tables", "today() deprecated", "query patterns", "form patterns"',
            },
            format: {
              type: 'string',
              enum: ['concise', 'detailed'],
              default: 'concise',
              description: '[knowledge] concise = quick reference (default), detailed = full explanation with code examples',
            },
            // ── kind=error ─────────────────────────────────────────────────
            errorText: {
              type: 'string',
              description: '[error] REQUIRED. Full error message text as displayed in the X++ compiler or event log',
            },
            errorCode: {
              type: 'string',
              description: '[error] Optional error code (e.g. SYS10028, CSUV1, BPUpgradeCodeToday)',
            },
          },
          // kind is optional: getKnowledgeTool infers it from topic (→ knowledge)
          // or errorText (→ error). Marking it required made clients pre-reject
          // calls that passed only `topic`.
          required: [],
        },
      },
      {
        name: 'validate_code',
        description:
          'Static validator for generated X++/XML (paste the text). Choose a `mode`:\n' +
          '• syntax → offline best-practice/BP validator (<50 ms, no xppbp.exe). Structured violations {rule, severity, line, excerpt, fix}. Covers select (SEL001-005), CoC (COC001-003), BP (BP001-003) and table-XML (XML001-005) rules mined from standard models.\n' +
          '• references → semantic reference resolver (<200 ms, index-only): verifies every type, field, method (incl. arity), enum, label and intrinsic (tableStr/fieldStr/…) EXISTS in the indexed codebase — catches hallucinated symbols before the compiler.\n' +
          'Call both AFTER generating, BEFORE writes; fix errors in the same turn. Write tools run references internally when GROUNDING_ENFORCE=true.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['syntax', 'references'],
              description: 'syntax = BP/best-practice rules; references = symbol resolution against the index. Defaults to syntax.',
            },
            code: {
              type: 'string',
              description: 'X++ source code or XML metadata to validate. Paste the full generated text.',
            },
            codeType: {
              type: 'string',
              enum: ['xpp', 'xml-table', 'xml-any'],
              default: 'xpp',
              description: '[syntax] "xpp" for X++ source (default), "xml-table" for AxTable XML, "xml-any" for other XML.',
            },
            context: {
              type: 'string',
              description: 'Optional: owning class/table name, used in diagnostic messages.',
            },
          },
          required: ['mode', 'code'],
        },
      },
      {
        name: 'prepare',
        description:
          'ONE-call context aggregator + groundingToken (30-min TTL, required for extension/new-object writes when ' +
          'GROUNDING_ENFORCE=true). Choose a `mode`:\n' +
          '• change → extending/modifying an EXISTING object: exact signature, existing CoC wrappers, eligibility, ' +
          'recommended strategy, naming validation, code patterns. Replaces the analyze→search→info→generate loop.\n' +
          '• create → a NEW object: collision check, naming with auto-prefix, similar objects, EDT suggestions, ' +
          'reusable labels, mined property defaults. Call BEFORE generating any new object.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['change', 'create'],
              description: 'change = extend/modify an existing object; create = a brand-new object.',
            },
            goal: {
              type: 'string',
              description: 'One-sentence description of the intent. Example (change): "Add CoC on CustTable.validateWrite". Example (create): "Parameter table for the Contoso import feature."',
            },
            objectName: {
              type: 'string',
              description: '[change] Name of the object to extend/modify (e.g. "CustTable"). [create] Proposed BASE name WITHOUT model prefix (same value you would pass to d365fo_file create).',
            },
            objectType: {
              type: 'string',
              enum: [
                'class', 'table', 'form', 'enum', 'edt', 'query', 'view',
                'data-entity', 'report', 'map', 'menu-item-display', 'menu-item-action',
                'menu-item-output', 'security-privilege', 'security-duty', 'security-role',
              ],
              description: '[change] D365FO object type — auto-detected from the index when omitted. [create] REQUIRED — type of the new object.',
            },
            methodName: {
              type: 'string',
              description: '[change] Target method name when the change involves a specific method (CoC or event handlers). Example: "validateWrite".',
            },
            proposedName: {
              type: 'string',
              description: '[change] Proposed name for the new extension class/object. When provided, naming validation runs.',
            },
            fieldsHint: {
              type: 'array',
              items: { type: 'string' },
              description: '[create] For tables/views: planned field names — each gets EDT suggestions from the index.',
            },
          },
          required: ['mode', 'goal', 'objectName'],
        },
      },
    ],
    };

    // Attach MCP tool annotations (display title + behavior hints).
    // VS Code shows annotations.title in the chat UI ("Ran Search D365FO index"
    // instead of "Ran search") and uses readOnlyHint to skip write confirmations.
    allTools.tools = allTools.tools.map(t => ({
      ...t,
      annotations: TOOL_ANNOTATIONS[t.name],
    })) as typeof allTools.tools;

    // Apply server mode filter. ALWAYS_TOOLS bypass the partition and stay
    // published in every mode.
    if (SERVER_MODE === 'read-only') {
      allTools.tools = allTools.tools.filter(t => !LOCAL_TOOLS.has(t.name) || ALWAYS_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for read-only mode: ${allTools.tools.length} tools (local tools excluded)`);
    } else if (SERVER_MODE === 'write-only') {
      allTools.tools = allTools.tools.filter(t => LOCAL_TOOLS.has(t.name) || ALWAYS_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for write-only mode: ${allTools.tools.length} tools (${Array.from(LOCAL_TOOLS).join(', ')})`);
    } else {
      console.error(`[MCP Server] Tool list in full mode: ${allTools.tools.length} tools (no filtering)`);
    }

    return allTools;
  });

  return server;
}
