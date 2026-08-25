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
  'run_bp_check',
  'run_systest_class',
  'get_workspace_info',
]);

/**
 * Tools exposed in EVERY server mode, bypassing the LOCAL_TOOLS partition,
 * because each spans both localities and gates unavailable actions at runtime:
 *  - get_object_info: dispatches to bridge-backed types (local VM) and
 *    SQLite-backed types (Azure read-only).
 *  - labels: read actions (search/info) work on Azure; write actions
 *    (create/rename) need K:\ and error clearly when unreachable.
 *  - d365fo_file: generate works on Azure; create/modify/delete need K:\ and
 *    error clearly when unreachable.
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
/**
 * Retired tool names that still route, mapped to the tool their handler now
 * lives behind.
 *
 * Both gates below match on the NAME and run before toolHandler's switch, so a
 * retired name that is in neither CORE_TOOLS nor LOCAL_TOOLS is refused no
 * matter that its `case` is still there. Judge it as its replacement instead —
 * that is the tool the call reaches, so it is the tool whose locality and
 * profile membership actually apply.
 *
 * Verified live: before this, MCP_SERVER_MODE=write-only refused
 * `undo_last_modification`, a local file operation that was in LOCAL_TOOLS
 * until the folds. `get_method` keeps being refused there, because it resolves
 * to `get_object_info`, which needs the symbol index — same rule, opposite and
 * equally correct answer.
 */
export const RETIRED_TOOL_ROUTES: ReadonlyMap<string, string> = new Map([
  ['undo_last_modification', 'd365fo_file'],
  ['review_workspace_changes', 'get_workspace_info'],
  ['trigger_db_sync', 'build_d365fo_project'],
  // get_method, suggest_edt and batch_get_info are deliberately NOT here. They
  // were retired before this change and their gate behaviour is long-standing —
  // get_method is refused in write-only mode today, and mapping it onto
  // get_object_info (an ALWAYS tool) would quietly start allowing it. Widening
  // an older tool's availability is a separate decision from repairing the one
  // this fold broke.
]);

/** The tool a call under this name actually reaches. */
export function resolveRetiredToolName(toolName: string): string {
  return RETIRED_TOOL_ROUTES.get(toolName) ?? toolName;
}

export function isToolAllowedInMode(mode: ServerMode, toolName: string): boolean {
  if (mode === 'full') return true;
  const name = resolveRetiredToolName(toolName);
  if (ALWAYS_TOOLS.has(name)) return true;
  return mode === 'read-only' ? !LOCAL_TOOLS.has(name) : LOCAL_TOOLS.has(name);
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
 *  - run_systest_class → test execution, a separate phase (and gated behind an
 *                      interactive console on most boxes).
 *
 * generate_object is kept IN core against the raw never-called list from the
 * audit: scaffolding is load-bearing for the create path. The database sync is
 * still in core too — it just travels as build_d365fo_project(dbSync) now,
 * because a table change is not finished until the DB is synchronised.
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
  // build + verify
  'update_symbol_index',
  'build_d365fo_project',
  'run_bp_check',
  'verify_d365fo_project',
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
  // An explicit MCP_EXTRA_TOOLS entry wins under whichever spelling it was
  // written in; otherwise judge the retired name as the tool it reaches.
  if (extras.has(toolName)) return true;
  const name = resolveRetiredToolName(toolName);
  return CORE_TOOLS.has(name) || extras.has(name);
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
