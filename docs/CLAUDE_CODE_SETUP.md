# Claude Code CLI Setup

Connect the D365 F&O MCP Server to Claude Code CLI in 4 steps.

> **Already deployed by your team on Azure?** Skip to [Step 2](#step-2--register-the-mcp-server).

---

## Step 1 — Build the server

Same prerequisites and build steps as the Copilot guide — no VS 2022 required.

| Requirement | Where to get it |
|------------|----------------|
| Node.js 24.x LTS | [nodejs.org](https://nodejs.org) |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| Python 3.x | Needed by `node-gyp` for native SQLite |
| .NET Framework 4.8 Developer Pack | Required for the C# bridge (file create/modify on D365FO VMs) |

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install

# Build the C# bridge (required for file create/modify on Windows VMs)
cd bridge\D365MetadataBridge
dotnet build -c Release
cd ..\..

copy .env.example .env
# Edit .env — set PACKAGES_PATH, CUSTOM_MODELS, LABEL_LANGUAGES

npm run extract-metadata
npm run build-database
npm run build
```

> **Already on Azure?** Skip `extract-metadata` and `build-database` — the index lives in Azure. You only need `npm install` + bridge build + `npm run build`.

---

## Step 2 — Register the MCP server

Claude Code stores MCP server config in `~/.claude.json` (not in `.mcp.json` like Copilot). Use `claude mcp add-json` to register the server. The `alwaysLoad` flag is critical — without it, Claude Code defers d365fo tools and may route X++ lookups to other connected code intelligence tools or built-in search instead.

### Scenario A: Azure-hosted server (most teams)

```powershell
claude mcp add-json --scope user d365fo-mcp-tools '{"type":"http","url":"https://your-server.azurewebsites.net/mcp/","alwaysLoad":true}'
```

### Scenario B: Local stdio (single developer)

```powershell
claude mcp add-json --scope user d365fo-mcp-tools '{"type":"stdio","command":"node","args":["K:\\d365fo-mcp-server\\dist\\index.js"],"env":{"DB_PATH":"K:\\d365fo-mcp-server\\data\\xpp-metadata.db","LABELS_DB_PATH":"K:\\d365fo-mcp-server\\data\\xpp-metadata-labels.db","D365FO_SOLUTIONS_PATH":"K:\\repos\\MySolution\\projects","D365FO_WORKSPACE_PATH":"K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"},"alwaysLoad":true}'
```

> In PowerShell single-quoted strings, `"` does **not** need escaping. Double backslashes `\\` are still required — that is JSON path escaping, not shell escaping.

### Scenario C: Hybrid — Azure search + local writes

Run both commands:

```powershell
claude mcp add-json --scope user d365fo-azure '{"type":"http","url":"https://your-server.azurewebsites.net/mcp/","alwaysLoad":true}'

claude mcp add-json --scope user d365fo-local '{"type":"stdio","command":"node","args":["K:\\d365fo-mcp-server\\dist\\index.js"],"env":{"MCP_SERVER_MODE":"write-only","D365FO_SOLUTIONS_PATH":"K:\\repos\\MySolution\\projects","D365FO_WORKSPACE_PATH":"K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"},"alwaysLoad":true}'
```

### Alternative: project-scoped `.mcp.json`

To share the config with your team via version control, create `.mcp.json` in your D365FO solution root. Claude Code uses the **`"mcpServers"`** key (not `"servers"` like GitHub Copilot):

```json
{
  "mcpServers": {
    "d365fo-mcp-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata.db",
        "LABELS_DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata-labels.db",
        "D365FO_SOLUTIONS_PATH": "K:\\repos\\MySolution\\projects",
        "D365FO_WORKSPACE_PATH": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"
      },
      "alwaysLoad": true
    }
  }
}
```

For HTTP (Azure) in `.mcp.json`:

```json
{
  "mcpServers": {
    "d365fo-mcp-tools": {
      "type": "http",
      "url": "https://your-server.azurewebsites.net/mcp/",
      "alwaysLoad": true
    }
  }
}
```

> Claude Code prompts for approval before using project-scoped servers. Accept once; Claude Code remembers.

### Why `alwaysLoad: true`?

Claude Code's Tool Search feature defers MCP tool schemas to save context. When tools are deferred, Claude picks whichever tool it finds first during a search step — which may be another connected code intelligence tool or a built-in search tool instead of `d365fo-mcp-tools`. Setting `alwaysLoad: true` loads the d365fo tool list into context at session start, guaranteeing Claude sees them before making any tool choice. Without it, Claude may route D365FO metadata queries to other connected code intelligence tools and get wrong or empty results. Combined with `CLAUDE.md` (Step 3), this eliminates the wrong-tool problem entirely.

---

## Step 3 — Place `CLAUDE.md`

Copy `CLAUDE.template.md` from the repo root to the parent folder of your D365FO solutions, renaming it to `CLAUDE.md`. Claude Code reads it automatically from the working directory upward, so one copy covers all solutions underneath.

```powershell
# Example: place in the parent of all your D365FO solution folders, renamed to CLAUDE.md
Copy-Item -Path "K:\d365fo-mcp-server\CLAUDE.template.md" -Destination "C:\source\repos\CLAUDE.md"
```

`CLAUDE.md` reinforces the tool priority in plain language — telling Claude to use `d365fo-mcp-tools` for all X++ work regardless of what other tools are connected. `alwaysLoad` handles it technically; `CLAUDE.md` handles it instructionally.

---

## Step 4 — Verify

Run in any terminal:

```powershell
claude mcp list
```

You should see `d365fo-mcp-tools` listed as connected. Then start a Claude Code session from your D365FO solution folder and ask:

```
What tables contain the "CustAccount" field?
```

Claude should call the `search` tool from `d365fo-mcp-tools`. If it routes to another tool instead, check:
1. `CLAUDE.md` is present in the working directory or a parent
2. `alwaysLoad: true` is set in the server config (`claude mcp get d365fo-mcp-tools` to inspect)

For file operations, try:

```
Create a new class called TestHelper with a static method hello() that returns "Hello"
```

If a file appears on disk, the C# bridge is working.

---

## Claude Code vs GitHub Copilot

| Feature | GitHub Copilot (VS 2022) | Claude Code CLI |
|---------|--------------------------|-----------------|
| Instruction file | `.github\copilot-instructions.md` (in solutions parent folder — one copy covers all solutions) | `CLAUDE.md` (same location — solutions parent folder) |
| Agent mode toggle | Required (VS 2022 Agent Mode) | Always agentic — no toggle needed |
| Terminal commands | Hang in VS 2022 MCP context | Work normally |
| Config file location | `%USERPROFILE%\.mcp.json` (user-scoped, covers all projects) | `~/.claude.json` (via `claude mcp add`) or `.mcp.json` in project root |
| Config root key | `"servers"` | `"mcpServers"` |
| Server type field | Not required | Explicit `"type"` recommended |
| Always-load tools | Not available | `"alwaysLoad": true` — prevents tool deferral |

---

## See Also

- [QUICK_START.md](QUICK_START.md) — Full Copilot scenario guide (Scenarios A–F); env var reference applies to Claude Code too
- [MCP_CONFIG.md](MCP_CONFIG.md) — Complete env var reference for D365FO workspace paths
- [MCP_TOOLS.md](MCP_TOOLS.md) — All 26 tools with example prompts
- [BRIDGE.md](BRIDGE.md) — C# Metadata Bridge (required for file create/modify on Windows VMs)
