# Quick Start

Two very different jobs share this page. Pick yours — each path is self-contained, so you only read your own.

| Your situation | Path | Effort |
|---|---|---|
| Your team already runs a deployed server | [**A — Connect**](#path-a--connect-to-a-server-someone-else-deployed) | ~2 min, nothing installed |
| You are setting up your own D365FO VM | [**B–E — Install**](#paths-be--install-on-your-d365fo-vm) | 10 min, or ~25 with a local index |
| One machine serving several D365FO environments | **F — Multi-instance** | [SETUP.md](SETUP.md#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments) |

Both paths finish with the [instruction file](#the-instruction-file-required) and [verification](#verify) at the bottom — those two are shared.

> Deploying the shared Azure server for your team is a separate job: [SETUP_AZURE.md](SETUP_AZURE.md).


# Path A — connect to a server someone else deployed

Nothing is installed locally: the whole configuration is one entry naming a remote URL. You need only your editor and the server URL from whoever deployed it (plus an API key, if that deployment enforces one).

### Option 1 — the CLI writes it

```powershell
npx d365fo-mcp connect https://your-server.azurewebsites.net
```

Asks which editor and whether a key is needed, checks the server answers before writing anything, then merges the entry into that editor's config — any other MCP servers you have are left alone. Claude Code is registered through its own `claude mcp add-json`.

Scriptable: `npx d365fo-mcp connect <url> --client vs|vscode|cursor|claude --api-key <key> --yes`.

### Option 2 — one click

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_d365fo-0098FF?style=flat-square&logo=githubcopilot&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=d365fo&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22d365fo_server_url%22%2C%22description%22%3A%22D365FO%20MCP%20server%20URL%20(e.g.%20https%3A%2F%2Fyour-server.azurewebsites.net%2Fmcp%2F)%22%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22%24%7Binput%3Ad365fo_server_url%7D%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_d365fo-24bfa5?style=flat-square&logo=githubcopilot&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=d365fo&quality=insiders&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22d365fo_server_url%22%2C%22description%22%3A%22D365FO%20MCP%20server%20URL%20(e.g.%20https%3A%2F%2Fyour-server.azurewebsites.net%2Fmcp%2F)%22%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22%24%7Binput%3Ad365fo_server_url%7D%22%7D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_d365fo-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=d365fo&config=eyJ1cmwiOiJodHRwczovL3lvdXItc2VydmVyLmF6dXJld2Vic2l0ZXMubmV0L21jcC8ifQ%3D%3D)

VS Code prompts for the URL; Cursor installs a placeholder you then edit. Visual Studio and Claude Code have no install link — use Option 1 or 3.

### Option 3 — by hand

Visual Studio reads `%USERPROFILE%\.mcp.json` (all solutions) or a `.mcp.json` next to a specific `.sln`:

```json
{
  "servers": {
    "d365fo-mcp-tools": { "url": "https://your-server.azurewebsites.net/mcp/" }
  }
}
```

With an API key, add it as a header:

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "url": "https://your-server.azurewebsites.net/mcp/",
      "headers": { "X-Api-Key": "your-key" }
    }
  }
}
```

Claude Code keeps its config elsewhere:

```powershell
claude mcp add-json --scope user d365fo-mcp-tools '{"type":"http","url":"https://your-server.azurewebsites.net/mcp/","alwaysLoad":true}'
```

> **Read-only.** An Azure client searches and reads your indexed metadata but cannot write files on your VM. For writes, use the hybrid setup in [Path B](#b--hybrid--azure-search--local-writes).

**Using Copilot?** Also do the [Copilot switches](#enable-copilot-visual-studio) below. Then continue with the [instruction file](#the-instruction-file-required).


# Paths B–E — install on your D365FO VM

## 1. Prerequisites

| Requirement | Where to get it | Needed for |
|------------|----------------|------------|
| Visual Studio 2022 ≥ 17.14 (or 2026) | Visual Studio Installer | all scenarios |
| GitHub Copilot extension | VS → Extensions | Copilot users |
| .NET Framework 4.8 Dev Pack | pre-installed on D365FO VMs | C# bridge (writes) |
| Node.js 24.x LTS | [nodejs.org](https://nodejs.org), or `Install-D365SupportingSoftware -Name node.js` | installed for you by the one-liner |
| Git | [git-scm.com](https://git-scm.com) | installed for you by the one-liner |
| Python 3.x | option in the Node.js installer | only if npm cannot fetch a prebuilt `better-sqlite3` binary and has to compile it |

## 2. Install

```powershell
irm https://raw.githubusercontent.com/dynamics365ninja/d365fo-mcp-server/main/install.ps1 | iex
```

The installer checks for Node.js and Git (installing them if missing), clones the repository, runs `npm install`, and hands off to the setup wizard — which selects your scenario, builds the C# bridge, asks only the settings that scenario needs, builds the index if you want one, and prints the `.mcp.json` block for step 3.

Safe to re-run: an existing installation is updated (`git pull`) rather than re-cloned. Override with environment variables set on the same line:

| Variable | Effect |
|---|---|
| `$env:D365FO_MCP_DIR` | install directory (default `K:\d365fo-mcp-server`) |
| `$env:D365FO_MCP_YES = '1'` | non-interactive, accept defaults |
| `$env:D365FO_MCP_NO_WIZARD = '1'` | clone + `npm install` only, skip the wizard |

Answers are saved to `config/d365fo-mcp.json` (secrets to `config/secrets.json`) — there is no `.env` to fill in. Every key, its default and the matching environment variable: [CONFIGURATION.md](CONFIGURATION.md). An older `.env` keeps working and is imported the first time the wizard runs.

<details>
<summary>Prefer to run the steps yourself</summary>

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge; dotnet build -c Release; cd ..\..   # required for writes
npm run build
npm run setup        # scenario, paths, models, prefix, label languages…
npm run doctor       # verifies Node, build, index, bridge
```

