# D365 Finance & Operations X++ Development

<!-- Thin pointer — full rules are delivered via the MCP `xpp_system_instructions` prompt.
     This file provides only the minimum static context needed when the MCP server
     is not yet connected or the prompt hasn't been loaded.
     Keep this file in sync with CLAUDE.template.md. -->

## Tool Priority

This workspace contains a D365FO MCP server. **Always use the specialized MCP tools** for D365FO objects (`.xml`, `.xpp`, `.rnrproj`, `.label.txt`). Built-in file/search tools are fine for `.cs`, `.json`, `.yml`, `.md`, `.config` files.

## Mandatory First Check

Call `get_workspace_info()` before doing anything with D365FO objects.

| Response | Action |
|----------|--------|
| Call fails | STOP. MCP server not connected. Ask user to start it. |
| `⛔ CONFIGURATION PROBLEM` | STOP. Relay message. Wait for user. |
| `✅ Configuration looks valid` | Note model name. Proceed. |

## Terminal Prohibition

PowerShell / any terminal command **WILL HANG** in VS 2022 / VS 2026 MCP integration. Never use `run_in_terminal` or generate scripts as a fallback when an MCP tool fails — STOP and report the error verbatim.

## Core Tool Mapping

| Action | Tool |
|--------|------|
| Plan an extension before changing code | `prepare_change(goal, objectName, methodName?)` — returns signature, existing CoC wrappers, strategy + `groundingToken` |
| Plan a new object before creating it | `prepare_create(goal, objectName, objectType)` — returns collision check, naming, EDT/label hints + `groundingToken` |
| Create a D365FO object | `create_d365fo_file` (never `create_file`) |
| Edit an existing object | `modify_d365fo_file` (applies immediately — confirm in chat first) |
| Revert the last write | `undo_last_modification` |
| Search objects | `search` / `batch_search` |
| Read class / table / form | `get_class_info` / `get_table_info` / `get_form_info` — 2+ known names: `batch_get_info(objects[])` |
| Method signature for CoC | `get_method_signature` (already returned by `prepare_change`) |
| Validate X++ before write | `validate_xpp(code)` — offline BP check, <50 ms |
| X++ rules & patterns | `get_xpp_knowledge(topic)` — select grammar, CoC, BP rules, SysOperation, workflow, … |
| Create a NEW form | `get_form_patterns(recommend={...})` → `get_form_pattern_spec(pattern)` → `generate_smart_form(cloneFrom=referenceForm, tableMapping={...})` → `validate_form_pattern(xml)` |
| Validate form XML against its pattern | `validate_form_pattern(xml \| formName \| filePath)` — structural errors block form writes (FORM_PATTERN_ENFORCE) |
| Resolve label / EDT / class refs | `resolve_references(code)` |
| Build / BP / Sync | `build_d365fo_project` / `run_bp_check` / `trigger_db_sync` |
| Error diagnosis | `get_d365fo_error_help(errorText)` |

## Key Rules

### Workspace & model targeting

1. **The target model comes from `.mcp.json`** — never infer it from search results or object names. The symbol database contains objects from all models (Microsoft + ISV + custom); the model on a search/`get_*_info` result is the source model, not where new files belong.

### Writes & file editing

2. **`modify_d365fo_file` and `create_d365fo_file` apply immediately** (no dry-run / preview). Describe the change in chat and wait for explicit user confirmation ("apply", "ok", "yes") before calling. Revert with `undo_last_modification` (or pass `createBackup=true` to keep a `.bak`).
3. **Never** use `replace_string_in_file`, `edit_file`, `apply_patch`, or any built-in file-write tool on `.xml` or `.xpp` files — **not even as a fallback** when `modify_d365fo_file` fails. These bypass `IMetadataProvider` and corrupt VS 2022's in-memory model. If `modify_d365fo_file` errors, STOP and report the error verbatim.

### Build automation

4. Never run `build_d365fo_project()` automatically — only on explicit user request ("build", "compile", "check errors").

### X++ correctness (BP-clean code)

5. Never copy default parameter values into CoC wrapper signatures.
6. Never use `today()` — use `DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone())`.
7. Never use hardcoded strings in `Info()` / `warning()` / `error()` — use `@Model:Label` references.
8. Call `search_labels()` before `create_label()` — reuse existing labels.

### Extension naming

9. Extension naming follows `EXTENSION_NAMING_STYLE` (see `get_workspace_info`):
   - `prefix` (default) → class `{Target}{Prefix}_Extension`, element `{Target}.{Prefix}Extension`
   - `model-name` → class `{Target}_{ModelName}_Extension`, element `{Target}.{ModelName}`

   Pass the BASE object name to `create_d365fo_file` and let the tool inject the token — don't hand-build the infix.

## Full Instructions

The complete X++ rules, query grammar, CoC authoring rules, and workflow details are delivered via the MCP prompt `xpp_system_instructions`. If that prompt is not loaded, request it or consult [src/prompts/systemInstructions.ts](../src/prompts/systemInstructions.ts) directly.

