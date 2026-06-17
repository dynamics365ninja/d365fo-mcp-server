# Quick Start

Get the D365 F&O MCP Server running with GitHub Copilot in 5 steps.

> **Server already deployed on Azure by your team?** Skip to [Step 3](#step-3--connect-copilot) — you only need a `.mcp.json` file.
>
> **Using Claude Code instead of Copilot?** See [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md).

---

## Step 1 — Prerequisites

| Requirement | Where to get it | Needed for |
|------------|----------------|------------|
| Visual Studio 2022 ≥ 17.14 (or 2026) | Visual Studio Installer | all scenarios |
| GitHub Copilot extension | VS → Extensions | all scenarios |
| Node.js 24.x LTS | [nodejs.org](https://nodejs.org) or `Install-D365SupportingSoftware -Name node.js` | local / hybrid |
| Python 3.x | bundled with Node.js installer (check the option) | local / hybrid |
| .NET Framework 4.8 Dev Pack | pre-installed on D365FO VMs | C# bridge (writes) |
| Git | [git-scm.com](https://git-scm.com) | local / hybrid |

---

## Step 2 — Clone and build

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge; dotnet build -c Release; cd ..\..   # C# bridge — required for writes
npm run build
```

**Local index** (skip for hybrid — the index lives in Azure):

```powershell
copy .env.example .env           # set PACKAGES_PATH, CUSTOM_MODELS, LABEL_LANGUAGES
npm run extract-metadata
npm run build-database
```

> **UDE / Power Platform Tools?** Run `npm run select-config` instead of setting `PACKAGES_PATH` manually.

---

## Step 3 — Connect Copilot

1. [github.com/settings/copilot/features](https://github.com/settings/copilot/features) → enable **MCP servers in Copilot**
2. Visual Studio: **Tools → Options → GitHub → Copilot** → enable **MCP server integration in agent mode**
3. Copilot Chat → switch to **Agent Mode**
4. Create `.mcp.json` — either `%USERPROFILE%\.mcp.json` (all solutions, recommended) or next to a specific `.sln`

Pick your scenario:

| Scenario | What runs where | Best for |
|----------|----------------|----------|
| [**A** — Azure client](#a--azure-client) | everything on Azure, read-only | team members |
| [**B** — Hybrid](#b--hybrid-azure--local-writes) | Azure search + local writes | **teams (recommended)** |
| [**C** — Local HTTP](#c--local-http) | `npm run dev` on the VM | single developer |
| [**D** — Local stdio](#d--local-stdio) | VS spawns the process | single developer, zero-config |
| **E** — UDE | stdio + XPP config auto-detection | UDE / Power Platform Tools — [SETUP.md](SETUP.md#scenario-d-ude-unified-developer-experience) |
| **F** — Multi-instance | one machine, several clients | agencies — [SETUP.md](SETUP.md#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments) |

### A — Azure client

```json
{
  "servers": {
    "d365fo-mcp-tools": { "url": "https://your-server.azurewebsites.net/mcp/" }
  }
}
```

> Read-only — cannot write files on your VM. Use **B** for writes.

### B — Hybrid (Azure + local writes)

```json
{
  "servers": {
    "d365fo-azure": { "url": "https://your-server.azurewebsites.net/mcp/" },
    "d365fo-local": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "MCP_SERVER_MODE": "write-only",
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel"
      }
    }
  }
}
```

### C — Local HTTP

```json
{
  "servers": {
    "d365fo-mcp-tools": { "url": "http://localhost:8080/mcp/" }
  }
}
```

Start with `cd K:\d365fo-mcp-server && npm run dev`.

### D — Local stdio

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "MCP_SERVER_MODE": "full",
        "DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata.db",
        "LABELS_DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata-labels.db",
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
        "D365FO_PACKAGE_PATH": "K:\\AosService\\PackagesLocalDirectory"
      }
    }
  }
}
```

> Complete parameter reference (every env var, per-scenario matrix): [MCP_CONFIG.md](MCP_CONFIG.md)

---

## Step 4 — Place copilot-instructions.md

```powershell
# One copy in a common parent folder covers all solutions beneath it
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

VS 2022 searches for `.github\copilot-instructions.md` upward from the solution folder. **This step is not optional** — it delivers the workflow rules (tool routing, confirm-before-write, terminal prohibition) that the agent relies on.

---

## Step 5 — Verify

| Test | Prompt | Confirms |
|------|--------|----------|
| Search | `What tables contain "CustAccount" field?` | index + connection |
| Write | `Create a class TestHelper with a static method hello()` | C# bridge |
| Forms | `Which form pattern should I use for a setup table with 5 fields?` | pattern advisor |

If the first prompt triggers a `search` tool call with results from your codebase, you are connected.

---

## Logging & Diagnostics

Add to the `env` block in `.mcp.json` when something isn't working:

| Variable | Effect |
|----------|--------|
| `DEBUG_LOGGING=true` | Verbose JSON-RPC trace, bridge communication, tool routing |
| `LOG_FILE=C:\Temp\d365fo-mcp.log` | Tee all server output to a file |
| `D365FO_BRIDGE_LOG_FILE=C:\Temp\d365fo-bridge.log` | Full C# bridge diagnostics (DLL loading, write tracing) |

```powershell
Get-Content "C:\Temp\d365fo-mcp.log" -Encoding UTF8 -Wait    # watch live
```

Healthy startup log:

```
✅ C# bridge initialized (metadataAvailable: true, xrefAvailable: true)
```

| Flag | Meaning |
|------|---------|
| `metadataAvailable: false` | D365FO DLLs not loaded — check `packagePath` and .NET 4.8 |
| `xrefAvailable: false` | `DYNAMICSXREFDB` unreachable — non-critical, tools fall back to SQLite |

---

## What's next

| Topic | Documentation |
|-------|--------------|
| All 26 tools | [MCP_TOOLS.md](MCP_TOOLS.md) |
| Real-world tool chains (CoC, forms, security, reports) | [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) |
| Full `.mcp.json` reference | [MCP_CONFIG.md](MCP_CONFIG.md) |
| Detailed setup scenarios A–F | [SETUP.md](SETUP.md) |
| Azure deployment | [SETUP_AZURE.md](SETUP_AZURE.md) |
| Claude Code CLI | [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) |
