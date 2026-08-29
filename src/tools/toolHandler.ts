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
import {
  runWithSideEffectScope, renderSideEffectNote, type WriteSideEffect,
} from '../utils/writeSideEffects.js';
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
import { recordToolStart, startMetricsLogging, recordCallSequence, occurrencesInEpoch, reportSlowCall } from '../utils/toolMetrics.js';
import {
  DEDUP_EXCLUDED_TOOLS, DEDUP_TTL_MS,
  dedupKey, getDedupedResult, storeDedupResult, appendNote,
  getInFlight, registerInFlight, clearInFlight,
  MUTATING_TOOLS, currentWriteEpoch, bumpWriteEpoch,
} from '../utils/callDedup.js';
import { capToolResponse } from './responseCaps.js';

/**
 * Tools whose call can WRITE to the model. Used only to pick the right wording
 * when the bridge failed but the tool still returned OK — see the note in the
 * dispatch loop.
 */
const WRITE_CAPABLE_TOOLS = new Set(['d365fo_file', 'labels']);
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

/**
 * Published tools that answer from IN-REPO STATIC DATA and so must not queue
 * behind dbReady. VERIFIED LIVE (2026-08-25): five parallel first calls at
 * server start all exceeded 120 s and were pushed to the background, including
 * `get_knowledge(kind="op-spec")` — 2 ms warm, no database in its path, waiting
 * only because the gate is "not in LOCAL_TOOLS → await dbReady (55 s)".
 *
 * EXEMPTED, one tool, on the strict bar that the handler cannot reach the index
 * even in principle:
 *  • get_knowledge — dispatched as `getKnowledgeTool(request)`, without
 *    `context`, so it has no symbolIndex to read; its answers come from
 *    src/knowledge/** and the op-spec tables shipped in this repo.
 * REJECTED (each genuinely reads the index, and would answer wrong or empty
 * before dbReady): object_patterns (domain="table" queries symbols),
 * validate_code + validate_object_naming (label/name lookups), and
 * prepare / generate_object / d365fo_file (all ground writes in indexed metadata).
 * The bridge-readiness wait below is untouched — different, much shorter gate.
 */
