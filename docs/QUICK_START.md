# Quick Start Guide

Get the D365 F&O MCP Server running with GitHub Copilot in 5 steps.

> **Already deployed by your team on Azure?** Skip to [Step 3](#step-3--connect-copilot) —
> you only need a `.mcp.json` file.

---

## Step 1 — Install prerequisites

| Requirement | Where to get it |
|------------|----------------|
| Visual Studio 2022 ≥ 17.14 (or 2026) | Visual Studio Installer |
| GitHub Copilot extension | VS → Extensions → Manage Extensions |
| Node.js 24.x LTS | [nodejs.org](https://nodejs.org) or `Install-D365SupportingSoftware -Name node.js` |
| Python 3.x | Needed by `node-gyp` for native SQLite — bundled with Node.js installer if checked |
| .NET Framework 4.8 Developer Pack | Pre-installed on D365FO VMs; or via VS Installer ".NET desktop" workload |
| Git | [git-scm.com](https://git-scm.com) or `Install-D365SupportingSoftware -Name git` |

> Node.js, Python, and Git are NOT needed if your team uses the Azure-hosted server only (Scenario A).

---

## Step 2 — Clone and build

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install

# Build the C# bridge (required for file create/modify on Windows VMs)
cd bridge\D365MetadataBridge
dotnet build -c Release
cd ..\..

# Copy and edit environment config
copy .env.example .env
# Edit .env — set PACKAGES_PATH, CUSTOM_MODELS, LABEL_LANGUAGES

# Extract metadata and build search index
npm run extract-metadata
npm run build-database

# Compile TypeScript
npm run build
```

> **UDE / Power Platform Tools?** Run `npm run select-config` instead of setting `PACKAGES_PATH` manually.

> **Hybrid setup?** Skip `extract-metadata` and `build-database` — the index lives in Azure.
> You only need `npm install` + bridge build + `npm run build`.

---

## Step 3 — Connect Copilot

### 3a. Enable MCP in GitHub and Visual Studio

1. Go to **github.com/settings/copilot/features** → enable **MCP servers in Copilot**
2. In Visual Studio: **Tools → Options → GitHub → Copilot** → enable **"Enable MCP server integration in agent mode"**
3. Open Copilot Chat → switch to **Agent Mode** (not Ask or Edit)

### 3b. Create .mcp.json

Place the file in one of these locations:
- `%USERPROFILE%\.mcp.json` — covers all solutions on the machine (recommended)
- Next to a specific `.sln` file — covers only that solution

Pick the scenario that matches your setup:

---

#### Scenario A: Azure read-only (most teams)

Your team runs the MCP server on Azure. You only connect as a client — no local server needed.

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    }
  }
}
```

> Read-only. Cannot create/modify files on your local VM. Use Scenario B if you need writes.

---

#### Scenario B: Hybrid — Azure search + local writes (recommended for teams)

Azure handles metadata search. A local companion handles file creation/modification.

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
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"
      }
    }
  }
}
```

---

#### Scenario C: Local server only (single developer)

Everything runs on your development VM — both search and writes.

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "http://localhost:8080/mcp/"
    }
  }
}
```

Start the server: `cd K:\d365fo-mcp-server && npm run dev`

---

#### Scenario D: Local stdio — zero-config (single developer)

No HTTP server — Copilot spawns the process directly. Requires a pre-built database.

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata.db",
        "LABELS_DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata-labels.db",
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"
      }
    }
  }
}
```

> **UDE?** Replace `D365FO_WORKSPACE_PATH` with `D365FO_MODEL_NAME` + `D365FO_DEV_ENVIRONMENT_TYPE=ude`. See [Scenario D in SETUP.md](SETUP.md#scenario-d-ude-unified-developer-experience).

---

#### Scenario F: Multiple instances (one machine, multiple clients)

Running several D365FO environments from a single installation?
Use the `instances\add-instance.ps1` / `instances\rebuild-instance.ps1` / `instances\run-instance.ps1` scripts — each
instance gets its own `.env`, own database, and own port. Point a per-solution `.mcp.json`
at the correct port for seamless per-project Copilot context.
See [Scenario F in SETUP.md](SETUP.md#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments) for the full walkthrough.

---

## Step 4 — Place copilot-instructions.md

Copy the instruction file so Copilot knows D365FO workflow rules:

```powershell
# Place .github in a parent folder shared by all D365FO solutions:
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

