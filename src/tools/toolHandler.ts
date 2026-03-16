import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import { SERVER_MODE, LOCAL_TOOLS } from '../server/serverMode.js';
import { searchTool } from './search.js';
import { batchSearchTool } from './batchSearch.js';
import { classInfoTool } from './classInfo.js';
import { tableInfoTool } from './tableInfo.js';
import { completionTool } from './completion.js';
import { codeGenTool } from './codeGen.js';
import { extensionSearchTool } from './extensionSearch.js';
import { analyzeCodePatternsTool } from './analyzePatterns.js';
import { suggestMethodImplementationTool } from './suggestImplementation.js';
import { analyzeClassCompletenessTool } from './analyzeCompleteness.js';
import { getApiUsagePatternsTool } from './apiUsagePatterns.js';
import { handleGenerateD365Xml } from './generateD365Xml.js';
import { handleCreateD365File } from './createD365File.js';
import { findReferencesTool } from './findReferences.js';
import { modifyD365FileTool } from './modifyD365File.js';
import { getMethodSignatureTool } from './methodSignature.js';
import { getMethodSourceTool } from './getMethodSource.js';
import { getFormInfoTool } from './formInfo.js';
import { getQueryInfoTool } from './queryInfo.js';
import { getViewInfoTool } from './viewInfo.js';
import { getEnumInfoTool } from './enumInfo.js';
import { getEdtInfoTool } from './edtInfo.js';
import { getReportInfoTool } from './reportInfo.js';
import { searchLabelsTool } from './searchLabels.js';
import { getLabelInfoTool } from './getLabelInfo.js';
import { createLabelTool } from './createLabel.js';
import { renameLabelTool } from './renameLabel.js';
import { handleGetTablePatterns } from './getTablePatterns.js';
import { handleGetFormPatterns } from './getFormPatterns.js';
import { handleGenerateSmartTable } from './generateSmartTable.js';
import { handleGenerateSmartForm } from './generateSmartForm.js';
import { handleSuggestEdt } from './suggestEdt.js';
import { securityArtifactInfoTool } from './securityArtifactInfo.js';
import { menuItemInfoTool } from './menuItemInfo.js';
import { findCocExtensionsTool } from './findCocExtensions.js';
import { tableExtensionInfoTool } from './tableExtensionInfo.js';
import { dataEntityInfoTool } from './dataEntityInfo.js';
import { findEventHandlersTool } from './findEventHandlers.js';
import { securityCoverageInfoTool } from './securityCoverageInfo.js';
import { analyzeExtensionPointsTool } from './analyzeExtensionPoints.js';
import { validateObjectNamingTool } from './validateObjectNaming.js';
import { verifyD365ProjectTool } from './verifyD365Project.js';
import { resolveObjectPrefix } from '../utils/modelClassifier.js';
import { getStdioSessionInfo } from '../utils/stdioSessionInfo.js';

/**
 * Extract workspace path from GitHub Copilot _meta and apply it to ConfigManager.
 * Called before every tool dispatch so workspace is always up-to-date.
 */
