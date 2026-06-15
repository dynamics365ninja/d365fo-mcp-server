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
| Plan an extension before changing code | `prepare(mode="change", goal, objectName, methodName?)` — returns signature, existing CoC wrappers, strategy + `groundingToken` |
| Plan a new object before creating it | `prepare(mode="create", goal, objectName, objectType)` — returns collision check, naming, EDT/label hints + `groundingToken` |
| Create a D365FO object | `d365fo_file(action="create")` (never `create_file`) |
| Edit an existing object | `d365fo_file(action="modify")` (applies immediately — confirm in chat first) |
| Revert the last write | `undo_last_modification` |
| Search objects | `search` — multiple via `search(queries[])`, custom-only via `search(scope="extensions")` |
| Read any object's metadata | `get_object_info(objectType, name, options?)` — objectType ∈ class/table/form/query/view/enum/edt/report/data-entity/menu-item/service/map/config-key/security-policy/macro. 2+ known names: `batch_get_info(objects[])` |
| Method signature for CoC | `get_method(include="signature")` (already returned by `prepare(mode="change")`) |
| Validate X++ before write | `validate_code(mode="syntax", code)` — offline BP check, <50 ms |
| X++ rules & patterns | `get_knowledge(kind="knowledge", topic)` — select grammar, CoC, BP rules, SysOperation, workflow, … |
| Create a NEW form | `object_patterns(domain="form", action="analyze", recommend={...})` → `object_patterns(domain="form", action="spec", pattern)` → `generate_object(mode="scaffold", objectType="form", cloneFrom=referenceForm, tableMapping={...})` → `object_patterns(domain="form", action="validate", xml)` |
| Validate form XML against its pattern | `object_patterns(domain="form", action="validate", xml \| formName \| filePath)` — structural errors block form writes (FORM_PATTERN_ENFORCE) |
| Resolve label / EDT / class refs | `validate_code(mode="references", code)` |
| Build / BP / Sync | `build_d365fo_project` / `run_bp_check` / `trigger_db_sync` |
| Error diagnosis | `get_knowledge(kind="error", errorText)` |

## Key Rules

### Workspace & model targeting

1. **The target model comes from `.mcp.json`** — never infer it from search results or object names. The symbol database contains objects from all models (Microsoft + ISV + custom); the model on a search/`get_*_info` result is the source model, not where new files belong.

### Writes & file editing

2. **`d365fo_file` (action=create/modify) applies immediately** (no dry-run / preview). Describe the change in chat and wait for explicit user confirmation ("apply", "ok", "yes") before calling. Revert with `undo_last_modification` (or pass `createBackup=true` to keep a `.bak`).
3. **Never** use `replace_string_in_file`, `edit_file`, `apply_patch`, or any built-in file-write tool on `.xml` or `.xpp` files — **not even as a fallback** when `d365fo_file(action="modify")` fails. These bypass `IMetadataProvider` and corrupt VS 2022's in-memory model. If `d365fo_file(action="modify")` errors, STOP and report the error verbatim.

### Build automation

4. Never run `build_d365fo_project()` automatically — only on explicit user request ("build", "compile", "check errors").

### X++ correctness (BP-clean code)

5. Never copy default parameter values into CoC wrapper signatures.
6. Never use `today()` — use `DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone())`.
7. Never use hardcoded strings in `Info()` / `warning()` / `error()` — use `@Model:Label` references.
8. Call `labels(action="search")` before `labels(action="create")` — reuse existing labels.

### Extension naming

9. Extension naming follows `EXTENSION_NAMING_STYLE` (see `get_workspace_info`):
   - `prefix` (default) → class `{Target}{Prefix}_Extension`, element `{Target}.{Prefix}Extension`
   - `model-name` → class `{Target}_{ModelName}_Extension`, element `{Target}.{ModelName}`

   Pass the BASE object name to `d365fo_file(action="create")` and let the tool inject the token — don't hand-build the infix.

### Reuse & diff safety

10. **Reuse before creating** — `prepare(mode="change")` lists existing CoC wrappers and event handlers. If an extension or handler class in the custom model already owns the target, add the new method there. Never create a parallel feature-named class (`<Target>_<Feature>_Extension`, `<Form>_<Feature>_EH`) unless the user explicitly asks for a separate class. The suffix comes from `EXTENSION_NAMING_STYLE` / existing artifacts — never from feature, ticket, or customer names; if it cannot be derived, ask.
11. **The post-write diff must be additive or narrowly targeted** — verify via `review_workspace_changes` (or re-read with `get_*_info`) that no unrelated XML nodes (`<DataSources>`, `<Controls>`, methods, pattern metadata) disappeared. If they did, the edit failed: `undo_last_modification`.
12. **An example form named by the user is a pattern contract** — keep its pattern family and required scaffolding (datasources, ActionPane/Tab/grid/QuickFilter); missing pattern elements are a failed generation even if the XML is well-formed.

## Full Instructions

The complete X++ rules, query grammar, CoC authoring rules, and workflow details are delivered via the MCP prompt `xpp_system_instructions`. If that prompt is not loaded, request it or consult [src/prompts/systemInstructions.ts](../src/prompts/systemInstructions.ts) directly.