VS 2022 searches for `.github\copilot-instructions.md` upward from the `.sln` folder —
one copy in a common parent covers all solutions underneath.

---

## Step 5 — Verify

Open Copilot Chat in Agent Mode and type:

```
What tables contain "CustAccount" field?
```

Copilot should call the `search` tool and return results from your D365FO codebase.
If it works, the MCP server is connected and operational.

For file operations, try:

```
Create a new class called TestHelper with a static method hello() that returns "Hello"
```

If this creates a file on disk, the C# bridge is working.

---

## Complete .mcp.json Reference

All available parameters in one block with comments:

```jsonc
{
  "servers": {
    // ── HTTP server entry (Azure or local npm run dev) ──────────────
    "d365fo-azure": {
      "url": "https://your-server.azurewebsites.net/mcp/"
      // Used in: Scenario A, B
    },

    // ── stdio / write-only companion ─────────────────────────────────
    "d365fo-local": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        // ── Server mode ──────────────────────────────────────────────
        // "full"       — all 54 tools (default for local)
        // "read-only"  — search/analysis tools only (Azure deployment)
        // "write-only" — file operations only (local companion in hybrid)
        "MCP_SERVER_MODE": "write-only",

        // ── Database paths (not needed for write-only) ──────────────
        "DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata.db",
        "LABELS_DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata-labels.db",

        // ── Solutions auto-scan ─────────────────────────────────────
        // Path to folder containing your .sln/.rnrproj files.
        // Server scans this to auto-detect projectPath and modelName.
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",

        // ── Logging ─────────────────────────────────────────────────
        // "DEBUG_LOGGING": "true",               // verbose JSON-RPC trace
        // "LOG_FILE": "C:\\Temp\\d365fo-mcp.log" // tee all output to file

        // ── Label options ───────────────────────────────────────────
        // "LABEL_SORT_ORDER": "append"            // "alphabetical" (default) or "append"

        // ── HTTP port (only for npm run dev, not stdio) ─────────────
        // "PORT": "8080",

        // ── D365FO context (replaces old "context" block) ───────────
        // Required: Two-level path PackagesLocalDirectory\Package\Model
        // Server auto-derives packagePath, packageName, modelName.
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName",

        // Optional overrides:
        // "D365FO_PACKAGE_PATH": "K:\\AosService\\PackagesLocalDirectory",
        // "D365FO_MODEL_NAME": "YourModelName",
        // "D365FO_PROJECT_PATH": "K:\\repos\\MySolution\\YourModel\\YourModel.rnrproj",
        // "D365FO_SOLUTION_PATH": "K:\\repos\\MySolution\\MySolution.sln",

        // UDE (Power Platform Tools):
        // "D365FO_DEV_ENVIRONMENT_TYPE": "auto",
        // "D365FO_CUSTOM_PACKAGES_PATH": "C:\\Users\\you\\AppData\\Local\\...\\CustomPackages",
        // "D365FO_MICROSOFT_PACKAGES_PATH": "C:\\Users\\you\\AppData\\Local\\...\\PackagesLocalDirectory",

        // Bridge diagnostics:
        // "D365FO_BRIDGE_LOG_FILE": "C:\\Temp\\d365fo-bridge.log"
      }
    }
  }
}
```

### Parameters by scenario

