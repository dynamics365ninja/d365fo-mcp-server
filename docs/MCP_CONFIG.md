# MCP Configuration (.mcp.json)

The `.mcp.json` file tells the MCP server where your D365FO project lives. Without it the
server still works, but file creation may land in the wrong model.

> **Quick Start?** See [QUICK_START.md](QUICK_START.md) for step-by-step setup with examples.

---

## Minimal Configuration

Place this file in the root of your Visual Studio solution (next to the `.sln` file):

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"
      }
    }
  }
}
```

That is all most users need. From this single path the server automatically derives:

| Derived value | Example |
|---------------|---------|
| `packagePath` | `K:\AosService\PackagesLocalDirectory` |
| `packageName` | `YourPackageName` |
| `modelName`   | `YourModelName` |

The server will also:
- Automatically find your `.rnrproj` file in the open workspace
- Write any new files to the right location under PackagesLocalDirectory

---

## Transport Modes

### stdio (recommended for local / single-developer setup)

The server is launched directly by the MCP client as a subprocess. No HTTP server, no port.
VS 2022 and VS 2026 both support this via the `command:` key.

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["C:\\path\\to\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "DB_PATH": "C:\\path\\to\\d365fo-mcp-server\\data\\xpp-metadata.db",
        "LABELS_DB_PATH": "C:\\path\\to\\d365fo-mcp-server\\data\\xpp-metadata-labels.db",
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"
      }
    }
  }
}
```

Key points:
- `DB_PATH` / `LABELS_DB_PATH` must be **absolute paths** — the server's working directory in
  stdio mode is controlled by the client, not the repo folder.
- `D365FO_SOLUTIONS_PATH` — folder containing your `.rnrproj` files. The server scans it at
  startup and auto-detects the model name. Required for reliable model detection.
- `D365FO_WORKSPACE_PATH` — path to your model folder. The server derives packagePath,
  packageName, and modelName from it.
- `MCP_SERVER_MODE` defaults to `full` — omit it unless you need `read-only` or `write-only`.

#### Enabling diagnostics

Add `DEBUG_LOGGING` and `LOG_FILE` to the `env` block to capture a full session trace:

```json
"env": {
  "DB_PATH": "C:\\path\\to\\data\\xpp-metadata.db",
  "LABELS_DB_PATH": "C:\\path\\to\\data\\xpp-metadata-labels.db",
  "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
  "DEBUG_LOGGING": "true",
  "LOG_FILE": "C:\\Temp\\d365fo-mcp.log"
}
```

The log file collects all output including JSON-RPC messages and is useful when the VS 2022
Output window is too noisy or truncated. Open it with any text editor or watch live with:

```powershell
Get-Content "C:\Temp\d365fo-mcp.log" -Encoding UTF8 -Wait
```

#### C# bridge diagnostics

The C# bridge (`D365MetadataBridge.exe`) has its own diagnostic output (`[WriteService]` messages)
that is normally filtered — only `[ERROR]` and `[WARN]` lines reach the TS server. To capture
**all** bridge diagnostics (including `replace-code` tracing, form control traversal, etc.),
add `D365FO_BRIDGE_LOG_FILE` to the `env` block:

```json
"env": {
  "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel",
  "D365FO_BRIDGE_LOG_FILE": "C:\\Temp\\d365fo-bridge.log"
}
```

When set, `D365FO_BRIDGE_LOG_FILE` does two things:
1. The bridge process tees all its stderr to the log file (append mode)
2. The TS server forwards **all** bridge stderr lines (not just errors/warnings)

Bridge log levels: `[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]`, `[FATAL]`, `[ASSEMBLY]`

Watch live:
```powershell
Get-Content "C:\Temp\d365fo-bridge.log" -Encoding UTF8 -Wait -Tail 50
```

### HTTP (Azure-hosted or `npm run dev`)

The server listens on a TCP port. Used for Azure deployments and for local `npm run dev` sessions.

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    }
  }
}
```

> **Note:** `D365FO_WORKSPACE_PATH` cannot be passed via `env` for HTTP-only servers (no subprocess).
> The Azure server uses the workspace path sent by VS Code/VS 2022 in request headers. If your
> client does not send workspace headers, the server relies on auto-detection.

If the server has `API_KEY` authentication enabled, add a `headers` block:

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "https://your-server.azurewebsites.net/mcp/",
      "headers": {
        "X-Api-Key": "your-api-key-here"
      }
    }
  }
}
```

---

## All Configuration Options

