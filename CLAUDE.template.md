# D365 Finance & Operations X++ Development

<!-- TEMPLATE — this file is NOT auto-loaded from the d365fo-mcp-server repo root.
     Copy it to the parent folder that contains all your D365FO solution folders
     (the same folder where .github\copilot-instructions.md lives for Copilot users)
     and SAVE IT AS `CLAUDE.md` there. Claude Code reads CLAUDE.md automatically from
     the working directory upward, so one copy covers every solution underneath —
     no per-solution copies needed.

     Full rules are delivered via the MCP `xpp_system_instructions` prompt.
     This file provides only the minimum static context needed when the MCP server
     is not yet connected or the prompt hasn't been loaded. -->

## MCP Tool Priority

For D365FO and X++ work, **always use `d365fo-mcp-tools`** — never semantic code intelligence tools or built-in file/search tools.

| File / task | Required tool |
|-------------|--------------|
| .xpp, .xml, .rnrproj, .label.txt | `d365fo-mcp-tools` only |
| X++ symbol lookup (class/table/method/enum/EDT) | `d365fo-mcp-tools` only (`search`, `get_object_info`, …) |
| .cs, .json, .yml, .md, .config | Built-in tools OK |
| General codebase search (non-D365FO) | Other connected tools OK |

> Semantic code intelligence tools (codebase indexers, symbol search servers, etc.) index general source code — they do **not** index D365FO metadata. Using them for X++ symbol lookup returns wrong or empty results.

## Mandatory First Check

Call `get_workspace_info()` before doing anything with D365FO objects.

| Response | Action |
|----------|--------|
| Call fails | STOP. MCP server not connected. Ask user to start it. |
| `⛔ CONFIGURATION PROBLEM` | STOP. Relay message. Wait for user. |
| `✅ Configuration looks valid` | Note model name. Proceed. |

## Core Tool Mapping

| Action | Tool |
|--------|------|
| Plan an extension before changing code | `prepare(mode="change", goal, objectName, methodName?)` — signature + CoC wrappers + `groundingToken` |
| Plan a new object before creating it | `prepare(mode="create", goal, objectName, objectType)` — collision check + naming + `groundingToken` |
| Create D365FO object | `d365fo_file(action="create")` (never built-in file tools) |
| Edit existing object | Describe change + confirm in chat, then `d365fo_file(action="modify")` (applies immediately) |
| Search objects | `search()` — multiple via `search(queries[])`, custom-only via `search(scope="extensions")` |
| Read any object | `get_object_info(objectType, name, options?)` — objectType ∈ class/table/form/query/view/enum/edt/report/data-entity/menu-item/service/map/config-key/security-policy/macro. 2+ known names: `batch_get_info(objects[])` |
| Validate before write | `validate_code(mode="references", code)` + `validate_code(mode="syntax", code)` |
| X++ rules & patterns | `get_knowledge(kind="knowledge", topic)` |
| Build/BP/Sync | `build_d365fo_project` / `run_bp_check` / `trigger_db_sync` |
| Error diagnosis | `get_knowledge(kind="error", errorText)` |

## Key Rules (condensed)

1. Model name comes from `.mcp.json` — never infer from search results
2. `d365fo_file` (action=create/modify) APPLIES IMMEDIATELY (no dry-run) — describe the change and confirm in chat first; revert with `undo_last_modification` (or pass `createBackup=true`)
3. Never run `build_d365fo_project()` automatically — only on explicit user request
4. Never copy default parameter values into CoC wrapper signatures
5. Never use `today()` — use `DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone())`
6. Never use hardcoded strings in Info/warning/error — use `@Model:Label`
7. Call `labels(action="search")` before `labels(action="create")` — reuse existing labels
8. Extension naming depends on `EXTENSION_NAMING_STYLE` (check `get_workspace_info`). Default `prefix` → class `{Target}{Prefix}_Extension`, element `{Target}.{Prefix}Extension`; `model-name` → class `{Target}_{ModelName}_Extension`, element `{Target}.{ModelName}`. Pass the BASE name to `d365fo_file(action="create")` and let the tool apply the token — don't hand-build the infix.
9. Reuse before creating: if an extension/handler class for the target already exists in the custom model (`prepare(mode="change")` lists them), add the method there — never create a parallel feature-named class unless the user explicitly asks; never invent suffixes from feature/ticket/customer names
10. After writes, check the diff is additive (`review_workspace_changes` or re-read via `get_*_info`) — unrelated nodes disappearing = failed edit → `undo_last_modification`

## Terminal Note

Terminal commands work normally in Claude Code CLI. They will hang only when an AI is connected via VS 2022's MCP integration (which Claude Code CLI is not).

## Full Instructions

Complete X++ rules, query grammar, CoC authoring rules, and workflow details are delivered via the MCP prompt `xpp_system_instructions`. If that prompt is not loaded, request it or consult `src/prompts/systemInstructions.ts` directly.
