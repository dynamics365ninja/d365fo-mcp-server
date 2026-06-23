import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import { SERVER_MODE, LOCAL_TOOLS } from '../server/serverMode.js';
import { searchUnifiedTool } from './searchUnified.js';
import { batchGetInfoTool } from './batchGetInfo.js';
import { getObjectInfoTool } from './getObjectInfo.js';
import { findReferencesTool } from './findReferences.js';
import { getMethodTool } from './getMethod.js';
import { analyzeCodeTool } from './analyzeCode.js';
import { d365foFileTool } from './d365foFile.js';
import { labelsTool } from './labels.js';
import { objectPatternsTool } from './objectPatterns.js';
import { generateObjectTool } from './generateObject.js';
import { handleSuggestEdt } from './suggestEdt.js';
import { securityInfoTool } from './securityInfo.js';
import { extensionInfoTool } from './extensionInfo.js';
import { getKnowledgeTool } from './getKnowledge.js';
import { validateObjectNamingTool } from './validateObjectNaming.js';
import { verifyD365ProjectTool } from './verifyD365Project.js';
import { resolveObjectPrefix, isCustomModel, getObjectSuffix, getExtensionNamingStyle, deriveExtensionInfix } from '../utils/modelClassifier.js';
import { getStdioSessionInfo } from '../utils/stdioSessionInfo.js';
import { updateSymbolIndexTool } from './updateSymbolIndex.js';
import { buildProjectTool } from './buildProject.js';
import { dbSyncTool } from './dbSync.js';
import { runBpCheckTool } from './runBpCheck.js';
import { sysTestRunnerTool } from './sysTestRunner.js';
import { reviewWorkspaceChangesTool } from './reviewWorkspaceChanges.js';
import { undoLastModificationTool } from './undoLastModification.js';
import { validateCodeTool } from './validateCode.js';
import { prepareTool } from './prepare.js';
import { recordToolStart, startMetricsLogging, recordCallSequence } from '../utils/toolMetrics.js';
import {
  DEDUP_EXCLUDED_TOOLS, DEDUP_TTL_MS,
  dedupKey, getDedupedResult, storeDedupResult, appendNote,
} from '../utils/callDedup.js';
import { checkIndexStaleness } from '../utils/indexStaleness.js';
import { buildContextSnapshot, renderContextSnapshotSection } from '../workspace/contextSnapshot.js';
import * as nodePath from 'path';
import { buildProgressMessage } from '../utils/toolProgressMessage.js';

/**
 * Extract workspace path from GitHub Copilot _meta.
 * Stdio requests use this to seed the shared runtime context.
 * HTTP requests already run inside AsyncLocalStorage request scope and must not
 * overwrite the shared runtime context, otherwise concurrent users can bleed
 * workspace state into each other.
 */
