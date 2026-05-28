# D365 Finance & Operations X++ Development

<!-- Thin pointer — full rules are delivered via the MCP `xpp_system_instructions` prompt.
     This file provides only the minimum static context needed when the MCP server
     is not yet connected or the prompt hasn't been loaded. -->

## Quick Start

This workspace contains a D365FO MCP server. **Always use the specialized MCP tools** for D365FO objects (.xml/.xpp/.rnrproj/.label.txt). Built-in file/search tools are fine for .cs, .json, .yml, .md, .config files.

## Mandatory First Check

Call `get_workspace_info()` before doing anything with D365FO objects.

| Response | Action |
|----------|--------|
| Call fails | STOP. MCP server not connected. Ask user to start it. |
| `⛔ CONFIGURATION PROBLEM` | STOP. Relay message. Wait for user. |
| `✅ Configuration looks valid` | Note model name. Proceed. |

## Terminal Prohibition

PowerShell / any terminal command **WILL HANG** in VS 2022 / VS 2026 MCP integration. Never use `run_in_terminal` or generate scripts as fallback when an MCP tool fails — STOP and report the error.

## Core Tool Mapping

| Action | Tool |
|--------|------|
| Create D365FO object | `create_d365fo_file` (never `create_file`) |
| Edit existing object | `modify_d365fo_file` with `dryRun=true` first |
| Search objects | `search()` / `batch_search()` |
| Read class/table/form | `get_class_info` / `get_table_info` / `get_form_info` |
| Method signature (for CoC) | `get_method_signature` |
| Build/BP/Sync | `build_d365fo_project` / `run_bp_check` / `trigger_db_sync` |
| Error diagnosis | `get_d365fo_error_help(errorText)` |

## Key Rules (condensed)

1. Model name comes from `.mcp.json` — never infer from search results
2. `dryRun=true` is mandatory for every `modify_d365fo_file` — VS 2022 has no undo UI
3. Never run `build_d365fo_project()` automatically — only on explicit user request
4. Never copy default parameter values into CoC wrapper signatures
5. Never use `today()` — use `DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone())`
6. Never use hardcoded strings in Info/warning/error — use `@Model:Label`
7. Call `search_labels()` before `create_label()` — reuse existing labels
8. Extension naming depends on `EXTENSION_NAMING_STYLE` (check `get_workspace_info`). Default `prefix` → class `{Target}{Prefix}_Extension`, element `{Target}.{Prefix}Extension`; `model-name` → class `{Target}_{ModelName}_Extension`, element `{Target}.{ModelName}`. Pass the BASE name to `create_d365fo_file` and let the tool apply the token — don't hand-build the infix.

## Full Instructions

The complete X++ rules, query grammar, CoC authoring rules, and workflow details are delivered via the MCP prompt `xpp_system_instructions`. If that prompt is not loaded, request it or consult `src/prompts/systemInstructions.ts` directly.

