/**
 * MCP tool annotations — display titles + behavior hints for every tool.
 *
 * Applied to the ListTools response in mcpServer.ts. Clients use these for UX:
 *  - `title`           → VS Code chat shows "Ran Search D365FO index" instead of
 *                        "Ran search"
 *  - `readOnlyHint`    → read-only tools skip the write-confirmation dialog,
 *                        speeding up agentic flows
 *  - `destructiveHint` → tools that overwrite/rewrite existing content get an
 *                        explicit confirmation
 *  - `idempotentHint`  → repeated identical calls are safe (build, sync, index)
 *  - `openWorldHint`   → false everywhere: this server only touches the local
 *                        D365FO metadata store and symbol index, never the
 *                        open internet
 *
 * Per MCP spec these are HINTS for display/UX, not security boundaries.
 * Every tool in mcpServer.ts MUST have an entry here — enforced by
 * tests/utils/toolInventory.test.ts.
 */

export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Read/analysis tool — no filesystem or DB writes. */
function read(title: string): ToolAnnotations {
  return { title, readOnlyHint: true, openWorldHint: false };
}

/** Write tool — creates or modifies files / DB state. */
function write(
  title: string,
  opts: { destructive?: boolean; idempotent?: boolean } = {},
): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: opts.destructive ?? false,
    idempotentHint: opts.idempotent ?? false,
    openWorldHint: false,
  };
}

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // ── Search & discovery ────────────────────────────────────────────────────
  search:                           read('Search D365FO index'),
  batch_get_info:                   read('Batch read object info'),
  find_references:                  read('Find references'),
  extension_info:                    read('Extensibility (coc/events/points/strategy)'),

  // ── Object inspection ─────────────────────────────────────────────────────
  get_object_info:                  read('Read object info'),
  get_method:                       read('Read method signature/source'),
  security_info:                    read('Security info (artifact/coverage)'),

  // ── Analysis & guidance ───────────────────────────────────────────────────
  analyze_code:                     read('Analyze code (patterns/impl/completeness/API)'),
  suggest_edt:                      read('Suggest EDT for field'),
  object_patterns:                         read('Patterns (table/form)'),
  get_knowledge:                    read('X++ knowledge / error help'),
  validate_object_naming:           read('Validate object naming'),
  validate_code:                         read('Validate X++ (syntax/references)'),
  prepare:                          read('Prepare grounded context'),

  // ── Diagnostics ───────────────────────────────────────────────────────────
  get_workspace_info:               read('Read workspace configuration'),
  verify_d365fo_project:            read('Verify D365FO project'),
  review_workspace_changes:         read('Review workspace changes'),
  run_bp_check:                     read('Run Best Practices check'),

  // ── File & label writes ───────────────────────────────────────────────────
  // `d365fo_file` covers create (new file), modify (edit existing — destructive),
  // and generate (XML text only, no write). Marked as a destructive write tool so
  // clients prompt for confirmation; the generate action is still safe to call.
  d365fo_file:                      write('D365FO file (create/modify/generate)', { destructive: true }),
  // `labels` exposes read actions (search/info) and write actions (create/rename).
  // Marked as a write tool so clients prompt for confirmation; the read actions
  // are still safe to call — the tool annotations are hints, not gates.
  labels:                           write('Label operations', { destructive: true }),
  undo_last_modification:           write('Undo last modification', { destructive: true }),
  // generate_object(mode="scaffold") writes generated XML to PackagesLocalDirectory
  // (bridge or SmartXmlBuilder→fs fallback); it refuses to overwrite.
  // mode="pattern" is text-only, but the tool is marked write for confirmation UX.
  generate_object:                         write('Generate code (pattern/scaffold)'),

  // ── SDLC operations ───────────────────────────────────────────────────────
  update_symbol_index:              write('Update symbol index', { idempotent: true }),
  build_d365fo_project:             write('Build D365FO project', { idempotent: true }),
  trigger_db_sync:                  write('Trigger database sync', { idempotent: true }),
  run_systest_class:                write('Run SysTest unit tests'),
};
