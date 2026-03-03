import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import { SERVER_MODE, WRITE_TOOLS } from '../server/serverMode.js';
import { searchTool } from './search.js';

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
  default:                          3500,
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

    // Enforce server mode: block write tools in read-only mode, block read tools in write-only mode
    if (SERVER_MODE === 'read-only' && WRITE_TOOLS.has(toolName)) {
      return {
        content: [{ type: 'text', text: `⚠️ Tool '${toolName}' requires local Windows VM file system access and is not available in read-only mode.\n\nThis MCP server is running in read-only mode (Azure deployment).\nTo use file operations, configure a local MCP server with MCP_SERVER_MODE=write-only in your .mcp.json.\n\nSee: https://github.com/dynamics365ninja/d365fo-mcp-server/blob/main/docs/MCP_CONFIG.md` }],
        isError: true,
      };
    }
    if (SERVER_MODE === 'write-only' && !WRITE_TOOLS.has(toolName)) {
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