function extractWorkspaceFromMeta(meta: any): string | null {
  if (!meta) return null;

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

  if (!rawUri) return null;

  // Convert file:// URI → local path
  let localPath = rawUri;
  if (rawUri.startsWith('file:///')) {
    localPath = decodeURIComponent(rawUri.slice('file:///'.length)).replace(/\//g, '\\');
  } else if (rawUri.startsWith('file://')) {
    localPath = decodeURIComponent(rawUri.slice('file://'.length)).replace(/\//g, '\\');
  }

  return localPath;
}

/**
 * Centralized tool handler that dispatches to individual tool implementations
 */

/** Per-tool response cap sizes. 'uncapped' = no truncation. */
const TOOL_CAP_SIZES: Record<string, number | 'uncapped'> = {
  // Uncapped — XML generation, file writes, or long structured output
  generate_object:                  'uncapped',
  d365fo_file:                      'uncapped',
  // get_object_info can return reports (RDL) and full class bodies — never truncate
  get_object_info:                  'uncapped',
  // Method source must never be truncated — partial code is useless
  get_method:                       'uncapped',
  // New tools with longer output
  security_info:                    8000,
  // extensibility merges the former table-extension/extension-point/strategy/
  // coc/event-handler tools — keep the most generous of their old caps
  extension_info:                   6000,
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
  // Start periodic metrics logging (every 5 min to stderr)
  startMetricsLogging();

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const configManager = getConfigManager();

    // Extract workspace path from _meta (GitHub Copilot injects workspace context here)
    // This is a secondary extraction path — transport.ts does the primary one from HTTP headers.
    // In stdio mode there is no transport-level request context, so we persist the detected
    // workspace on the shared runtimeContext. In HTTP mode we intentionally avoid mutating
    // runtimeContext because the transport already isolates workspace per request.
    const workspacePath =
      extractWorkspaceFromMeta((request as any).params?._meta) ??
      extractWorkspaceFromMeta((request.params as any)._meta);
    if (workspacePath && !configManager.hasRequestContext()) {
      configManager.setRuntimeContext({ workspacePath });
    }

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

    // ── Loop detection + duplicate-call dedup ────────────────────────────────
    const callKey = dedupKey(toolName, request.params.arguments);
    const occurrences = recordCallSequence(toolName, callKey);
    if (!DEDUP_EXCLUDED_TOOLS.has(toolName)) {
      const cached = getDedupedResult(callKey);
      if (cached !== undefined) {
        console.error(`[toolHandler] ♻️  ${toolName}: identical call within ${DEDUP_TTL_MS / 1000}s — served from dedup cache`);
        return appendNote(
          cached,
          `> ♻️ Duplicate call — this exact ${toolName} call was answered moments ago; ` +
          `the result above is identical. Use the data you already have instead of re-querying.`,
        );
      }
    }

    const finishMetrics = recordToolStart(toolName);
    let result: any;
    try {
    result = await (async () => {
      // Build the progress description for this tool call.
      const args = request.params.arguments as Record<string, any> | undefined;
      const progressMsg = buildProgressMessage(toolName, args);

      // ── Channel 1: notifications/progress (request-scoped) ──────────────────
      // If the client sent a progressToken in _meta, it supports in-band progress
      // notifications (MCP spec §Progress). We send one immediately so the client
      // can show a spinner / status text while the tool runs.
      // GitHub Copilot / VS2026 will render this as inline progress once they
      // implement the spec — the server side is already ready.
      const progressToken = (extra._meta as any)?.progressToken;
      if (progressToken !== undefined && progressToken !== null) {
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: 0,
              total: 1,
              message: progressMsg,
            } as any,
          });
        } catch {
          // Non-fatal — client may not support progress notifications
        }
      }

      // ── Channel 2: notifications/message (logging) ───────────────────────────
      // Fallback for clients that do not send progressToken but do consume log
      // notifications (e.g. MCP Inspector, Claude Desktop). Requires logging
      // capability declared in mcpServer.ts. Silently ignored in HTTP mode.
      try {
        await server.sendLoggingMessage({
          level: 'info',
          data: progressMsg,
        });
      } catch {
        // Non-fatal — logging is best-effort, never block the tool
      }

      return (async () => { switch (toolName) {
      case 'search':
        return searchUnifiedTool(request, context);
      case 'batch_get_info':
        return batchGetInfoTool(request, context);
      case 'get_object_info':
        return getObjectInfoTool(request, context);
      case 'generate_object':        return generateObjectTool(request, context);
      case 'analyze_code':
        return analyzeCodeTool(request, context);
      case 'd365fo_file':
        return d365foFileTool(request, context);
      case 'find_references':
        return findReferencesTool(request, context);
      case 'get_method':
        return getMethodTool(request, context);
      case 'labels':
        return labelsTool(request, context);
      case 'object_patterns':        return objectPatternsTool(request, context);
      case 'suggest_edt': {
        const r = await handleSuggestEdt(
          request.params.arguments as any,
          context.symbolIndex
        );
        return { content: r?.content ?? [{ type: 'text', text: 'No results returned' }] };
      }
      case 'security_info':
        return securityInfoTool(request, context);
      case 'extension_info':        return extensionInfoTool(request, context);
      case 'validate_object_naming':
        return validateObjectNamingTool(request, context);
      case 'verify_d365fo_project':
        return verifyD365ProjectTool(request, context);
      case 'update_symbol_index':
        return await updateSymbolIndexTool(request.params.arguments as any, context);
      case 'build_d365fo_project':
        return await buildProjectTool(request.params.arguments as any, context);
      case 'trigger_db_sync':
        return await dbSyncTool(request.params.arguments as any, context);
      case 'run_bp_check':
        return await runBpCheckTool(request.params.arguments as any, context);
      case 'run_systest_class':
        return await sysTestRunnerTool(request.params.arguments as any, context);
      case 'review_workspace_changes':
        return await reviewWorkspaceChangesTool(request.params.arguments as any, context);
      case 'undo_last_modification':
        return await undoLastModificationTool(request.params.arguments as any, context);
      case 'get_knowledge':
        return getKnowledgeTool(request);
      case 'validate_code':        return validateCodeTool(request, context);
      case 'prepare':
        return prepareTool(request, context);
      case 'get_workspace_info': {
        const args = (request as any).params?.arguments || {};

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

        const {
          modelName, modelSource, isModelSourceAutoDetected,
          projectPath, projectSource,
          packagePath, packageSource,
          customPackagesPath, customPackagesSource,
        } = await configManager.getWorkspaceInfoDiagnostics();
        const envType = await configManager.getDevEnvironmentType();
        const frameworkDirectory = await configManager.getMicrosoftPackagesPath();

        // Prefix diagnostics
        const extensionPrefixEnv = process.env.EXTENSION_PREFIX?.trim() || null;
        const effectivePrefix = resolveObjectPrefix(modelName ?? '');
        const objectSuffixEnv = process.env.EXTENSION_SUFFIX?.trim() || null;
        const effectiveSuffix = getObjectSuffix();

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
        // The "Microsoft standard model" warning only makes sense for an AUTO-DETECTED
        // model: its whole premise is that a .rnrproj scan landed on a standard/demo
        // model because the developer forgot to change the VS new-project wizard default.
        // An explicitly configured model (D365FO_MODEL_NAME env var or a modelName key
        // in .mcp.json) was named deliberately, so second-guessing it produces false
        // positives — e.g. a model whose ISV prefix is only an abbreviation of its name.
        const isAutoDetectedSource = isModelSourceAutoDetected;
        // Also flag when auto-detection found a Microsoft standard model name
        // that isn't in the PLACEHOLDER_NAMES set but is not a custom model.
        const isStandardMsModel = modelName
          ? !isCustomModel(modelName) && !isPlaceholder && isAutoDetectedSource
          : false;

        // Determine the effective custom write root for display and freshness check.
        // Precedence: D365FO_CUSTOM_PACKAGES_PATH > D365FO_PACKAGE_PATH (read-only MS root).
        const effectiveWritePath = customPackagesPath ?? packagePath;
        const effectiveWriteSource = customPackagesPath ? customPackagesSource : packageSource;

        // The MS framework path shown in diagnostics: prefer the explicit
        // D365FO_MICROSOFT_PACKAGES_PATH; fall back to the bridge frameworkDirectory;
        // in a single-root traditional setup neither is set so omit the line.
        const msFrameworkPath = frameworkDirectory ?? (!customPackagesPath ? null : packagePath);

        const lines: string[] = [
          `## D365FO Workspace Configuration`,
          ``,
          `Model name      : ${modelName ?? '(not configured)'}  (source: ${modelSource})`,
          `Custom write path: ${effectiveWritePath ?? '(not configured)'}  (custom metadata, source: ${effectiveWriteSource})`,
          `Framework dir   : ${msFrameworkPath ?? '(not applicable — single-root setup)'}  (Microsoft metadata, read-only)`,
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
          `## Suffix Configuration`,
          ``,
          `EXTENSION_SUFFIX: ${objectSuffixEnv ?? '(not set)'}`,
          `Effective suffix: ${effectiveSuffix || '(none)'}`,
          effectiveSuffix
            ? `✅ EXTENSION_SUFFIX is set — new objects will have suffix "${effectiveSuffix}" appended (e.g. MyTable${effectiveSuffix}).`
            : `ℹ️  EXTENSION_SUFFIX is not set. No suffix will be applied. This is normal — most projects use prefixes only.`,
          ``,
        ];

        // ── Extension naming style ────────────────────────────────────────────
        // The prefix doubles as the extension infix UNLESS EXTENSION_NAMING_STYLE
        // is set to "model-name", in which case extension elements/classes embed the
        // MODEL NAME (Visual Studio default). The tool ALWAYS normalises the extension
        // token to whatever this style dictates — so pass the BASE object name and let
        // the tool name it; do not hand-build the infix yourself.
        const extNamingStyle = getExtensionNamingStyle();
        const extInfix = deriveExtensionInfix(effectivePrefix);
        const sampleClassExt = extNamingStyle === 'model-name' && modelName
          ? `CustTable_${modelName}_Extension`
          : `CustTable${extInfix}_Extension`;
        const sampleElemExt = extNamingStyle === 'model-name' && modelName
          ? `CustTable.${modelName}`
          : `CustTable.${extInfix}Extension`;
        lines.push(
          `## Extension Naming`,
          ``,
          `EXTENSION_NAMING_STYLE: ${process.env.EXTENSION_NAMING_STYLE?.trim() || '(not set → "prefix")'}`,
          extNamingStyle === 'model-name'
            ? `✅ model-name style — extension token is the MODEL NAME (Visual Studio default).`
            : `ℹ️  prefix style (default) — extension token is the EXTENSION_PREFIX infix.`,
          `  • Extension class  → ${sampleClassExt}`,
          `  • Element extension → ${sampleElemExt}`,
          `  ⚠️  Pass the BASE object name (e.g. "CustTable") to d365fo_file(action="create") and let the tool apply the token — any infix you embed will be normalised to the above.`,
          ``,
        );

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
            `>    to the correct model name (e.g. <Model>ContosoCore</Model>).`,
            `> 2. OR explicitly switch to a known project:`,
            `>    ${hint}`,
            `> 3. OR add the correct modelName to .mcp.json.`,
          );
        } else {
          lines.push(`✅ Configuration looks valid. Proceed with D365FO operations using model "${modelName}".`);
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
        // Index freshness — compare workspace mtimes vs last_indexed_at so the
        // model (and user) know whether symbol lookups reflect current code.
        // -----------------------------------------------------------------------
        try {
          const lastIndexedAt = context.symbolIndex.getLastIndexedAt?.() ?? null;
          const modelMetadataDir = effectiveWritePath && modelName
            ? nodePath.join(effectiveWritePath, modelName)
            : null;
          const staleness = checkIndexStaleness(lastIndexedAt, modelMetadataDir);
          lines.push('', ...staleness.lines);
        } catch {
          // Freshness reporting is best-effort — never break get_workspace_info
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

        // -----------------------------------------------------------------------
        // Context Snapshot — curated "what am I working on" view: recently edited
        // objects + uncommitted X++ changes. Best-effort; never breaks the tool.
        // -----------------------------------------------------------------------
        try {
          const snapshot = await buildContextSnapshot(context);
          lines.push('', ...renderContextSnapshotSection(snapshot));
        } catch {
          // Snapshot is additive — omit silently on failure.
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
    })();
    } catch (err) {
      // Central safety net: convert ANY thrown error (incl. zod validation,
      // bridge failures, unexpected exceptions) into a proper tool result with
      // isError:true so the agent SEES the failure and can react/retry, instead
      // of it surfacing as an opaque JSON-RPC protocol error. Individual tools
      // may still return their own richer isError messages; this only catches
      // what escapes them.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[toolHandler] ❌ ${toolName} threw: ${message}`);
      result = {
        content: [{ type: 'text', text: `❌ ${toolName} failed: ${message}` }],
        isError: true,
      };
    }

    let capped = capToolResponse(toolName, result);
    // Record metrics: detect empty result (no content or first text item is empty)
    const firstText = capped?.content?.[0]?.text;
    const isEmpty = !firstText || firstText.trim().length === 0 || firstText === 'No results returned';
    finishMetrics(isEmpty);

    if (!DEDUP_EXCLUDED_TOOLS.has(toolName)) {
      storeDedupResult(callKey, capped);
      // Loop hint: 3+ identical calls in the recent window means the model is
      // cycling (cache misses only happen when calls are >60 s apart).
      if (occurrences >= 3) {
        capped = appendNote(
          capped,
          `> ⚠️ Loop detected: this is occurrence #${occurrences} of the exact same ${toolName} call. ` +
          `The answer does not change between calls. If you are missing information, ` +
          `use a DIFFERENT tool or different parameters (see suggestions above), or ask the user.`,
        );
      }
    }
    return capped;
  });
}
