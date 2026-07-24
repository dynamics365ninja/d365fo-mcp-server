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
| Process / memory | one process **per client** — each loads its own copy of the symbol index (~1.5 GB) | one shared process — index loaded **once** for all connected clients |
| Workspace context | full (`env` block) | headers only — limited |
| Auth | n/a | optional `headers: { "X-Api-Key": "..." }` |

> stdio note: `DB_PATH`/`LABELS_DB_PATH` must be **absolute** — the working directory is controlled by the client, not the repo.
>
> HTTP note: `D365FO_WORKSPACE_PATH` cannot be passed (no subprocess). For reliable model targeting combine HTTP search with a stdio write-only companion ([hybrid](#hybrid-mode-summary)).
>
> Multiple clients note: if several clients (e.g. VS Code + the CLI) talk to the **same** code base at once, prefer one local HTTP instance ([Scenario C](SETUP.md#scenario-c--local-http)). stdio spawns a separate subprocess per client, so each one loads its own ~1.5 GB index; a single HTTP instance loads it once and serves them all.

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
| `D365FO_CUSTOM_PACKAGES_PATH` | UDE / repo layouts | custom **write root**. UDE: X++ root (`ModelStoreFolder`), auto-detected. Traditional: the package root holding your custom models when they live **outside** `PackagesLocalDirectory` (e.g. a Git checkout junctioned into PLD) — see [Symlink / junction layouts](#symlink--junction-layouts) |
| `D365FO_MICROSOFT_PACKAGES_PATH` | UDE only | Microsoft X++ root (`FrameworkDirectory`) — read-only, never a write target |
| `D365FO_BRIDGE_LOG_FILE` | optional | tee **all** C# bridge diagnostics to a file (debugging `d365fo_file` writes) |

## Server variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_SERVER_MODE` | `full` | `full` (26 tools) / `read-only` (Azure) / `write-only` (hybrid companion) |
| `DB_PATH` / `LABELS_DB_PATH` | repo `data/` | absolute paths to the SQLite databases — **required in stdio mode** |
| `GROUNDING_ENFORCE` | on | fail-closed grounding gate for write tools |
| `GROUNDING_SECRET` | — | shared secret → HMAC-signed portable grounding tokens; required for enforcement in hybrid / scaled-out deployments |
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

## Symlink / junction layouts

A common D365FO setup keeps custom metadata in a **Git working tree** and exposes it to the AOS by **junctioning** the package into `PackagesLocalDirectory`:

```
K:\AosService\PackagesLocalDirectory\MyPackage   ──junction──▶   K:\repos\MyMetadataRepo\metadata\MyPackage
```

With this layout `create` works without extra config — it builds the target from `D365FO_PACKAGE_PATH` and writes straight through the junction. But `modify` (add field/index, edit a table) resolves the object via the C# bridge, and the write-path guard runs `realpath`, which **follows the junction to the real location**:

```
❌ Refusing to write outside configured D365FO package roots.
   resolved path: K:/repos/MyMetadataRepo/metadata/MyPackage/...   ← realpath followed the junction
   allowed roots:
     - K:/AosService/PackagesLocalDirectory                        ← junction target is not under here
```

This is **not** a path-separator issue, and the guard is working as intended — the junction *target* simply isn't a configured root.

**Fix — add the junction target (the repo metadata root) as a write root:**

```json
"env": {
  "D365FO_PACKAGE_PATH": "K:\\AosService\\PackagesLocalDirectory",
  "D365FO_CUSTOM_PACKAGES_PATH": "K:\\repos\\MyMetadataRepo\\metadata"
}
```

Then **restart the server** — re-spawn the node process; editing `.mcp.json` alone does not reload `env`. Verify it took effect: on the next failure the `allowed roots` list must now include the repo path. In traditional mode `D365FO_CUSTOM_PACKAGES_PATH` takes precedence over `D365FO_PACKAGE_PATH` as the write root, so `create` and `modify` both target the repo — and because the junction points there, they operate on the **same physical files** (no split-brain, no orphaned copies in PLD).

Notes:
- Confirm a path is a junction: `fsutil reparsepoint query "K:\AosService\PackagesLocalDirectory\MyPackage"` or `dir /AL K:\AosService\PackagesLocalDirectory` (shows `<JUNCTION>` / `<SYMLINKD>`).
- One-off without restarting: pass `packagePath="K:/repos/MyMetadataRepo/metadata"` directly on the `d365fo_file` call — the error message also prints the exact value to use.
- `add-index` runs through the C# bridge, which has its own startup roots; if it still can't resolve after the above, fall back to `overwrite=true` or an explicit `filePath`.

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Files land in a Microsoft model | set the two-level `D365FO_WORKSPACE_PATH` to **your** model |
| Single backslashes in JSON | escape them: `K:\\AosService\\...` |
| `DB_PATH` relative in stdio mode | must be absolute |
| Legacy `"context"` block | move values to `env` variables |
| Expecting workspace context over HTTP | use the hybrid stdio companion |
| `modify` fails with "outside package roots" but `create` works | metadata is junctioned into PLD — add the junction target as `D365FO_CUSTOM_PACKAGES_PATH` and restart ([details](#symlink--junction-layouts)) |

## Automatic workspace detection

When you open a D365FO solution in VS 2022/2026 over **stdio**, the server detects your model automatically — no manual config:

1. After the handshake the client sends a `roots/list` response with the open folder URI.
2. The server finds the nearest `.rnrproj` (≤ 6 levels deep) and reads its `<Model>` element.
3. All writes target that model. Fallback chain: `VSCODE_WORKSPACE_FOLDER_PATHS` → `process.cwd()`.

Set `D365FO_SOLUTIONS_PATH` to the folder holding your `.rnrproj` files so the server lists every project and can switch between them without a restart — say *"switch to ContosoEDS project"* (Copilot calls `get_workspace_info` with `projectName`), or pass an exact `projectPath`. Over **HTTP** there is no subprocess, so pass the two-level `D365FO_WORKSPACE_PATH` (`…\PackagesLocalDirectory\<Package>\<Model>`) instead. Every resolved value and its source is shown by `get_workspace_info`.

## See also

[SETUP.md](SETUP.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [SETUP_AZURE.md](SETUP_AZURE.md)