### Traditional

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName",
        "D365FO_PROJECT_PATH": "K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj"
      }
    }
  }
}
```

### UDE (Unified Developer Experience)

For UDE environments using Power Platform Tools in VS2022, the server supports dual metadata
roots — one for your custom code and one for Microsoft standard packages:

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_MODEL_NAME": "YourModelName",
        "D365FO_CUSTOM_PACKAGES_PATH": "C:\\CustomXppCode",
        "D365FO_MICROSOFT_PACKAGES_PATH": "C:\\Users\\...\\Dynamics365\\10.0.2428.63\\PackagesLocalDirectory",
        "D365FO_DEV_ENVIRONMENT_TYPE": "ude"
      }
    }
  }
}
```

In most UDE setups you do not need to set these manually — the server reads your XPP config
files from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\` and detects the paths automatically.

### All Properties

All context properties can be set via environment variables in the `env` block of your
server definition. This is the **recommended approach** as it avoids schema conflicts
with VS 2022's `.mcp.json` parser.

| Property | Env variable | Required | What it does |
|----------|-------------|----------|-------------|
| `workspacePath` | `D365FO_WORKSPACE_PATH` | Recommended | Path to your model: `...\PackagesLocalDirectory\PackageName\ModelName`. All three values are derived from it automatically. |
| `packagePath` | `D365FO_PACKAGE_PATH` | Optional | Base PackagesLocalDirectory path. Auto-extracted from `workspacePath` — only needed when `workspacePath` is not set. |
| `modelName` | `D365FO_MODEL_NAME` | Optional | Explicit model name override — only needed when it differs from the last `workspacePath` segment. |
| `customPackagesPath` | `D365FO_CUSTOM_PACKAGES_PATH` | Optional | UDE: Custom X++ code root (from XPP config `ModelStoreFolder`). |
| `microsoftPackagesPath` | `D365FO_MICROSOFT_PACKAGES_PATH` | Optional | UDE: Microsoft X++ root (from XPP config `FrameworkDirectory`). |
| `devEnvironmentType` | `D365FO_DEV_ENVIRONMENT_TYPE` | Optional | `auto` (default), `traditional`, or `ude`. Controls path resolution behavior. |
| `projectPath` | `D365FO_PROJECT_PATH` | Optional | Full path to your `.rnrproj` file. Auto-detected from roots/list (stdio) or D365FO_SOLUTIONS_PATH. |
| `solutionPath` | `D365FO_SOLUTION_PATH` | Optional | Visual Studio solution folder. Used when `projectPath` is not set. |
| `bridgeLogFile` | `D365FO_BRIDGE_LOG_FILE` | Optional | Absolute path to a C# bridge log file (e.g. `C:\Temp\d365fo-bridge.log`). When set, the bridge tees all diagnostic output to this file in append mode, and the TS server forwards all bridge stderr lines (not just `[ERROR]`/`[WARN]`). Useful for debugging `modify_d365fo_file` issues (replace-code, form control traversal, etc.). |

> **Note:** The legacy `"context": { ... }` section inside `"servers"` is still supported for
> backward compatibility, but is **deprecated** — VS 2022/VS 2026 interprets every key under
> `"servers"` as an MCP server definition, causing activation failures. Use `env` variables instead.

### Environment Variables (stdio `env` block)

| Variable | Required | What it does |
|----------|----------|--------------|
| `DB_PATH` | Yes (stdio) | Absolute path to `xpp-metadata.db`. Must be absolute — cwd is not the repo folder in stdio mode. |
| `LABELS_DB_PATH` | Yes (stdio) | Absolute path to `xpp-metadata-labels.db`. Same reason as DB_PATH. |
| `D365FO_SOLUTIONS_PATH` | Recommended | Folder containing D365FO `.rnrproj` files. Server scans it at startup for model auto-detection and lists all found projects in `get_workspace_info`. Required for project switching by name (`projectName` parameter). |
| `D365FO_WORKSPACE_PATH` | Recommended | Path to your model folder (`PackagesLocalDirectory\Package\Model`). Server derives packagePath, packageName, and modelName from it. |
| `D365FO_PACKAGE_PATH` | Optional | Explicit PackagesLocalDirectory path. Auto-extracted from `D365FO_WORKSPACE_PATH` if not set. |
| `D365FO_MODEL_NAME` | Optional | Explicit model name — overrides auto-detection. |
| `D365FO_PROJECT_PATH` | Optional | Full path to `.rnrproj` file — overrides auto-detection. |
| `D365FO_SOLUTION_PATH` | Optional | Full path to `.sln` file — overrides auto-detection. |
| `D365FO_BRIDGE_LOG_FILE` | Optional | Path to C# bridge diagnostic log file (append mode). Captures all bridge stderr output. |
| `D365FO_DEV_ENVIRONMENT_TYPE` | Optional | `auto` (default), `traditional`, or `ude`. |
| `D365FO_CUSTOM_PACKAGES_PATH` | Optional | UDE: custom X++ code root. |
| `D365FO_MICROSOFT_PACKAGES_PATH` | Optional | UDE: Microsoft X++ root. |
| `MCP_SERVER_MODE` | No | `full` (default), `read-only`, or `write-only`. Only needed in hybrid setups. |
| `MCP_TOOL_TIMEOUT_MS` | No | Default HTTP transport per-request timeout in ms (default: 120000). Acts as the catch-all ceiling for tools not in the fast/heavy class below. |
| `MCP_TOOL_TIMEOUT_FAST_MS` | No | Per-tool timeout (ms) for fast read tools: `search`, `batch_search`, `get_*_info`, `search_labels`, `get_label_info`. Default: 30000. Raise on slow storage (Azure SMB). |
| `MCP_TOOL_TIMEOUT_HEAVY_MS` | No | Per-tool timeout (ms) for heavy tools: `build_d365fo_project`, `trigger_db_sync`, `run_bp_check`, `run_systest_class`, `update_symbol_index`. Default: 600000 (10 min). |
| `D365FO_FS_SCAN_TIMEOUT_MS` | No | Budget (ms) for the filesystem extension-scanner fallback (table/form/class extension lookup). Default: 3000. |
| `D365FO_DISABLE_FS_FALLBACK` | No | `true` disables the disk scan that runs when the symbol index has no data for an extension. Recommended in production where the index is authoritative and a stale scan would mask missing data. |
| `MCP_FORCE_HTTP` | No | Set to `true` to prevent stdio mode even when stdin is piped (rare). |
| `ENV_FILE` | No | Absolute or relative path to a `.env` file. When set, the server loads that file instead of the default repo-root `.env`. Use this to run multiple instances of the server from a single installation — each instance has its own `.env` with its own `PORT`, `DB_PATH`, and `METADATA_PATH`. Relative paths in `DB_PATH`, `LABELS_DB_PATH`, and `METADATA_PATH` inside the target file are resolved relative to that file's directory. See [Scenario F in SETUP.md](SETUP.md#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments). |
| `DEBUG_LOGGING` | No | Set to `true` to enable verbose raw JSON-RPC trace on stderr. Every message VS 2022 sends to the server (`[VS→MCP]`) and every reply the server sends back (`[MCP→VS]`) is printed with a relative timestamp. Useful for diagnosing handshake failures or unexpected tool responses. Works in both stdio and HTTP mode. |
| `LOG_FILE` | No | Absolute path to a log file (e.g. `C:\\Temp\\d365fo-mcp.log`). All stderr output — including JSON-RPC trace when `DEBUG_LOGGING=true` — is **tee'd** to this file in addition to the normal stderr stream. The file is opened in append mode at process startup, so multiple sessions accumulate in one file. A banner line with the timestamp and PID is written at the start of each session. Useful on Windows where the VS 2022 Output window truncates long lines and does not persist across sessions. |

### When do you need the optional properties?

You only need to set `projectPath` or `solutionPath` explicitly if:
- You have **multiple D365FO projects** in one solution and need to pin a specific one
- Your `.rnrproj` is in an **unusual location** that auto-detection cannot find
- You want to **override** what GitHub Copilot auto-detects

You only need to set `customPackagesPath` or `microsoftPackagesPath` if:
- You are using UDE and the **auto-detection from XPP config files** is not working
- You want to **override** the paths discovered from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`

