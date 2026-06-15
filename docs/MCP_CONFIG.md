# Configuration Reference — .mcp.json

`.mcp.json` tells the MCP client how to reach the server and tells the server where your D365FO project lives. Without it the server still works, but file creation may target the wrong model.

> Step-by-step setup: [QUICK_START.md](QUICK_START.md) · scenarios: [SETUP.md](SETUP.md)

---

## Minimal configuration

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel"
      }
    }
  }
}
```

One path, three derived values — plus automatic `.rnrproj` discovery:

| Derived | Example |
|---------|---------|
| `packagePath` | `K:\AosService\PackagesLocalDirectory` |
| `packageName` | `YourPackage` |
| `modelName` | `YourModel` |

---

## Transports

| | stdio (recommended locally) | HTTP (Azure / `npm run dev`) |
|---|---------------------------|------------------------------|
| Config key | `command` + `args` + `env` | `url` |
| Started by | the MCP client (VS / Claude), no port | you / Azure |
| Workspace context | full (`env` block) | headers only — limited |
| Auth | n/a | optional `headers: { "X-Api-Key": "..." }` |

> stdio note: `DB_PATH`/`LABELS_DB_PATH` must be **absolute** — the working directory is controlled by the client, not the repo.
>
> HTTP note: `D365FO_WORKSPACE_PATH` cannot be passed (no subprocess). For reliable model targeting combine HTTP search with a stdio write-only companion ([hybrid](#hybrid-mode-summary)).

---

## D365FO context variables

Set in the `env` block. The legacy `"context": {...}` block is **deprecated** — VS treats every key under `servers` as a server definition.

| Variable | Required | Purpose |
|----------|----------|---------|
| `D365FO_WORKSPACE_PATH` | recommended | `...\PackagesLocalDirectory\<Package>\<Model>` — packagePath/packageName/modelName derived automatically |
| `D365FO_SOLUTIONS_PATH` | recommended | folder with your `.rnrproj` files — scanned at startup for model auto-detection and project switching |
| `D365FO_PROJECT_PATH` | optional | pin an exact `.rnrproj` (multiple projects in one solution) |
| `D365FO_SOLUTION_PATH` | optional | `.sln` folder, used when `projectPath` is not set |
| `D365FO_PACKAGE_PATH` | optional | explicit PackagesLocalDirectory — only when `workspacePath` is not set |
| `D365FO_MODEL_NAME` | optional | explicit model override (always wins) |
| `D365FO_DEV_ENVIRONMENT_TYPE` | optional | `auto` (default) / `traditional` / `ude` |
| `D365FO_CUSTOM_PACKAGES_PATH` | UDE only | custom X++ root (XPP config `ModelStoreFolder`) — auto-detected normally |
| `D365FO_MICROSOFT_PACKAGES_PATH` | UDE only | Microsoft X++ root (`FrameworkDirectory`) — read-only, never a write target |
| `D365FO_BRIDGE_LOG_FILE` | optional | tee **all** C# bridge diagnostics to a file (debugging `d365fo_file` writes) |

## Server variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_SERVER_MODE` | `full` | `full` (26 tools) / `read-only` (Azure) / `write-only` (hybrid companion) |
| `DB_PATH` / `LABELS_DB_PATH` | repo `data/` | absolute paths to the SQLite databases — **required in stdio mode** |
| `GROUNDING_ENFORCE` | on | fail-closed grounding gate for write tools |
| `FORM_PATTERN_ENFORCE` | on | block form writes on structural pattern violations (FP001–FP010) |
| `DEBUG_LOGGING` | off | verbose JSON-RPC trace (`[VS→MCP]` / `[MCP→VS]`) on stderr |
| `LOG_FILE` | — | tee all stderr (incl. trace) to a file, append mode, session banner per start |
| `MCP_TOOL_TIMEOUT_MS` | 120000 | catch-all per-request timeout |
| `MCP_TOOL_TIMEOUT_FAST_MS` | 30000 | fast read tools (`search`, `get_*_info`, labels) — raise on slow storage |
| `MCP_TOOL_TIMEOUT_HEAVY_MS` | 600000 | heavy tools (`build_d365fo_project`, sync, BP, tests, reindex) |
| `D365FO_FS_SCAN_TIMEOUT_MS` | 3000 | budget for the filesystem extension-scanner fallback |
| `D365FO_DISABLE_FS_FALLBACK` | off | `true` = trust the index, skip disk scans (recommended in production) |
| `ENV_FILE` | repo `.env` | load an alternative `.env` — the basis of [multi-instance setups](SETUP.md#scenario-f--multiple-instances) |
| `MCP_FORCE_HTTP` | off | prevent stdio detection even when stdin is piped (rare) |

Watch logs live:

```powershell
Get-Content "C:\Temp\d365fo-mcp.log" -Encoding UTF8 -Wait
Get-Content "C:\Temp\d365fo-bridge.log" -Encoding UTF8 -Wait -Tail 50
```

---

## Path resolution order

**Write target (traditional):** tool argument `packagePath` → `D365FO_PACKAGE_PATH` → derived from `D365FO_WORKSPACE_PATH` → fallback `K:\AosService\PackagesLocalDirectory`

**Write target (UDE):** explicit env paths → XPP config auto-detection (`%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`, selected by `XPP_CONFIG_NAME` or newest) → `PACKAGES_PATH` fallback

**Model name:** `D365FO_MODEL_NAME` → last segment of `D365FO_WORKSPACE_PATH` (AOT paths only) → auto-detected from `.rnrproj` (MCP roots / `D365FO_SOLUTIONS_PATH` scan)

A package may contain multiple models — the two-level `workspacePath` encodes both, so writes land in the right folder without descriptor scanning. Every resolved value and its source is visible in `get_workspace_info`.

---

## Hybrid mode summary

Two servers, one merged tool list — Copilot/Claude routes calls automatically:

| Instance | Host | Mode | Exposes |
|----------|------|------|---------|
| `d365fo-azure` | App Service | `read-only` | search & analysis tools |
| `d365fo-local` | Windows VM (stdio) | `write-only` | write tools + bridge-backed reads + `get_workspace_info`/`verify_d365fo_project` |

The write-only companion skips database download entirely — it starts in under a second and needs no Blob.

Startup logs confirm the filtering:

```
🔧 Server mode: write-only (from env: write-only)
[MCP Server] Tool list filtered for write-only mode
```

> When deploying via the Bicep template or the DevOps pipeline, `MCP_SERVER_MODE=read-only` is set automatically on the App Service — write tools are never advertised on the public URL.

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Files land in a Microsoft model | set the two-level `D365FO_WORKSPACE_PATH` to **your** model |
| Single backslashes in JSON | escape them: `K:\\AosService\\...` |
| `DB_PATH` relative in stdio mode | must be absolute |
| Legacy `"context"` block | move values to `env` variables |
| Expecting workspace context over HTTP | use the hybrid stdio companion |

## See also

[SETUP.md](SETUP.md) · [BRIDGE.md](BRIDGE.md) · [WORKSPACE_DETECTION.md](WORKSPACE_DETECTION.md) · [SETUP_AZURE.md](SETUP_AZURE.md)