A local index (skip it for hybrid — that index lives in Azure):

```powershell
npm run extract-metadata
npm run build-database
```

</details>

> **Why not `npx d365fo-mcp setup`?** The CLI is on npm as [`d365fo-mcp`](https://www.npmjs.com/package/d365fo-mcp), but `setup`, `update` and `index` need the repository itself — `scripts/`, dev dependencies and `git pull`. Run from a bare `npx` they stop and refer you back here rather than half-configuring the machine. Only `connect` (Path A) is self-sufficient.

## 3. Configure your editor

### Enable Copilot (Visual Studio)

1. [github.com/settings/copilot/features](https://github.com/settings/copilot/features) → enable **MCP servers in Copilot**
2. Visual Studio → **Tools → Options → GitHub → Copilot** → enable **MCP server integration in agent mode**
3. Copilot Chat → switch to **Agent Mode**

Using Claude Code instead? [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) covers it end to end.

### Then pick the scenario the wizard configured

| Scenario | What runs where | Best for |
|----------|----------------|----------|
| [**B** — Hybrid](#b--hybrid--azure-search--local-writes) | Azure search + local writes | **teams (recommended)** |
| [**C** — Local HTTP](#c--local-http) | `npm run dev` on the VM | single developer |
| [**D** — Local stdio](#d--local-stdio) | VS spawns the process | single developer, zero-config |
| **E** — UDE | stdio + XPP config auto-detection | UDE / Power Platform Tools — [SETUP.md](SETUP.md#scenario-d-ude-unified-developer-experience) |

#### B — Hybrid — Azure search + local writes

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

#### C — Local HTTP

```json
{
  "servers": {
    "d365fo-mcp-tools": { "url": "http://localhost:8080/mcp/" }
  }
}
```

Start the server with `npx d365fo-mcp start` (or `npm run dev`) in the install directory.

#### D — Local stdio

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

> Every environment variable and a per-scenario matrix: [MCP_CONFIG.md](MCP_CONFIG.md).


# The instruction file (required)

```powershell
# One copy in a common parent folder covers every solution beneath it
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

VS 2022 searches upward from the solution folder for `.github\copilot-instructions.md`. **Not optional** — it carries the workflow rules the agent depends on: tool routing, confirm-before-write, and the terminal prohibition. Claude Code reads the same content as `CLAUDE.md`:

```powershell
Copy-Item "K:\d365fo-mcp-server\.github\copilot-instructions.md" "C:\source\repos\CLAUDE.md"
```

Path A users: take the file from [the repository](https://github.com/dynamics365ninja/d365fo-mcp-server/blob/main/.github/copilot-instructions.md) — it is the one thing you do need locally.


# Verify

Restart the editor, open the AI chat, and ask:

| Test | Prompt | Confirms |
|------|--------|----------|
| Search | `Find every table (standard + ISV) that carries the CustAccount field` | index + connection |
| Write | `Create a class TestHelper with a static method hello()` | C# bridge (not Path A) |
| Forms | `Which form pattern should I use for a setup table with 5 fields?` | pattern advisor |

The first prompt should trigger a `search` tool call returning results from **your** metadata — including ISV models no training data has ever seen. That is the signal that grounding works, not just that the server is reachable.

On an installed server, `npx d365fo-mcp doctor` checks the same ground from the other side: Node version, build, native binding, index size, bridge, and any stale configuration.


# Logging & diagnostics

Add to the `env` block in `.mcp.json` when something isn't working:

| Variable | Effect |
|----------|--------|
| `DEBUG_LOGGING=true` | Verbose JSON-RPC trace, bridge communication, tool routing |
| `LOG_FILE=C:\Temp\d365fo-mcp.log` | Tee all server output to a file |
| `D365FO_BRIDGE_LOG_FILE=C:\Temp\d365fo-bridge.log` | Full C# bridge diagnostics (DLL loading, write tracing) |

```powershell
Get-Content "C:\Temp\d365fo-mcp.log" -Encoding UTF8 -Wait    # watch live
```

A healthy startup logs `✅ C# bridge initialized (metadataAvailable: true, xrefAvailable: true)`:

| Flag | Meaning |
|------|---------|
| `metadataAvailable: false` | D365FO DLLs not loaded — check `packagePath` and .NET 4.8 |
| `xrefAvailable: false` | `DYNAMICSXREFDB` unreachable — non-critical, tools fall back to SQLite |


# What's next

| Topic | Documentation |
|-------|--------------|
| All 26 tools | [MCP_TOOLS.md](MCP_TOOLS.md) |
| Real-world tool chains (CoC, forms, security, reports) | [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) |
| Full `.mcp.json` reference | [MCP_CONFIG.md](MCP_CONFIG.md) |
| Every setting and its environment variable | [CONFIGURATION.md](CONFIGURATION.md) |
| Detailed setup scenarios A–F | [SETUP.md](SETUP.md) |
| Azure deployment (admins) | [SETUP_AZURE.md](SETUP_AZURE.md) |
| Claude Code CLI | [CLAUDE_CODE_SETUP.md](CLAUDE_CODE_SETUP.md) |