---

## How Path Resolution Works

When the server needs to create a file, it resolves the target path in this order:

**Traditional mode:**

1. **Tool argument** — if the tool call itself includes a `packagePath`, that wins
2. **`.mcp.json` packagePath** — explicit value from the config file
3. **Auto-extracted from `workspacePath`** — everything up to `PackagesLocalDirectory` is used as the base
4. **Default fallback** — `K:\AosService\PackagesLocalDirectory`

**UDE mode:**

1. **`D365FO_CUSTOM_PACKAGES_PATH` / `D365FO_MICROSOFT_PACKAGES_PATH` env vars**
2. **XPP config auto-detection** — reads `ModelStoreFolder` and `FrameworkDirectory` from the config file selected by `XPP_CONFIG_NAME` (or the newest) in `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`
3. **Fallback** — existing `PACKAGES_PATH` env var or `packagePath` from `.mcp.json`

In D365FO, a package can contain multiple models (e.g., package "CustomExtensions" may contain
models "Contoso Utilities" and "Contoso Reporting"). The two-level `workspacePath` format
(`PackagesLocalDirectory\PackageName\ModelName`) encodes both, so the server knows exactly
which package directory to write to without any descriptor XML scanning. In UDE mode, the server
also auto-resolves package names by reading descriptor XML files. In traditional mode, it defaults
to assuming package name equals model name.