function extractAndApplyWorkspaceFromMeta(meta: any): void {
  if (!meta) return;

  let rawUri: string | undefined;

  // workspaceFolders / workspaceFolderUris / roots — array of { uri } or strings
  for (const key of ['workspaceFolders', 'workspaceFolderUris', 'roots']) {
    const arr = meta[key];
    if (Array.isArray(arr) && arr.length > 0) {
      rawUri = typeof arr[0] === 'string' ? arr[0] : arr[0]?.uri;
      break;
    }
  }

  // Single-string fallbacks
  if (!rawUri) {
    for (const key of ['workspaceFolderUri', 'workspaceFolder', 'workspacePath']) {
      if (typeof meta[key] === 'string') {
        rawUri = meta[key];
        break;
      }
    }
  }

  if (!rawUri) return;

  // Convert file:// URI → local path
  let localPath = rawUri;
  if (rawUri.startsWith('file:///')) {
    localPath = decodeURIComponent(rawUri.slice('file:///'.length)).replace(/\//g, '\\');
  } else if (rawUri.startsWith('file://')) {
    localPath = decodeURIComponent(rawUri.slice('file://'.length)).replace(/\//g, '\\');
  }

  // Apply workspace context (debug logging removed for performance)
  getConfigManager().setRuntimeContext({ workspacePath: localPath });
}

/**
 * Centralized tool handler that dispatches to individual tool implementations
 */

/** Per-tool response cap sizes. 'uncapped' = no truncation. */
const TOOL_CAP_SIZES: Record<string, number | 'uncapped'> = {
  // Uncapped — XML generation, file writes, or long structured output
  generate_smart_table:             'uncapped',
  generate_smart_form:              'uncapped',
  create_d365fo_file:               'uncapped',
  generate_d365fo_xml:              'uncapped',
  get_report_info:                  'uncapped',
  // New tools with longer output
  get_security_artifact_info:       8000,
  get_security_coverage_for_object: 8000,
  get_table_extension_info:         6000,
  analyze_extension_points:         6000,
  find_coc_extensions:              5000,
  find_event_handlers:              5000,
  get_data_entity_info:             5000,
  get_class_info:                   6000,
  get_table_info:                   6000,
  get_form_info:                    5000,
  // Default for everything else
  default:                          5000,
};

function getCapForTool(toolName: string): number | 'uncapped' {
  return TOOL_CAP_SIZES[toolName] ?? TOOL_CAP_SIZES['default'];
}

function capToolResponse(toolName: string, result: any): any {
  const cap = getCapForTool(toolName);
  if (cap === 'uncapped' || !result?.content) return result;
  const content = result.content.map((item: any) => {
    if (item.type !== 'text' || typeof item.text !== 'string') return item;
    if (item.text.length <= (cap as number)) return item;
    return {
      ...item,
      text: item.text.slice(0, cap as number) +
        `\n\n> ✂️ Response truncated at ${cap} chars. Use more specific parameters (e.g. methodOffset, compact=false for one class) to get remaining content.`,
    };
  });
  return { ...result, content };
}

export function registerToolHandler(server: Server, context: XppServerContext): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    // Extract workspace path from _meta (GitHub Copilot injects workspace context here)
    // This is a secondary extraction path — transport.ts does the primary one from HTTP headers.
    // Having it here ensures it also works when transport-level extraction missed it.
    extractAndApplyWorkspaceFromMeta((request as any).params?._meta);
    extractAndApplyWorkspaceFromMeta((request.params as any)._meta);

    // In stdio mode the DB loads asynchronously after transport connect.
    // ctx.dbReady resolves once the real 1.5 GB symbol database is open and
    // patched into the context. Awaiting it here ensures every tool call uses
    // the real index — tools that arrive during DB loading will block (showing
    // a spinner in the IDE) rather than silently returning empty results.
    // LOCAL_TOOLS (create_d365fo_file, verify_d365fo_project, get_workspace_info
    // etc.) access the local filesystem or in-memory config — no DB needed,
    // so they skip the wait and execute immediately.
    if (context.dbReady && !LOCAL_TOOLS.has(toolName)) {
      const t0 = Date.now();
      await context.dbReady;
      const elapsed = Date.now() - t0;
      if (elapsed > 200) {
        console.error(`[toolHandler] ⏳ ${toolName}: DB was loading, waited ${elapsed} ms`);
      }
    }

    // Enforce server mode: block local tools in read-only (Azure) mode, block search/analysis tools in write-only mode
    if (SERVER_MODE === 'read-only' && LOCAL_TOOLS.has(toolName)) {
      return {
        content: [{ type: 'text', text: `⚠️ Tool '${toolName}' requires local Windows VM filesystem access and is not available in read-only mode.\n\nThis MCP server is running in read-only mode (Azure deployment).\nTo use file operations and workspace diagnostics, configure a local MCP server with MCP_SERVER_MODE=write-only in your .mcp.json.\n\nSee: https://github.com/dynamics365ninja/d365fo-mcp-server/blob/main/docs/MCP_CONFIG.md` }],
        isError: true,
      };
    }
    if (SERVER_MODE === 'write-only' && !LOCAL_TOOLS.has(toolName)) {
      return {
        content: [{ type: 'text', text: `⚠️ Tool '${toolName}' is not available in write-only mode.\n\nThis local MCP server only handles file operations. Search and analysis tools are provided by the Azure MCP server.` }],
        isError: true,
      };
    }

    const result = await (async () => { switch (toolName) {
      case 'search':
        return searchTool(request, context);
      case 'batch_search':
        return batchSearchTool(request, context);
      case 'search_extensions':
        return extensionSearchTool(request, context);
      case 'get_class_info':
        return classInfoTool(request, context);
      case 'get_table_info':
        return tableInfoTool(request, context);
      case 'code_completion':
        return completionTool(request, context);
      case 'generate_code':
        return codeGenTool(request);
      case 'analyze_code_patterns':
        return analyzeCodePatternsTool(request, context);
      case 'suggest_method_implementation':
        return suggestMethodImplementationTool(request, context);
      case 'analyze_class_completeness':
        return analyzeClassCompletenessTool(request, context);
      case 'get_api_usage_patterns':
        return getApiUsagePatternsTool(request, context);
      case 'generate_d365fo_xml':
        return handleGenerateD365Xml(request);
      case 'create_d365fo_file':
        return handleCreateD365File(request);
      case 'find_references':
        return findReferencesTool(request, context);
      case 'modify_d365fo_file':
        return modifyD365FileTool(request, context);
      case 'get_method_signature':
        return getMethodSignatureTool(request, context);
      case 'get_method_source':
        return getMethodSourceTool(request, context);
      case 'get_form_info':
        return getFormInfoTool(request, context);
      case 'get_query_info':
        return getQueryInfoTool(request, context);
      case 'get_view_info':
        return getViewInfoTool(request, context);
      case 'get_enum_info':
        return getEnumInfoTool(request, context);
      case 'get_edt_info':
        return getEdtInfoTool(request, context);
      case 'get_report_info':
        return getReportInfoTool(request, context);
      case 'search_labels':
        return searchLabelsTool(request, context);
      case 'get_label_info':
        return getLabelInfoTool(request, context);
      case 'create_label':
        return createLabelTool(request, context);
      case 'rename_label':
        return renameLabelTool(request, context);
      case 'get_table_patterns': {
        const r = await handleGetTablePatterns(
          request.params.arguments as any,
          context.symbolIndex
        );
        return { content: r?.content ?? [{ type: 'text', text: 'No results returned' }] };
      }
      case 'get_form_patterns': {
        const r = await handleGetFormPatterns(
          request.params.arguments as any,
          context.symbolIndex
        );
        return { content: r?.content ?? [{ type: 'text', text: 'No results returned' }] };
      }
      case 'generate_smart_table': {
        const r = await handleGenerateSmartTable(
          request.params.arguments as any,
          context.symbolIndex
        );
        return { content: r?.content ?? [{ type: 'text', text: 'No results returned' }] };
      }
      case 'generate_smart_form': {
        const r = await handleGenerateSmartForm(
          request.params.arguments as any,
          context.symbolIndex
        );
        return { content: r?.content ?? [{ type: 'text', text: 'No results returned' }] };
      }
      case 'suggest_edt': {
        const r = await handleSuggestEdt(
          request.params.arguments as any,
          context.symbolIndex
        );
        return { content: r?.content ?? [{ type: 'text', text: 'No results returned' }] };
      }
      case 'get_security_artifact_info':
        return securityArtifactInfoTool(request, context);
      case 'get_menu_item_info':
        return menuItemInfoTool(request, context);
      case 'find_coc_extensions':
        return findCocExtensionsTool(request, context);
      case 'get_table_extension_info':
        return tableExtensionInfoTool(request, context);
      case 'get_data_entity_info':
        return dataEntityInfoTool(request, context);
      case 'find_event_handlers':
        return findEventHandlersTool(request, context);
      case 'get_security_coverage_for_object':
        return securityCoverageInfoTool(request, context);
      case 'analyze_extension_points':
        return analyzeExtensionPointsTool(request, context);
      case 'validate_object_naming':
        return validateObjectNamingTool(request, context);
      case 'verify_d365fo_project':
        return verifyD365ProjectTool(request, context);
      case 'get_workspace_info': {
        const args = (request as any).params?.arguments || {};
        const configManager = getConfigManager();

        // projectName: resolve by name from known projects list (user-friendly switch)
        if (args.projectName && !args.projectPath) {
          const needle = (args.projectName as string).toLowerCase();
          const allProjects = configManager.getAllDetectedProjects();
          const match = allProjects.find(p => p.modelName.toLowerCase() === needle)
            ?? allProjects.find(p => p.modelName.toLowerCase().includes(needle));
          if (!match) {
            const names = allProjects.map(p => p.modelName).join(', ') || '(none — set D365FO_SOLUTIONS_PATH)';
            return {
              content: [{ type: 'text', text: `❌ No project found matching "${args.projectName}".\nAvailable: ${names}` }],
              isError: true,
            };
          }
          args.projectPath = match.projectPath;
        }

        // projectPath: force-switch to specific .rnrproj
        if (args.projectPath) {
          const forced = await configManager.forceProject(args.projectPath);
          if (!forced) {
            return {
              content: [{ type: 'text', text: `❌ Could not read model name from: ${args.projectPath}\nMake sure the path points to a valid .rnrproj file.` }],
              isError: true,
            };
          }
        }

        const { modelName, modelSource, projectPath, projectSource, packagePath, packageSource } =
          await configManager.getWorkspaceInfoDiagnostics();
        const envType = await configManager.getDevEnvironmentType();

        // Prefix diagnostics
        const extensionPrefixEnv = process.env.EXTENSION_PREFIX?.trim() || null;
        const effectivePrefix = resolveObjectPrefix(modelName ?? '');

        const PLACEHOLDER_NAMES = new Set([
          'mymodel', 'mypackage', 'model', 'package', 'modelname', 'packagename',
          'yourmodel', 'yourpackage', 'custommodel', 'custompackage',
          'testmodel', 'testpackage', 'samplemodel', 'samplepackage',
          // Microsoft tutorial / demo models — these are shipped as sample code with D365FO
          // and should never be the target model for a new custom project.
          // If auto-detection lands on one of these it almost always means the developer
          // forgot to change the default model in the VS new-project wizard.
          'fleetmanagement', 'fleetmanagementextension',
          'fleetmanagementunittests', 'tutorial',
        ]);
        const isPlaceholder = !modelName || PLACEHOLDER_NAMES.has(modelName.toLowerCase());
        // Also flag when auto-detection found a Microsoft standard model name
        // that isn't in the PLACEHOLDER_NAMES set but is not a custom model.
        const { isCustomModel } = await import('../utils/modelClassifier.js');
        const isStandardMsModel = modelName
          ? !isCustomModel(modelName) && !isPlaceholder
          : false;

        const lines: string[] = [
          `## D365FO Workspace Configuration`,
          ``,
          `Model name      : ${modelName ?? '(not configured)'}  (source: ${modelSource})`,
          `Package path    : ${packagePath ?? '(not configured)'}  (source: ${packageSource})`,
          `Project path    : ${projectPath ?? '(not detected)'}  (source: ${projectSource})`,
          `Env type        : ${envType}`,
          ``,
          `## Prefix Configuration`,
          ``,
          `EXTENSION_PREFIX: ${extensionPrefixEnv ?? '(not set — falling back to model name)'}`,
          `Effective prefix: ${effectivePrefix || '(none)'}`,
          extensionPrefixEnv
            ? `✅ EXTENSION_PREFIX is set — all new objects will use prefix "${effectivePrefix}".`
            : `⚠️  EXTENSION_PREFIX is not set in the server environment. The model name "${modelName}" will be used as prefix. Add EXTENSION_PREFIX=MY (or your ISV prefix) to the .env file and restart the server.`,
          ``,
        ];

        if (isPlaceholder) {
          // Only scan .rnrproj files when model name looks like a placeholder — avoids
          // misleading "no .rnrproj files found" warnings when config is fully set up.
          const rawDetectedModel = await configManager.getRawAutoDetectedModelName();
          const detectedHint = rawDetectedModel
            ? `> ✅ Auto-detected from .rnrproj: **${rawDetectedModel}**\n` +
              `> Update your .mcp.json: set \`modelName\` to \`"${rawDetectedModel}"\``
            : `> ⚠️ No .rnrproj was found — make sure the MCP server is running in the right directory.`;
          lines.push(
            `⛔ CONFIGURATION PROBLEM — model name "${modelName}" is a placeholder, not a real D365FO model.`,
            ``,
            `**YOU MUST STOP** and tell the user:`,
            `> The configured model name "${modelName}" is a placeholder.`,
            detectedHint,
            `>`,
            `> Please check that:`,
            `> 1. The MCP server is running in the correct workspace directory`,
            `> 2. The .mcp.json / mcp.json file has the correct modelName`,
            `> 3. The projectPath points to a valid .rnrproj file`,
            `>`,
            `> Do you want to fix the configuration first, or continue with built-in tools (limited functionality)?`,
          );
        } else if (isStandardMsModel) {
          // Model was auto-detected from a .rnrproj whose <Model> tag points to a Microsoft
          // standard model. This almost always means the developer created a new VS project
          // and forgot to change the default model name in the project wizard (D365FO VS
          // extension defaults to "FleetManagement" in new-project dialogs).
          const allProj = configManager.getAllDetectedProjects();
          const customCandidates = allProj.filter(p => isCustomModel(p.modelName));
          const hint = customCandidates.length > 0
            ? `Available custom models: ${customCandidates.map(p => p.modelName).join(', ')}\n` +
              `Switch with: get_workspace_info(projectName="<model>")`
            : `No custom models found under D365FO_SOLUTIONS_PATH. Check your project configuration.`;
          lines.push(
            `⛔ CONFIGURATION PROBLEM — model name "${modelName}" is a Microsoft standard/demo model, not a custom model.`,
            ``,
            `**YOU MUST STOP** and tell the user:`,
            `> The auto-detected model "${modelName}" is a Microsoft standard model.`,
            `> This usually happens when a new VS project was created and the default model`,
            `> in the project wizard ("FleetManagement") was not changed to the correct custom model.`,
            `>`,
            `> How to fix:`,
            `> 1. In Visual Studio, open the .rnrproj file and change <Model>FleetManagement</Model>`,
            `>    to the correct model name (e.g. <Model>AslCore</Model>).`,
            `> 2. OR explicitly switch to a known project:`,
            `>    ${hint}`,
            `> 3. OR add the correct modelName to .mcp.json.`,
          );
        } else {
          lines.push(`✅ Configuration looks valid. Proceed with D365FO operations using model "${modelName}".`);
          const customModels = context.symbolIndex.getCustomModels?.() ?? [];
          if (customModels.length > 0) {
            lines.push(`Custom models in index: ${customModels.join(', ')}`);
          }
        }

        // List all projects found under D365FO_SOLUTIONS_PATH so the user can switch
        const allProjects = configManager.getAllDetectedProjects();
        if (allProjects.length > 1) {
          lines.push(``);
          lines.push(`## Available Projects (D365FO_SOLUTIONS_PATH)`);
          lines.push(``);
          for (const p of allProjects) {
            const active = p.projectPath === projectPath ? '▶ ' : '  ';
            lines.push(`${active}${p.modelName.padEnd(40)} ${p.projectPath}`);
          }
          lines.push(``);
          lines.push(`To switch project: call get_workspace_info with projectName = "<ModelName>"`);
        }

        // -----------------------------------------------------------------------
        // Stdio session info — what VS 2022 sent during the MCP handshake
        // Populated by the stdin sniffer in index.ts (always active in stdio mode).
        // -----------------------------------------------------------------------
        const sio = getStdioSessionInfo();
        lines.push(``);
        lines.push(`## Stdio Session Info`);
        lines.push(``);
        if (!sio.initializedAt) {
          lines.push(`_Not in stdio mode (or initialize not yet received)._`);
        } else {
          lines.push(`Client name     : ${sio.clientName    ?? '(not sent)'}`);
          lines.push(`Client version  : ${sio.clientVersion ?? '(not sent)'}`);
          lines.push(`MCP protocol    : ${sio.protocolVersion ?? '(not sent)'}`);
          lines.push(`Roots listChanged cap: ${sio.supportsRootsListChanged ? 'yes ✅' : 'no ❌'}`);
          lines.push(`Initialize at   : ${sio.initializedAt}`);
          lines.push(``);
          if (sio.lastRoots.length === 0) {
            lines.push(`Roots (last roots/list): _none received yet_`);
          } else {
            lines.push(`Roots (last roots/list) @ ${sio.rootsLastAt}:`);
            sio.lastRoots.forEach((u, i) => lines.push(`  [${i}] ${u}`));
          }
          lines.push(``);
          if (sio.rootsListChangedCount === 0) {
            lines.push(`roots/list_changed events: 0 (VS 2022 has NOT changed solution since startup)`);
            if (sio.supportsRootsListChanged) {
              lines.push(`  ℹ️  Client declared roots.listChanged=true — it WILL send this notification`);
              lines.push(`     when you open/switch a solution. Switch now and call get_workspace_info again.`);
            } else {
              lines.push(`  ⚠️  Client did NOT declare roots.listChanged capability — automatic`);
              lines.push(`     solution-switch detection may not be available.`);
            }
          } else {
            lines.push(`roots/list_changed events: ${sio.rootsListChangedCount} ✅`);
            lines.push(`Last change at  : ${sio.rootsListChangedLastAt}`);
            lines.push(`✅ VS 2022 IS sending roots/list_changed — solution switching IS detectable.`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${toolName}`,
            },
          ],
          isError: true,
        };
    } })();

    return capToolResponse(toolName, result);
  });
}