| Parameter | A (Azure) | B (Hybrid) | C (Local HTTP) | D (Local stdio) |
|-----------|:---------:|:----------:|:--------------:|:---------------:|
| `url` | **required** | **required** (Azure) | **required** | — |
| `command` + `args` | — | **required** (local) | — | **required** |
| `MCP_SERVER_MODE` | — | `write-only` | `full` (default) | `full` (default) |
| `D365FO_WORKSPACE_PATH` | — | **required** | **required** | **required** |
| `D365FO_PACKAGE_PATH` | — | optional | optional | optional |
| `D365FO_MODEL_NAME` | — | optional | optional | optional |
| `D365FO_PROJECT_PATH` | — | recommended | optional | optional |
| `D365FO_SOLUTION_PATH` | — | optional | optional | optional |
| `D365FO_SOLUTIONS_PATH` | — | recommended | optional | optional |
| `DB_PATH` | — | optional | auto | auto |
| `LABELS_DB_PATH` | — | optional | auto | auto |
| `D365FO_DEV_ENVIRONMENT_TYPE` | — | optional | optional | optional |
| `D365FO_CUSTOM_PACKAGES_PATH` | — | — | UDE only | UDE only |
| `D365FO_MICROSOFT_PACKAGES_PATH` | — | — | UDE only | UDE only |
| `D365FO_BRIDGE_LOG_FILE` | — | optional | optional | optional |
| `DEBUG_LOGGING` | — | optional | optional | optional |
| `LOG_FILE` | — | optional | optional | optional |
| `LABEL_SORT_ORDER` | — | optional | optional | optional |

---

## Logging & Diagnostics

When something isn't working, enable logging to see what the server is doing.

### Node.js server logging

Add these environment variables to the `env` block in `.mcp.json`:

| Variable | Effect |
|----------|--------|
| `DEBUG_LOGGING=true` | Enables verbose output: JSON-RPC request/response trace, bridge communication details, tool routing decisions |
| `LOG_FILE=C:\Temp\d365fo-mcp.log` | Tees all server output (stderr) to a file in append mode. Useful when VS Output window is truncated or noisy |

Example:

```json
"env": {
  "MCP_SERVER_MODE": "write-only",
  "DEBUG_LOGGING": "true",
  "LOG_FILE": "C:\\Temp\\d365fo-mcp.log"
}
```

Watch the log live:

```powershell
Get-Content "C:\Temp\d365fo-mcp.log" -Encoding UTF8 -Wait
```

### C# bridge logging

The bridge writes diagnostics to stderr. By default, only `[ERROR]` and `[WARN]` lines
are forwarded to the Node.js server. To capture everything (including `[DEBUG]`, `[INFO]`,
write tracing, form control traversal, etc.), set `D365FO_BRIDGE_LOG_FILE` in the `env` block:

```json
"env": {
  "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\...",
  "D365FO_BRIDGE_LOG_FILE": "C:\\Temp\\d365fo-bridge.log"
}
```

When set, the bridge tees all stderr to the log file (append mode) and the Node.js server
forwards all bridge lines (not just errors/warnings).

Bridge log levels: `[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]`, `[FATAL]`, `[ASSEMBLY]`

Watch the log live:

```powershell
Get-Content "C:\Temp\d365fo-bridge.log" -Encoding UTF8 -Wait -Tail 50
```

### Verifying bridge health

After starting, check the server log for:

```
✅ C# bridge initialized (metadataAvailable: true, xrefAvailable: true)
```

| What you see | Meaning |
|---|---|
| `metadataAvailable: true` | Bridge loaded D365FO DLLs — all tools work |
| `metadataAvailable: false` | DLL loading failed — check `packagePath` and `.NET 4.8` |
| `xrefAvailable: true` | SQL Server + `DYNAMICSXREFDB` accessible — cross-references work |
| `xrefAvailable: false` | SQL not available — non-critical, tools fall back to SQLite FTS |

---

## What's next?

| Topic | Documentation |
|-------|--------------|
| All 54 tools with parameters | [MCP_TOOLS.md](MCP_TOOLS.md) |
| Practical usage examples (CoC, reports, security) | [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) |
| Complete `.mcp.json` reference (all properties) | [MCP_CONFIG.md](MCP_CONFIG.md) |
| Server deployment to Azure | [SETUP.md](SETUP.md) / [SETUP_AZURE.md](SETUP_AZURE.md) |
| Multiple instances on one machine | [SETUP.md — Scenario F](SETUP.md#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments) |
| C# Bridge internals | [BRIDGE.md](BRIDGE.md) |
| Architecture overview | [ARCHITECTURE.md](ARCHITECTURE.md) |
| ISV / custom model configuration | [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) |
| Azure DevOps pipelines | [PIPELINES.md](PIPELINES.md) |
