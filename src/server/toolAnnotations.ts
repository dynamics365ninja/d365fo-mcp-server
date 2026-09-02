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
 * Every tool in src/server/toolSchemas/index.ts MUST have an entry here —
 * enforced by tests/utils/toolInventory.test.ts, which iterates that array.
 * (This map's size is also what src/index.ts derives the runtime tool count
 * from, so a missing entry undercounts the startup log as well.)
 */

export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A HINT IS ONLY WORTH SENDING WHEN IT DISAGREES WITH THE SPEC DEFAULT.
 *
 * The MCP defaults are `readOnlyHint: false`, `destructiveHint: true`,
 * `idempotentHint: false`, `openWorldHint: true`. A field repeating its own
 * default tells a compliant client exactly what its absence would have told it,
 * and this payload is rationed — the ListTools response is re-sent on every
 * request and sits against a 45,000-char ratchet.
 *
 * Measured: omitting `readOnlyHint: false` (6 tools) and `idempotentHint: false`
 * (4 tools) recovers 218 chars, which is what paid for the `report-design`
 * operation's enum value.
 *
 * ONE DEFAULT IS KEPT ON PURPOSE. `destructiveHint: true` is also the spec
 * default, and it stays explicit on the two tools that carry it. Absence is only
 * equivalent to the default for a client that implements defaults; a client that
 * reads absence as "unknown" would become MORE cautious about a missing
 * `readOnlyHint` and LESS cautious about a missing `destructiveHint`. The first
 * direction is safe to take, the second is not, and 46 chars is not a reason to
 * gamble on a confirmation dialog for a destructive write.
 */

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
    // readOnlyHint omitted: false is the spec default for every tool here.
    // destructiveHint always sent, with its REAL value — see the note above.
    destructiveHint: opts.destructive ?? false,
    ...(opts.idempotent ? { idempotentHint: true } : {}),
    openWorldHint: false,
  };
}

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Search & discovery
  search:                           read('Search D365FO index'),
  find_references:                  read('Find references'),
  extension_info:                    read('Extensibility (coc/events/points/strategy)'),

  // Object inspection
  get_object_info:                  read('Read object info'),
  security_info:                    read('Security info (artifact/coverage)'),

  // Analysis & guidance
  analyze_code:                     read('Analyze code (patterns/impl/completeness/API)'),
  object_patterns:                         read('Patterns (table/form)'),
  get_knowledge:                    read('X++ knowledge / error help'),
  validate_object_naming:           read('Validate object naming'),
  validate_code:                         read('Validate X++ (syntax/references)'),
  prepare:                          read('Prepare grounded context'),

  // Diagnostics
  get_workspace_info:               read('Read workspace configuration'),
  verify_d365fo_project:            read('Verify D365FO project'),
  run_bp_check:                     read('Run Best Practices check'),

  // File & label writes. Marked destructive/write so clients prompt for
  // confirmation even though some actions (generate, search/info) are read-only —
  // annotations are hints, not gates.
  d365fo_file:                      write('D365FO file (create/modify/delete/undo/generate)', { destructive: true }),
  labels:                           write('Label operations', { destructive: true }),
  generate_object:                         write('Generate code (pattern/scaffold)'),

  // SDLC operations
  update_symbol_index:              write('Update symbol index', { idempotent: true }),
  build_d365fo_project:             write('Build D365FO project', { idempotent: true }),
  run_systest_class:                write('Run SysTest unit tests'),
};
