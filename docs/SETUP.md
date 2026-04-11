# Setup Guide — Client Configuration

This guide covers everything a **developer** needs to start using the D365 F&O MCP Server
with GitHub Copilot in Visual Studio 2022 and 2026.

> **Just want to get running fast?** See [QUICK_START.md](QUICK_START.md) for the condensed 5-step guide.

If you are responsible for deploying the server infrastructure to Azure, see [SETUP_AZURE.md](SETUP_AZURE.md).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1 — Enable MCP in GitHub and Visual Studio](#step-1--enable-mcp-in-github-and-visual-studio)
- [Step 2 — Place copilot-instructions.md](#step-2--place-copilot-instructionsmd)
- [Step 3 — Create .mcp.json](#step-3--create-mcpjson)
  - [Scenario A: Azure-hosted server (most teams)](#scenario-a-azure-hosted-server-most-teams)
  - [Scenario B: Hybrid — Azure search + local file writes](#scenario-b-hybrid--azure-search--local-file-writes)
  - [Scenario C: Local server only](#scenario-c-local-server-only)
  - [Scenario D: UDE (Unified Developer Experience)](#scenario-d-ude-unified-developer-experience)
  - [Scenario E: Local stdio server (single developer, zero-config)](#scenario-e-local-stdio-server-single-developer-zero-config)
  - [Scenario F: Multiple instances — one machine, multiple D365FO environments](#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments)
- [Building the C# Bridge](#building-the-c-bridge)
- [Where to place .mcp.json](#where-to-place-mcpjson)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Component | Minimum version | Notes |
|-----------|----------------|-------|
| Visual Studio 2022 | 17.14 | Earlier versions do not support MCP |
| Visual Studio 2026 | Any | Fully supported |
| GitHub Copilot extension | Latest | Requires an active Copilot subscription |
| Node.js | 24.x LTS | Required for local/hybrid setup |
| Python | 3.x | Required for local/hybrid setup — used by `node-gyp` to compile native SQLite addon |
| .NET Framework 4.8 Developer Pack | 4.8 | **Required** for the C# metadata bridge (all write operations). Pre-installed on D365FO VMs. |
| Git | Any | Required for local/hybrid setup |

---

## Step 1 — Enable MCP in GitHub and Visual Studio

1. Go to **https://github.com/settings/copilot/features** and enable **MCP servers in Copilot**.

2. In Visual Studio: **Tools → Options → GitHub → Copilot**
   → Enable **"Enable MCP server integration in agent mode"**

3. Open Copilot Chat and switch to **Agent Mode** (not Ask or Edit).

> MCP tools only appear in Agent Mode. If you do not see them, check that both settings above are enabled.

---

## Step 2 — Place copilot-instructions.md

Copy the `.github` folder from this repository into a **common parent directory** that contains
all your D365FO solutions. Visual Studio 2022 automatically searches upward from the solution
folder, so one copy covers every solution underneath — no need to repeat it per solution.

```
C:\source\repos\                   ← parent folder (common ancestor of all solutions)
├── .github\
│   └── copilot-instructions.md   ← copy here once — applies to all solutions below
├── MySolution1\
│   └── MySolution1.sln
└── MySolution2\
    └── MySolution2.sln
```

```powershell
# Example — adjust the destination to match your actual parent folder
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

GitHub Copilot automatically picks up `copilot-instructions.md` and uses it to give
the AI the right D365FO context for every conversation.

---

## Step 3 — Create .mcp.json

Choose the scenario that matches your setup.

---

### Scenario A: Azure-hosted server (most teams)

**What it is:** Your team runs the MCP server on Azure. You only connect to it as a client.
No local server, no local database.

**What you need:**
- The URL of the Azure-hosted MCP server (ask your admin)
- Your `workspacePath` (path to your model on the Windows VM)

**What you do NOT need to do:**
- Install Node.js or clone the repository
- Build a metadata index — it lives in the cloud

**.mcp.json:**

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    }
  }
}
```

> **Note:** For HTTP-only servers, `D365FO_WORKSPACE_PATH` cannot be set via `env` because
> there is no subprocess. The Azure server relies on workspace headers sent by VS Code/VS 2022.
> For reliable model targeting, use **Scenario B** (hybrid) instead.

> **Read-only limitation:** The Azure server cannot write files to your local Windows VM.
> To create or modify files, use **Scenario B** (hybrid) or copy the generated XML manually.

---

### Scenario B: Hybrid — Azure search + local file writes

**What it is:** The Azure server handles all metadata search (fast, shared index).
A lightweight local server runs on your Windows VM and handles only file creation/modification.
GitHub Copilot routes each tool call to the correct server automatically.

**What you need:**
- The Azure server URL
- Node.js 24.x installed on your Windows VM
- A local clone of this repository

**One-time setup on your Windows VM:**

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge && dotnet build -c Release && cd ..\..  # Build the C# bridge
npm run build
```

> You do **not** need to extract metadata or build a database. The metadata index lives
> in Azure Blob Storage and is downloaded by the Azure server, not the local companion.
> The local server starts in under one second and only handles file operations.

**Keeping it up to date** — pull and rebuild whenever a new version is released:

```powershell
cd K:\d365fo-mcp-server
git pull
npm install
npm run build
```

**.mcp.json:**

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

> **Note:** The `--stdio` argument is no longer required. The server detects stdio mode
> automatically when launched as a subprocess (stdin is a pipe, not a terminal).

`projectPath` is optional but recommended — it pins the exact `.rnrproj` so file creation
always targets the right model even when multiple projects are open.

> **How it works:** GitHub Copilot sees both tool lists combined. Search calls go to Azure,
> `create_d365fo_file` / `modify_d365fo_file` / `create_label` go to the local server.
> The local server also exposes 12 bridge-backed read tools (`get_class_info`, `get_table_info`,
> `get_form_info`, etc.) that work via the C# bridge (no SQLite needed), so Copilot can
> immediately verify objects it just created without waiting for an Azure DB re-deploy.

---

### Scenario C: Local server only

**What it is:** The MCP server runs entirely on your Windows VM. All metadata is indexed
locally. Suitable for individual developers who do not want to use Azure.

**What you need:**
- Node.js 24.x, Git
- A D365FO installation with `PackagesLocalDirectory`
- Time to build the metadata index (~5–15 min for custom models, ~1–2 h for everything)

**Setup:**

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge && dotnet build -c Release && cd ..\..  # Build the C# bridge
copy .env.example .env
```

Edit `.env`:

```env
DEV_ENVIRONMENT_TYPE=auto
PACKAGES_PATH=K:/AosService/PackagesLocalDirectory
CUSTOM_MODELS=YourPackageName
```

Extract and index the metadata:

```powershell
# Custom models only (recommended, a few minutes)
npm run extract-metadata
npm run build-database

# Full extraction including all Microsoft standard models (~1-2 h)
$env:EXTRACT_MODE="all"; npm run extract-metadata
npm run build-database
```

Start the server:

```powershell
npm start
```

The server runs at `http://localhost:8080`. Verify with `http://localhost:8080/health`.

**.mcp.json:**

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "http://localhost:8080/mcp/"
    }
  }
}
```

> **Tip:** For a fully local setup without an HTTP server, see **Scenario E** which uses stdio
> transport and does not require `npm start` or a running port.

**Keeping it up to date** — after a D365FO version upgrade or model changes, re-run extraction:

```powershell
npm run extract-metadata
npm run build-database
```

---

### Scenario D: UDE (Unified Developer Experience)

**What it is:** You use Visual Studio 2022 with Power Platform Tools and the UDE environment.
Metadata roots are different from traditional `PackagesLocalDirectory`.

The server reads your XPP config from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`
automatically. In most cases you do not need to set any paths manually.

**.mcp.json (auto-detection, recommended):**

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_MODEL_NAME": "YourModelName",
        "D365FO_DEV_ENVIRONMENT_TYPE": "ude"
      }
    }
  }
}
```

**.mcp.json (explicit paths, if auto-detection does not work):**

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

---

### Scenario E: Local stdio server (single developer, zero-config)

**What it is:** The MCP server runs entirely on your Windows VM using **stdio transport**.
VS 2022 launches it automatically as a subprocess — no `npm start`, no open port, no HTTP.
Model auto-detection works via the MCP roots protocol without any `context` block.

**What you need:**
- Node.js 24.x, Git
- A D365FO installation with `PackagesLocalDirectory`
- A pre-built metadata database

**Setup:**

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git C:\d365fo-mcp-server
cd C:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge && dotnet build -c Release && cd ..\..  # Build the C# bridge
copy .env.example .env
```

Extract and index the metadata (same as Scenario C), then build:

```powershell
npm run extract-metadata
npm run build-database
npm run build
```

**`%USERPROFILE%\.mcp.json`** (global, covers all solutions on this machine):

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["C:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "DB_PATH": "C:\\d365fo-mcp-server\\data\\xpp-metadata.db",
        "LABELS_DB_PATH": "C:\\d365fo-mcp-server\\data\\xpp-metadata-labels.db",
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects"
      }
    }
  }
}
```

Replace `K:\VSProjects` with the folder that contains your D365FO solution(s).

**How it works:**
1. VS 2022 starts the server process on first use — no manual `npm start` needed.
2. The MCP roots protocol delivers the open workspace URI automatically.
3. `D365FO_SOLUTIONS_PATH` is scanned for all `.rnrproj` files at startup.
4. `get_workspace_info` shows all found projects and the active one.
5. To switch to a different solution without restarting: call `get_workspace_info` with
   `projectPath` pointing to the target `.rnrproj`.

**Keeping it up to date:**

```powershell
cd C:\d365fo-mcp-server
git pull
npm install
npm run build
```

Restart the MCP server in VS 2022 after updating (MCP panel → Restart).

---

### Scenario F: Multiple instances — one machine, multiple D365FO environments

**What it is:** You work on several D365FO clients or projects from a single Windows VM.
Each client needs its own metadata index and its own Copilot context.
Instead of rebuilding one shared database when switching projects, each instance has its own
`.env` file, `data/` folder and `metadata/` folder and runs on a different port.

**What you need:**
- A clone of this repository
- PowerShell (comes with Windows)

**One-time setup:**

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git C:\d365fo-mcp-server
cd C:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge && dotnet build -c Release && cd ..\..
npm run build
```

**Create an instance** (interactive, run once per client/project):

```powershell
.\instances\add-instance.ps1
```

The script prompts for a name (e.g. `clientA`, `projectX`) and a port, then creates:

```
instances\
├── clientA\
│   ├── .env          ← instance configuration (copy of template, port pre-filled)
│   ├── data\         ← instance-specific SQLite databases
│   └── metadata\     ← instance-specific extracted metadata
└── clientB\
    ├── .env
    ├── data\
    └── metadata\
```

Open the generated `.env` and fill in the three required keys:

```env
XPP_CONFIG_NAME=ClientA     # name from %LOCALAPPDATA%\Microsoft\Dynamics365\XppConfig\
EXTENSION_PREFIX=ASP        # ISV prefix for code-gen naming
D365FO_MODEL_NAME=ClientAModel
```

**Build the metadata index for an instance:**

```powershell
.\instances\rebuild-instance.ps1 clientA
# or interactively: .\instances\rebuild-instance.ps1
# or all at once:   .\instances\rebuild-instance.ps1 --all
```

The script runs `extract-metadata` and `build-database` with `ENV_FILE` set to the instance
`.env`, so output goes into `instances\clientA\data\` and `instances\clientA\metadata\`.
It also offers a `git pull` + `npm install` + `npm run build` step before each run.

**Run an instance:**

```powershell
.\instances\run-instance.ps1 clientA
# or interactively: .\instances\run-instance.ps1
```

This sets `ENV_FILE=instances\clientA\.env` and starts `node dist\index.js`.
Start each instance in a separate terminal. Each listens on its own port.

**`.mcp.json` — connect Copilot to a specific instance:**

```json
{
  "servers": {
    "d365fo-clientA": {
      "url": "http://localhost:3001/mcp/"
    }
  }
}
```

Place a per-solution `.mcp.json` next to each `.sln` file pointing at the correct port.
An alternative is a global `%USERPROFILE%\.mcp.json` if you always work on one client at a time.

> **Tip:** `instances\rebuild-instance.ps1` compares each instance `.env` against `.env.example` and
> warns about new configuration keys added in a newer version — so upgrading is safe.

---

## Building the C# Bridge

> **The C# bridge is mandatory on Windows D365FO VMs.** Without it, `create_d365fo_file`
> and `modify_d365fo_file` will not work. Read-only tools fall back to SQLite, but all
> write operations require the bridge. See [BRIDGE.md](BRIDGE.md) for full details.

### Prerequisites

- .NET Framework 4.8 Developer Pack (pre-installed on D365FO VMs, or install via
  Visual Studio Installer → ".NET desktop development" workload)
- D365FO development VM with `PackagesLocalDirectory` containing `Microsoft.Dynamics.*.dll`

### Build

```powershell
cd bridge\D365MetadataBridge
dotnet build -c Release
```

The output goes to `bridge/D365MetadataBridge/bin/Release/D365MetadataBridge.exe`.

The server auto-detects the exe location at startup — no manual path configuration needed.
If the exe is not found, the server logs `ℹ️ C# bridge not available` and starts in
read-only mode (SQLite + XML parser only).

### UDE (Unified Developer Experience) build

On UDE boxes the D365FO DLLs are not under `C:\AosService\PackagesLocalDirectory\bin`.
You must tell the build where to find them using `-p:D365BinPath`:

```powershell
cd bridge\D365MetadataBridge
dotnet build -c Release -p:D365BinPath="<FrameworkDirectory>\bin"
```

Replace `<FrameworkDirectory>` with the `FrameworkDirectory` value from your XPP config
(typically found in `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`).

If your machine has a restrictive NuGet config (e.g., Azure DevOps private feed only),
add `--source https://api.nuget.org/v3/index.json` to the build command:

```powershell
dotnet build -c Release -p:D365BinPath="<FrameworkDirectory>\bin" --source https://api.nuget.org/v3/index.json
```

### Verification

After building, start the MCP server. The log should show:

```
✅ C# bridge initialized (metadataAvailable: true, xrefAvailable: true)
```

If you see `xrefAvailable: false`, SQL Server or `DYNAMICSXREFDB` is not accessible.
This is non-critical — cross-reference tools fall back to SQLite FTS.

### Updating

After a D365FO version upgrade, rebuild the bridge to pick up updated DLLs:

```powershell
cd bridge\D365MetadataBridge
dotnet build -c Release
```

### Testing

```powershell
# E2E test (requires D365FO VM with metadata)
npx tsx tests/bridge-e2e.ts

# Unit tests (works everywhere, no D365FO required)
npm test -- --run
```

---

## Where to place .mcp.json

The server searches for `.mcp.json` starting from the current working directory and walking
up 5 parent levels. The recommended locations are:

**Option 1 — Per-solution (recommended)**

Place the file next to your `.sln` file:

```
K:\VSProjects\MySolution\
├── .mcp.json          ← here
├── MySolution.sln
└── MyProject\
    └── MyProject.rnrproj
```

This is the most precise option. Visual Studio opens `.mcp.json` automatically when it opens
the solution folder.

**Option 2 — Global (all solutions on this machine)**

Place the file in your user profile directory (`%USERPROFILE%\.mcp.json`), for example:

```
C:\Users\YourName\.mcp.json
```

Use this when you have a single model that applies to all your D365FO work and you do not
want to maintain per-solution files.

---

## Troubleshooting

### MCP tools not loading in Visual Studio
- Confirm Visual Studio version is 17.14 or later
- Confirm *MCP servers in Copilot* is enabled at https://github.com/settings/copilot/features
- Confirm Copilot Chat is in **Agent Mode** (not Ask or Edit)
- Confirm `.mcp.json` is in the solution root or user home directory (`%USERPROFILE%\.mcp.json`)
- Restart Visual Studio after creating or editing `.mcp.json`

### Copilot ignores MCP tools and uses built-in file search instead
- Confirm `.github\copilot-instructions.md` exists somewhere in the directory tree above your solution
- Visual Studio 2022 searches upward from the solution folder — place it in a common parent (e.g. `C:\source\repos\.github\`) to cover all solutions at once
- Confirm Visual Studio version supports custom instructions (17.11 or later)

### File created in wrong D365FO model
Use the two-level `workspacePath` format: `PackagesLocalDirectory\YourPackageName\YourModelName`.
The server extracts both `packageName` and `modelName` from it automatically.
See [WORKSPACE_DETECTION.md](WORKSPACE_DETECTION.md).

### Local server (hybrid) does not start
- Confirm Node.js 24.x is installed: `node --version`
- Confirm the build is up to date: re-run `npm install && npm run build` in the repo folder
- Check the path in `.mcp.json` `args` matches where you cloned the repository

### "fts5: syntax error" when searching
Your search query contains special characters. The server handles this automatically with a
fallback to LIKE search. If you still see this error, update to the latest version.

### No results when searching
- Confirm the Azure server is reachable: open the `/health` URL in a browser
- For local setup: verify the database was built — `data/xpp-metadata.db` should exist and be > 100 MB

---

## Next Steps

- [MCP_CONFIG.md](MCP_CONFIG.md) — full reference for all `.mcp.json` options
- [BRIDGE.md](BRIDGE.md) — C# metadata bridge for live D365FO metadata on Windows VMs
- [SETUP_AZURE.md](SETUP_AZURE.md) — deploy the server to Azure (admins only)
- [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) — example Copilot prompts
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) — ISV and multi-model setups
- [PIPELINES.md](PIPELINES.md) — automate metadata refresh