For the model name used when creating files:
1. **Explicit `D365FO_MODEL_NAME` env var** — always wins
2. **Last segment of `D365FO_WORKSPACE_PATH`** — only when the path contains `PackagesLocalDirectory` (AOT paths). Skipped for repo paths like `K:\repos\Contoso` to avoid returning the repo folder name instead of the real model.
3. **Auto-detected from `.rnrproj`** — triggered by roots/list protocol (stdio), `D365FO_SOLUTIONS_PATH` scan, or workspace seed from env vars

Each resolved value and its detection source are visible in `get_workspace_info` output.

---

## File Location

The server searches for `.mcp.json` starting from the current working directory and
walking up to 5 parent levels. Place it in the solution root for best results:

```
K:\VSProjects\MySolution\
├── .mcp.json          ← place here
├── MySolution.sln
└── MyProject\
    └── MyProject.rnrproj
```

---

## Common Mistakes

**Wrong model when creating files**
If new files end up inside a Microsoft standard model (ApplicationSuite, etc.),
add `workspacePath` pointing to your custom model folder. The server will then
extract the correct model name from the `.rnrproj` in your workspace automatically.

**Backslashes on Windows**
In JSON, backslashes must be doubled: `K:\\AosService\\` not `K:\AosService\`.

---

## Hybrid Setup (Azure + Local)

When the MCP server is deployed to Azure, `create_d365fo_file`, `modify_d365fo_file`, and
`create_label` cannot write to the local Windows VM file system. The **hybrid setup** solves
this by running two servers simultaneously:

| Instance | Runs on | `MCP_SERVER_MODE` | Tools |
|----------|---------|-------------------|-------|
| `d365fo-azure` | Azure App Service | `read-only` | 29 search & analysis tools |
| `d365fo-local` | Windows VM (stdio) | `write-only` | 25 tools: write tools + bridge-backed read tools (see below) |

GitHub Copilot connects to both servers at the same time and selects the right one automatically.

### .mcp.json for hybrid setup

```json
{
  "servers": {
    "d365fo-azure": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    },
    "d365fo-local": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "MCP_SERVER_MODE": "write-only",
        "D365FO_SOLUTIONS_PATH": "K:\\VSProjects\\MySolution",
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName",
        "D365FO_PACKAGE_PATH": "K:\\AosService\\PackagesLocalDirectory"
      }
    }
  }
}
```

> **Note:** The `--stdio` argument is no longer needed — the server detects stdio mode
> automatically via `process.stdin.isTTY`.

### How it works

1. `d365fo-azure` starts with `MCP_SERVER_MODE=read-only` → only exposes search/analysis tools
2. `d365fo-local` starts with `MCP_SERVER_MODE=write-only` → only exposes file-operation tools
3. GitHub Copilot aggregates both tool lists — from Copilot's perspective it sees all 54 tools
4. When Copilot calls `create_d365fo_file`, it goes to the local server which has K:\ access
5. When Copilot calls `search`, it goes to the Azure server with the full metadata database

### Verifying the tool filtering

When the server starts, it logs the detected mode and tool count:

**Write-only mode (local companion):**
```
🔧 Server mode: write-only (from env: write-only)
🎯 Registered 25 X++ MCP tools (write tools + bridge-backed read tools)
[MCP Server] Tool list filtered for write-only mode: 25 tools
```

**Read-only mode (Azure server):**
```
🔧 Server mode: read-only (from env: read-only)
🎯 Registered 29 X++ MCP tools (all except local tools)
[MCP Server] Tool list filtered for read-only mode: 29 tools (local tools excluded)
```

**Full mode (local development):**
```
🔧 Server mode: full (from env: not set, defaulting to full)
🎯 Registered 54 X++ MCP tools (full mode)
[MCP Server] Tool list in full mode: 54 tools (no filtering)
```

> **Note:** The local server in `write-only` mode skips database download and the symbol
> index entirely — it only needs `.mcp.json` for path resolution. Redis and Azure Blob Storage
> are not required. `get_workspace_info` and `verify_d365fo_project` are included in
> `write-only` mode because they read local K:\ filesystem paths not accessible from Azure.

### Azure App Service settings for read-only mode

The `MCP_SERVER_MODE=read-only` environment variable is **automatically set** when deploying via:
- The Bicep infrastructure template (`infrastructure/main.bicep`)
- The Azure DevOps deployment pipeline (`.azure-pipelines/d365fo-mcp-app-deploy.yml`)

If you're deploying manually or through a different method, ensure you add this setting in your Azure App Service configuration:

```
MCP_SERVER_MODE=read-only
```

This ensures write tools are never advertised over the public URL, even if someone calls them directly.

---

## See Also

- [BRIDGE.md](BRIDGE.md) — C# metadata bridge configuration and architecture (Windows D365FO VMs only)
- [SETUP.md](SETUP.md) — Client setup guide
- [SETUP_AZURE.md](SETUP_AZURE.md) — Azure deployment guide