const DB_FREE_TOOLS = new Set(['get_knowledge']);

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
    // LOCAL_TOOLS need no DB (filesystem/in-memory config only) and skip the
    // wait; so do DB_FREE_TOOLS, whose answer is in-repo static data.
    if (context.dbReady && !LOCAL_TOOLS.has(toolName) && !DB_FREE_TOOLS.has(toolName)) {
      const t0 = Date.now();
      // Race dbReady against a 55-second timeout so VS Code's ~60 s client
      // timeout doesn't silently cancel the request. If the DB is still loading
      // after 55 s, return an informative message instead of hanging forever.
      const DB_WAIT_TIMEOUT_MS = 55_000;
      // The handle is cleared below: an uncleared 55 s timer per call kept the
      // event loop alive for up to 55 s after the last call, and on a busy server
      // held one pending timer per in-flight call for no reason.
      let dbWaitTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        dbWaitTimer = setTimeout(() => resolve('timeout'), DB_WAIT_TIMEOUT_MS);
      });
      let result: 'ready' | 'timeout';
      try {
        result = await Promise.race([
          context.dbReady.then(() => 'ready' as const),
          timeoutPromise,
        ]);
      } finally {
        if (dbWaitTimer !== undefined) clearTimeout(dbWaitTimer);
      }
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
    // Captured HERE, not after the tool runs: it tags this occurrence in the
    // sequence buffer, so the loop advisory below can tell a genuine loop from a
    // legitimate re-read that follows a write.
    const epochAtStart = currentWriteEpoch();
    // Side effect: records this occurrence (and the duplicate-call metric) in the
    // sequence buffer, tagged with the epoch. The raw repeat count is deliberately
    // NOT used for the loop advisory — see occurrencesInEpoch below.
    recordCallSequence(toolName, callKey, epochAtStart);
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
    // `epochAtStart` is captured further up, before the sequence buffer records
    // this call. It is still the pre-run epoch that storeDedupResult needs: a read
    // overlapping a concurrent write computed a pre-write answer and must not be
    // cached as current.
    let result: any;
    // Anything the C# bridge throws during this call lands here (see
    // bridge/bridgeFailure.ts). Without it a bridge outage is invisible: the read
    // wrappers return null, the tool serves the SQLite index instead, and the
    // answer — including "not found" — looks like it came from live metadata.
    const bridgeFailures: BridgeFailure[] = [];
    // Anything this call commits before it fails — a label written on the way to
    // an operation that is then refused. Same scope shape as the failure sink.
    const sideEffects: WriteSideEffect[] = [];
    try {
    result = await runWithSideEffectScope(sideEffects, () =>
      runWithBridgeFailureScope(bridgeFailures, async () => {
      // Build the progress description for this tool call.
      const args = request.params.arguments as Record<string, any> | undefined;
      const progressMsg = buildProgressMessage(toolName, args);

      // Both notification channels (notifications/progress when the client
      // supplied a progressToken, notifications/message otherwise) live in one
      // reporter so long-running tools can keep using it after this first step.
      const reportProgress = createProgressReporter(server, extra as any);
      // Deliberately not awaited. This is a UI notification, and awaiting it put two
      // client round trips (notifications/progress + notifications/message) in front
      // of every tool — including the ones that answer in single-digit milliseconds.
      // The reporter never rejects (both sends are try/caught inside), and the
      // transport writes in call order, so the notification still precedes the result.
      void reportProgress(progressMsg, 0);

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
      // already had the object in hand). Same for undo_last_modification,
      // review_workspace_changes and trigger_db_sync, folded into
      // d365fo_file(action="undo"), get_workspace_info(changes=true) and
      // build_d365fo_project(dbSync) respectively. The routes stay so an agent
      // still holding the old name from an earlier session gets its answer,
      // rather than an "unknown tool" it cannot recover from — and, for
      // trigger_db_sync, so a partial sync with no rebuild stays reachable.
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
    }));
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
          // A write that came back OK completed through the direct-XML fallback,
          // so it needs the "it landed, do not repeat it" wording rather than the
          // reader's "treat this as unproven and re-run".
          const writeSucceeded = WRITE_CAPABLE_TOOLS.has(toolName) && capped?.isError !== true;
          capped = appendNote(capped, renderBridgeFailureNote(bridgeFailures, { writeSucceeded }));
        }
      }

      // A FAILED call that had already committed something says so, because its
      // own "nothing was written" is about the operation, not about everything
      // the call touched — a label resolved on the way to a refused add-field is
      // on disk, and undo does not take it back. Only on failure: on success the
      // tool reports the effect in its own words.
      if (capped?.isError === true && sideEffects.length > 0) {
        capped = appendNote(capped, renderSideEffectNote(sideEffects));
      }

      // Record metrics: detect empty result (no content or first text item is empty)
      const firstText = capped?.content?.[0]?.text;
      const isEmpty = !firstText || firstText.trim().length === 0 || firstText === 'No results returned';
      finishMetrics(isEmpty);
      reportSlowCall(toolName, Date.now() - callStartedAt, request.params.arguments);

      if (!DEDUP_EXCLUDED_TOOLS.has(toolName)) {
        storeDedupResult(callKey, capped, epochAtStart);
        // Loop hint: 3+ identical calls in the recent window means the model is
        // cycling — but ONLY if no write landed in between. Counting raw repeats
        // told an agent "the answer does not change between calls" while handing it
        // content this server's own writes had just changed twice (eval case
        // L2-entity-query-range-roundtrip, 2026-08-24). Re-reading after a write is
        // correct behaviour, and discouraging it undoes the cache-invalidation fix.
        const repeatsThisEpoch = occurrencesInEpoch(toolName, callKey, epochAtStart);
        if (repeatsThisEpoch >= 3) {
          capped = appendNote(
            capped,
            `> ⚠️ Loop detected: this is occurrence #${repeatsThisEpoch} of the exact same ${toolName} call ` +
            `with no write in between, so the answer does not change. If you are missing information, ` +
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
      // Invalidate every cached read, whatever the outcome: a write that threw
      // may still have changed the disk, and serving a pre-write body afterwards
      // is the failure this guards against.
      if (MUTATING_TOOLS.has(toolName)) {
        bumpWriteEpoch();
        // Same reasoning, second cache: WorkspaceScanner holds a 15s TTL cache of
        // the .xml files on disk, and its own doc comment claimed writes invalidated
        // it — nothing did, so for up to 15s after a create the workspace-backed
        // readers (hybridSearch, get_object_info/completion with includeWorkspace)
        // and workspace://files, workspace://active could not see a file this
        // server had just written. Full clear, not per-path: the write's workspace
        // is not reliably known here, and clearing a Map is cheaper than guessing
        // wrong. The next scan re-globs.
        context.workspaceScanner?.invalidate();
      }
      inFlightHandle?.resolve(capped);
      clearInFlight(callKey);
    }
    return capped;
  });
}
