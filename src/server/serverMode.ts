/**
 * Server mode + tool profile configuration.
 *
 * Two independent axes decide which tools this MCP server instance publishes:
 *
 *  1. LOCALITY (MCP_SERVER_MODE=full|read-only|write-only) — which half of the
 *     toolset this process can physically serve, enabling a hybrid deployment
 *     where an Azure-hosted instance runs 'read-only' (search / analysis) and a
 *     local Windows VM instance runs 'write-only' (file operations).
 *
 *  2. BREADTH (MCP_TOOL_PROFILE=full|core) — how much of the toolset is worth
 *     advertising at all. Hosts stop sending the tool catalogue inline past a
 *     limit (VS Code: ~100 tools across all servers) and switch the model to a
 *     search-based tool surface, which costs a discovery round trip per tool it
 *     needs (issue #825). 'core' publishes only the plan → discover → write →
 *     build → verify loop; MCP_EXTRA_TOOLS adds individual tools back.
 *
 * isToolEnabled() is the single predicate combining both, shared by the
 * ListTools filter and the runtime call gate so they cannot drift apart.
 */

/**
 * Tools that need local Windows VM filesystem access (K:\ drive) or local server
 * state not reachable from Azure. Excluded in 'read-only' mode; the only tools
 * exposed in 'write-only' (local companion) mode. These skip the dbReady await
 * since they don't need the symbol database.
 *
 * Also includes the bridge-backed read surface (get_method) which works via
 * IMetadataProvider without SQLite, so Copilot can verify objects it just
 * created without an Azure re-deploy.
 */
export const LOCAL_TOOLS = new Set([
  'verify_d365fo_project',
  'update_symbol_index',
  'build_d365fo_project',
  'trigger_db_sync',
  'run_bp_check',
  'run_systest_class',
  'review_workspace_changes',
  'undo_last_modification',
  'get_workspace_info',
  'get_method',
]);

/**
 * Tools exposed in EVERY server mode, bypassing the LOCAL_TOOLS partition,
 * because each spans both localities and gates unavailable actions at runtime:
 *  - get_object_info: dispatches to bridge-backed types (local VM) and
 *    SQLite-backed types (Azure read-only).
 *  - labels: read actions (search/info) work on Azure; write actions
 *    (create/rename) need K:\ and error clearly when unreachable.
 *  - d365fo_file: generate works on Azure; create/modify need K:\ and error
 *    clearly when unreachable.
 */
export const ALWAYS_TOOLS = new Set([
  'get_object_info',
  'labels',
  'd365fo_file',
]);

/**
 * @deprecated Use LOCAL_TOOLS — kept temporarily so any external import doesn't break.
 * Will be removed in the next major release.
 */
export const WRITE_TOOLS = LOCAL_TOOLS;

/**
 * Server mode, resolved once at startup from MCP_SERVER_MODE env var.
 * - 'full'       (default) – all tools registered (local development)
 * - 'read-only'  – LOCAL_TOOLS excluded   (Azure App Service deployment)
 * - 'write-only' – only LOCAL_TOOLS exposed (lightweight local companion)
 */
export type ServerMode = 'full' | 'read-only' | 'write-only';

export const SERVER_MODE: ServerMode = (() => {
  const raw = (process.env.MCP_SERVER_MODE ?? 'full').toLowerCase().trim();
  if (raw === 'read-only' || raw === 'readonly') return 'read-only';
  if (raw === 'write-only' || raw === 'writeonly') return 'write-only';
  return 'full';
})();

/**
 * Single source of truth for whether a tool is callable in a given server mode.
 * Used by BOTH the ListTools filter (mcpServer) and the runtime call gate
 * (toolHandler) so the advertised tool list and call-time enforcement can
 * never drift apart. ALWAYS_TOOLS bypass the LOCAL_TOOLS partition in every mode.
 */
