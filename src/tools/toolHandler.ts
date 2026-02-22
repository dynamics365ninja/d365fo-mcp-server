import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
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
import { searchLabelsTool } from './searchLabels.js';
import { getLabelInfoTool } from './getLabelInfo.js';
import { createLabelTool } from './createLabel.js';

/**
 * Centralized tool handler that dispatches to individual tool implementations
 */
export function registerToolHandler(server: Server, context: XppServerContext): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    // Extract workspace path from _meta (GitHub Copilot injects workspace context here)
    // This is a secondary extraction path — transport.ts does the primary one from HTTP headers.
    // Having it here ensures it also works when transport-level extraction missed it.
    extractAndApplyWorkspaceFromMeta((request as any).params?._meta);
    extractAndApplyWorkspaceFromMeta((request.params as any)._meta);

    switch (toolName) {
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
      case 'search_labels':
        return searchLabelsTool(request, context);
      case 'get_label_info':
        return getLabelInfoTool(request, context);
      case 'create_label':
        return createLabelTool(request, context);
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
    }
  });
}
