import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import {
  SERVER_MODE, LOCAL_TOOLS, TOOL_PROFILE,
  isToolAllowedInMode, isToolInProfile,
} from '../server/serverMode.js';
import { BRIDGE_BACKED_TOOLS, awaitBridgeReady } from '../bridge/bridgeReadiness.js';
import {
  BRIDGE_FAILURE_MARKER, runWithBridgeFailureScope, renderBridgeFailureNote,
} from '../bridge/bridgeFailure.js';
import type { BridgeFailure } from '../bridge/bridgeFailure.js';
import * as debouncedRefresh from '../bridge/debouncedRefresh.js';
import { searchUnifiedTool } from './analysis/searchUnified.js';
import { getObjectInfoTool } from './readers/getObjectInfo.js';
import { findReferencesTool } from './analysis/findReferences.js';
import { getMethodTool } from './readers/getMethod.js';
import { analyzeCodeTool } from './analysis/analyzeCode.js';
import { d365foFileTool } from './d365foFile.js';
import { labelsTool } from './labels.js';
import { objectPatternsTool } from './knowledge/objectPatterns.js';
import { generateObjectTool } from './generateObject.js';
import { handleSuggestEdt } from './smart/suggestEdt.js';
import { securityInfoTool } from './readers/securityInfo.js';
import { extensionInfoTool } from './readers/extensionInfo.js';
import { getKnowledgeTool } from './knowledge/getKnowledge.js';
import { validateObjectNamingTool } from './analysis/validateObjectNaming.js';
import { verifyD365ProjectTool } from './sdlc/verifyD365Project.js';
import { updateSymbolIndexTool } from './sdlc/updateSymbolIndex.js';
import { buildProjectTool } from './sdlc/buildProject.js';
import { dbSyncTool } from './sdlc/dbSync.js';
import { runBpCheckTool } from './sdlc/runBpCheck.js';
import { sysTestRunnerTool } from './sdlc/sysTestRunner.js';
import { reviewWorkspaceChangesTool } from './sdlc/reviewWorkspaceChanges.js';
import { undoLastModificationTool } from './sdlc/undoLastModification.js';
import { validateCodeTool } from './analysis/validateCode.js';
import { prepareTool } from './prepare/prepare.js';
import { getWorkspaceInfoTool } from './readers/getWorkspaceInfo.js';
import { recordToolStart, startMetricsLogging, recordCallSequence, reportSlowCall } from '../utils/toolMetrics.js';
import {
  DEDUP_EXCLUDED_TOOLS, DEDUP_TTL_MS,
  dedupKey, getDedupedResult, storeDedupResult, appendNote,
  getInFlight, registerInFlight, clearInFlight,
} from '../utils/callDedup.js';
import { truncateOnBlockBoundary } from '../utils/payloadBudget.js';
import { buildProgressMessage } from '../utils/toolProgressMessage.js';
import { createProgressReporter } from '../utils/progressReporter.js';


