/**
 * MCP Server Configuration and Setup
 * Registers tools, resources, and prompts for X++ code completion
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { VERSION } from '../version.js';
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
import { SERVER_MODE, LOCAL_TOOLS, TOOL_PROFILE, isToolEnabled } from './serverMode.js';
import { TOOL_ANNOTATIONS } from './toolAnnotations.js';
import { getConfigManager } from '../utils/configManager.js';

const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';
import { setLastRoots, recordRootsListChanged } from '../utils/stdioSessionInfo.js';
import { toolSchemas } from './toolSchemas/index.js';

export type { XppServerContext };
export { SERVER_MODE, LOCAL_TOOLS, WRITE_TOOLS, TOOL_PROFILE, CORE_TOOLS } from './serverMode.js';
export type { ServerMode, ToolProfile } from './serverMode.js';

/**
 * Convert a file:// URI to a local path. Duplicated from transport.ts to avoid
 * a circular dependency between transport and mcpServer.
 */
function fileUriToPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('file:///')) {
    const decoded = decodeURIComponent(uri.slice('file:///'.length));
    if (process.platform === 'win32') {
      return decoded.replace(/\//g, '\\');
    }
    return '/' + decoded;
  }
  if (uri.startsWith('file://')) {
    const decoded = decodeURIComponent(uri.slice('file://'.length));
    return process.platform === 'win32' ? decoded.replace(/\//g, '\\') : decoded;
  }
  if (uri.length > 2 && (uri[1] === ':' || uri.startsWith('\\\\') || uri.startsWith('/'))) return uri;
  return null;
}

/**
 * Apply MCP roots list to ConfigManager. All roots are passed so unambiguous
 * single-project matches still work when the client sends multiple roots.
 */
function applyRootsToConfig(roots: Array<{ uri: string }>): void {
  if (!roots?.length) {
    // Empty roots/list can mean a solution is closing (transition state); keep
    // the current detection result and wait for the next roots/list_changed.
    if (DEBUG_LOGGING) {
      process.stderr.write('[mcpServer] roots/list received (0 root(s)) — solution closing or no workspace open\n');
    }
    setLastRoots([]);
    return;
  }

  if (DEBUG_LOGGING) {
    process.stderr.write(`[mcpServer] roots/list received (${roots.length} root(s)):\n`);
    roots.forEach((r, i) => process.stderr.write(`  [${i}] ${r.uri}\n`));
  }

  // Persisted so get_workspace_info can display them.
  setLastRoots(roots.map(r => r.uri));

  const paths = roots
    .map(r => fileUriToPath(r.uri))
    .filter((p): p is string => p !== null);

  if (paths.length === 0) return;

  // configManager picks the most specific unambiguous path among all roots.
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
      version: VERSION,
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

  // Workspace roots: stdio clients (VS Code, VS 2022) send roots after
  // initialization; request them here and refresh on roots/list_changed.
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

  registerToolHandler(server, context);
  registerResources(server, context);
  registerCodeReviewPrompt(server, context);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = {
      tools: [...toolSchemas],
    };

    // Attach MCP tool annotations (display title + behavior hints).
    // VS Code shows annotations.title in the chat UI ("Ran Search D365FO index"
    // instead of "Ran search") and uses readOnlyHint to skip write confirmations.
    allTools.tools = allTools.tools.map(t => ({
      ...t,
      annotations: TOOL_ANNOTATIONS[t.name],
    })) as typeof allTools.tools;

    // Apply the locality + breadth filters. ALWAYS_TOOLS bypass the LOCAL_TOOLS
    // partition and stay published in every mode. isToolEnabled is shared with
    // the runtime gate in toolHandler so the list and the call-time enforcement
    // can't drift.
    const published = allTools.tools.filter(t => isToolEnabled(t.name));
    const modeNote =
      SERVER_MODE === 'read-only' ? ' · read-only (local tools excluded)' :
      SERVER_MODE === 'write-only' ? ` · write-only (${Array.from(LOCAL_TOOLS).join(', ')})` : '';
    const profileNote = TOOL_PROFILE === 'core' ? ' · core profile' : '';
    if (published.length !== allTools.tools.length || profileNote) {
      allTools.tools = published;
      console.error(`[MCP Server] Tool list filtered: ${published.length} tools${modeNote}${profileNote}`);
    } else {
      console.error(`[MCP Server] Tool list in full mode: ${allTools.tools.length} tools (no filtering)`);
    }

    return allTools;
  });

  return server;
}