export function isToolAllowedInMode(mode: ServerMode, toolName: string): boolean {
  if (mode === 'full' || ALWAYS_TOOLS.has(toolName)) return true;
  return mode === 'read-only' ? !LOCAL_TOOLS.has(toolName) : LOCAL_TOOLS.has(toolName);
}

/**
 * The tools a full "understand it, write it, build it, verify it" D365FO
 * workflow actually walks through. Membership is positive and explicit so a new
 * tool has to be argued INTO the small profile rather than drifting in
 * (tests/utils/toolInventory.test.ts fails until every published tool is
 * classified).
 *
 * Excluded from 'core' — each is a specialist detour off the write loop, and
 * each stays one MCP_EXTRA_TOOLS entry (or MCP_TOOL_PROFILE=full) away:
 *  - extension_info  → extension-point analysis; search + get_object_info +
 *                      object_patterns carry the write path.
 *  - analyze_code    → code-quality/pattern review, not a step in creating code.
 *  - validate_code   → advisory X++ lint; run_bp_check and the compiler are the
 *                      authoritative gates and both stay in core.
 *  - security_info   → security-model inspection, its own kind of task.
 *  - batch_get_info  → the batched form of get_object_info, which is core.
 *  - get_method      → one method's source; get_object_info already returns them.
 *  - run_systest_class → test execution, a separate phase (and gated behind an
 *                      interactive console on most boxes).
 *  - suggest_edt     → EDT resolution already runs inside generate_object and
 *                      d365fo_file field handling.
 *
 * generate_object and trigger_db_sync are kept IN core against the raw
 * never-called list from the audit: scaffolding is load-bearing for the create
 * path, and a table change is not finished until the DB is synchronised.
 */
export const CORE_TOOLS = new Set([
  // ground + discover
  'prepare',
  'search',
  'get_object_info',
  'find_references',
  'object_patterns',
  'get_knowledge',
  'get_workspace_info',
  // write
  'validate_object_naming',
  'generate_object',
  'd365fo_file',
  'labels',
  'undo_last_modification',
  // build + verify
  'update_symbol_index',
  'build_d365fo_project',
  'trigger_db_sync',
  'run_bp_check',
  'verify_d365fo_project',
  'review_workspace_changes',
]);

/**
 * Tool profile, resolved once at startup from MCP_TOOL_PROFILE.
 * - 'full' (default) – every tool this mode allows; nobody's setup changes
 * - 'core'           – CORE_TOOLS (+ MCP_EXTRA_TOOLS) only
 */
export type ToolProfile = 'full' | 'core';

export const TOOL_PROFILE: ToolProfile = (() => {
  const raw = (process.env.MCP_TOOL_PROFILE ?? 'full').toLowerCase().trim();
  return raw === 'core' ? 'core' : 'full';
})();

/** Parse a comma/space separated tool list (MCP_EXTRA_TOOLS) into a set. */
export function parseToolList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map(t => t.trim())
      .filter(Boolean),
  );
}

/** Non-core tools added back on top of the 'core' profile. Ignored when full. */
export const EXTRA_TOOLS: ReadonlySet<string> = parseToolList(process.env.MCP_EXTRA_TOOLS);

/** Whether a tool survives the breadth filter. 'full' keeps everything. */
export function isToolInProfile(
  profile: ToolProfile,
  toolName: string,
  extras: ReadonlySet<string> = EXTRA_TOOLS,
): boolean {
  if (profile === 'full') return true;
  return CORE_TOOLS.has(toolName) || extras.has(toolName);
}

/**
 * Single source of truth for whether a tool is published AND callable: locality
 * first, then breadth. Used by the ListTools filter (mcpServer) and the runtime
 * call gate (toolHandler).
 */
export function isToolEnabled(
  toolName: string,
  mode: ServerMode = SERVER_MODE,
  profile: ToolProfile = TOOL_PROFILE,
  extras: ReadonlySet<string> = EXTRA_TOOLS,
): boolean {
  return isToolAllowedInMode(mode, toolName) && isToolInProfile(profile, toolName, extras);
}