/**
 * Extract workspace path from GitHub Copilot _meta.
 * HTTP requests must not overwrite the shared runtimeContext (AsyncLocalStorage
 * already isolates per-request state there) — only stdio uses this path.
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
  get_object_info:                  'uncapped', // can return reports (RDL) and full class bodies
  get_method:                       'uncapped', // partial method source is useless
  build_d365fo_project:             'uncapped', // compiler errors can appear late in long logs
  security_info:                    8000,
  extension_info:                   6000,
  // Default output is ~1 KB. The higher cap exists for diagnostics=true, whose
  // whole point is the full dump — truncating that at 5000 hid the stdio
  // handshake section behind the project table.
  get_workspace_info:               20000,
  default:                          5000,
};

function getCapForTool(toolName: string): number | 'uncapped' {
  return TOOL_CAP_SIZES[toolName] ?? TOOL_CAP_SIZES['default'];
}


export function capToolResponse(toolName: string, result: any): any {
  const cap = getCapForTool(toolName);
  if (cap === 'uncapped' || !result?.content) return result;
  const content = result.content.map((item: any) => {
    if (item.type !== 'text' || typeof item.text !== 'string') return item;
    if (item.text.length <= (cap as number)) return item;
    // Cut on a block boundary: a raw slice ended responses mid-XML-element
    // (`<AxTableField Nam`), which reads as corrupt metadata, not truncated.
    const kept = truncateOnBlockBoundary(item.text, cap as number);
    return {
      ...item,
      // The advice used to say `compact=false`, which makes the response BIGGER
      // — the caller followed it and hit the cap again with more content cut.
      text: kept +
        `\n\n> ✂️ Response truncated at ${cap} chars (${item.text.length - kept.length} omitted). ` +
        `Ask for LESS, not more: page with methodOffset/fieldsOffset, narrow with fieldFilter/searchControl/prefix, ` +
        `keep compact=true, and read one object per call instead of objects[].`,
    };
  });
  return { ...result, content };
}

export function registerToolHandler(server: Server, context: XppServerContext): void {
  startMetricsLogging();

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const configManager = getConfigManager();

    // Secondary extraction path (transport.ts does the primary one from HTTP headers).
    // Only persist to shared runtimeContext when there's no request-scoped context (stdio mode).
    const workspacePath =
      extractWorkspaceFromMeta((request as any).params?._meta) ??
      extractWorkspaceFromMeta((request.params as any)._meta);
    if (workspacePath && !configManager.hasRequestContext()) {
      configManager.setRuntimeContext({ workspacePath });
    }

    // The C# bridge starts out-of-band, so the tool list can be live while
    // `context.bridge` is still undefined. Wait for a startup that is in flight
    // before the tool decides anything — otherwise a 2-second cold-start race is
    // reported as "the object does not exist" / "check your config" (issue #826).
    // Started here, awaited after the dbReady block, so the two waits overlap and
    // a cold start costs max(db, bridge) rather than their sum.
    const bridgeWait = BRIDGE_BACKED_TOOLS.has(toolName)
      ? { t0: Date.now(), outcome: awaitBridgeReady(context) }
      : null;

    // ctx.dbReady resolves once the real symbol database is loaded; await it so
    // tools use the real index instead of silently returning empty results.
    // LOCAL_TOOLS need no DB (filesystem/in-memory config only) and skip the wait.
    if (context.dbReady && !LOCAL_TOOLS.has(toolName)) {
      const t0 = Date.now();
      // Race dbReady against a 55-second timeout so VS Code's ~60 s client
      // timeout doesn't silently cancel the request. If the DB is still loading
      // after 55 s, return an informative message instead of hanging forever.
      const DB_WAIT_TIMEOUT_MS = 55_000;
      const timeoutPromise = new Promise<'timeout'>(resolve =>
        setTimeout(() => resolve('timeout'), DB_WAIT_TIMEOUT_MS),
      );
      const result = await Promise.race([
        context.dbReady.then(() => 'ready' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        return {
          content: [{
            type: 'text',
            text: `⏳ The MCP server is still loading the X++ symbol database (takes 30–90 s on first start). Please retry the request in a few seconds.`,
          }],
          isError: true,
        };
      }
      const elapsed = Date.now() - t0;
      if (elapsed > 200) {
        console.error(`[toolHandler] ⏳ ${toolName}: DB was loading, waited ${elapsed} ms`);
      }
    }

    // Collect the bridge wait started above. Every outcome falls through to the
    // tool: `ready` is the point of the wait, `unavailable`/`not-tracked` mean
    // the symbol-index and disk fallbacks are the answer, and even on `timeout`
    // the tool may still resolve the object from the index — it just gets to
    // describe the bridge as "still starting" instead of "not connected".
    if (bridgeWait) {
      const outcome = await bridgeWait.outcome;
      const elapsed = Date.now() - bridgeWait.t0;
      if (elapsed > 200) {
        console.error(`[toolHandler] ⏳ ${toolName}: bridge was starting, waited ${elapsed} ms → ${outcome}`);
      }

      // Settle any provider rebuild a previous write scheduled but did not wait
      // for. Writers now schedule the rebuild instead of awaiting it (so it
      // leaves the response path), which means the freshness guarantee has to be
      // re-established by the READER — otherwise a get_object_info issued right
      // after a create could see a provider up to SETTLE_MS staler than before.
      // Every bridge-backed tool passes through here, so this is the one place
      // that covers reads and writes alike; it is a synchronously-resolved
      // no-op when nothing is outstanding, so it costs a tick, not 400 ms.
      await debouncedRefresh.flush();
    }

    // Enforce server mode: block local tools in read-only (Azure) mode, block search/analysis
    // tools in write-only mode. isToolAllowedInMode is the same predicate the ListTools filter
    // uses (ALWAYS_TOOLS included), so a tool is refused here iff it is not advertised.
    if (SERVER_MODE === 'read-only' && !isToolAllowedInMode(SERVER_MODE, toolName)) {
      return {
        content: [{ type: 'text', text: `⚠️ Tool '${toolName}' requires local Windows VM filesystem access and is not available in read-only mode.\n\nThis MCP server is running in read-only mode (Azure deployment).\nTo use file operations and workspace diagnostics, configure a local MCP server with MCP_SERVER_MODE=write-only in your .mcp.json.\n\nSee: https://github.com/dynamics365ninja/d365fo-mcp-server/blob/main/docs/MCP_CONFIG.md` }],
        isError: true,
      };
    }
    if (SERVER_MODE === 'write-only' && !isToolAllowedInMode(SERVER_MODE, toolName)) {
      return {
        content: [{ type: 'text', text: `⚠️ Tool '${toolName}' is not available in write-only mode.\n\nThis local MCP server only handles file operations. Search and analysis tools are provided by the Azure MCP server.` }],
        isError: true,
      };
    }
    // Breadth gate: the tool exists but this server runs the reduced 'core'
    // profile, so it was never advertised. Name the two ways back in — an
    // unexplained refusal just gets retried.
    if (!isToolInProfile(TOOL_PROFILE, toolName)) {
      return {
        content: [{ type: 'text', text: `⚠️ Tool '${toolName}' is not published under MCP_TOOL_PROFILE=core.\n\nTo enable it, set MCP_TOOL_PROFILE=full, or add it to MCP_EXTRA_TOOLS (server.extraTools in d365fo-mcp.json) and restart the server.` }],
        isError: true,
      };
    }

    // Loop detection + duplicate-call dedup
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
      // In-flight dedup: coalesce onto an identical call that's already executing.
      const inFlight = getInFlight(callKey);
      if (inFlight) {
        console.error(`[toolHandler] ⏳ ${toolName}: identical call already in-flight — coalescing`);
        const inFlightResult = await inFlight;
        return appendNote(
          inFlightResult,
          `> ♻️ Parallel duplicate — coalesced with a concurrent identical call.`,
        );
      }
    }

    // Register this call as in-flight so concurrent duplicates can coalesce.
    const inFlightHandle = !DEDUP_EXCLUDED_TOOLS.has(toolName)
      ? registerInFlight(callKey)
      : null;

    const finishMetrics = recordToolStart(toolName);
    const callStartedAt = Date.now();
    let result: any;
    // Anything the C# bridge throws during this call lands here (see
    // bridge/bridgeFailure.ts). Without it a bridge outage is invisible: the read
    // wrappers return null, the tool serves the SQLite index instead, and the
    // answer — including "not found" — looks like it came from live metadata.
    const bridgeFailures: BridgeFailure[] = [];
    try {
    result = await runWithBridgeFailureScope(bridgeFailures, async () => {
      // Build the progress description for this tool call.
      const args = request.params.arguments as Record<string, any> | undefined;
      const progressMsg = buildProgressMessage(toolName, args);

      // Both notification channels (notifications/progress when the client
      // supplied a progressToken, notifications/message otherwise) live in one
      // reporter so long-running tools can keep using it after this first step.
      const reportProgress = createProgressReporter(server, extra as any);
      await reportProgress(progressMsg, 0);

      return (async () => { switch (toolName) {
      case 'search':
        return searchUnifiedTool(request, context);
      case 'get_object_info':
        return getObjectInfoTool(request, context);
      case 'generate_object':        return generateObjectTool(request, context);
      case 'analyze_code':
        return analyzeCodeTool(request, context);
      case 'd365fo_file':
        return d365foFileTool(request, context);
      case 'find_references':
        return findReferencesTool(request, context);
      // get_method and suggest_edt are no longer PUBLISHED (their contracts moved
      // into get_object_info options.method and prepare's fieldsHint, which both
      // already had the object in hand). The routes stay so an agent still holding
      // the old name from an earlier session gets its answer plus a pointer,
      // rather than an "unknown tool" it cannot recover from.
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
        // Streams progress while xppc runs, so a build longer than any timeout
        // still completes inside this one call instead of handing back a stub.
        return await buildProjectTool(request.params.arguments as any, context, reportProgress);
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
      case 'get_workspace_info':
        return getWorkspaceInfoTool(request, context);
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
    });
    } catch (err) {
      // Safety net: convert any thrown error into a tool result with isError:true
      // instead of an opaque JSON-RPC protocol error.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[toolHandler] ❌ ${toolName} threw: ${message}`);
      result = {
        content: [{ type: 'text', text: `❌ ${toolName} failed: ${message}` }],
        isError: true,
      };
    }

    // Everything from here on runs under try/finally, because the in-flight entry
    // MUST be settled and dropped no matter what. A throw in capToolResponse (or in
    // the metrics/dedup bookkeeping) used to skip resolve()+clearInFlight, leaving a
    // promise in the map that nothing would ever settle — and from that moment every
    // identical call coalesced onto it and hung forever, for the life of the process.
    let capped: any = result;
    try {
      capped = capToolResponse(toolName, result);

      // Appended after the cap so truncation can never eat the one line that says the
      // answer is not authoritative. Skipped when the tool already named the failure
      // itself (the create/resolve path does) so the response says it once.
      if (bridgeFailures.length > 0) {
        const alreadyReported = capped?.content?.some(
          (item: any) => typeof item?.text === 'string' && item.text.includes(BRIDGE_FAILURE_MARKER),
        );
        if (!alreadyReported) {
          capped = appendNote(capped, renderBridgeFailureNote(bridgeFailures));
        }
      }

      // Record metrics: detect empty result (no content or first text item is empty)
      const firstText = capped?.content?.[0]?.text;
      const isEmpty = !firstText || firstText.trim().length === 0 || firstText === 'No results returned';
      finishMetrics(isEmpty);
      reportSlowCall(toolName, Date.now() - callStartedAt, request.params.arguments);

      if (!DEDUP_EXCLUDED_TOOLS.has(toolName)) {
        storeDedupResult(callKey, capped);
        // Loop hint: 3+ identical calls in the recent window means the model is cycling.
        if (occurrences >= 3) {
          capped = appendNote(
            capped,
            `> ⚠️ Loop detected: this is occurrence #${occurrences} of the exact same ${toolName} call. ` +
            `The answer does not change between calls. If you are missing information, ` +
            `use a DIFFERENT tool or different parameters (see suggestions above), or ask the user.`,
          );
        }
      }
    } catch (err) {
      // The tool itself already succeeded; only the post-processing failed. Return
      // the uncapped result rather than converting a good answer into an error.
      console.error(`[toolHandler] ⚠️ ${toolName}: response post-processing failed: ${err}`);
      capped = result;
    } finally {
      inFlightHandle?.resolve(capped);
      clearInFlight(callKey);
    }
    return capped;
  });
}
