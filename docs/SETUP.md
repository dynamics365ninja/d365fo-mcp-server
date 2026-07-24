# Setup Guide — Client Configuration

Everything a **developer** needs to connect GitHub Copilot (VS 2022 ≥ 17.14 / VS 2026) to the D365 F&O MCP Server.

> Fast path: [QUICK_START.md](QUICK_START.md) · Azure deployment (admins): [SETUP_AZURE.md](SETUP_AZURE.md) · Claude Code: [below](#claude-code-cli)

> **Prefer a guided setup?** After `git clone` + `npm install`, run `npm run setup` — the interactive management CLI walks through the scenario choice below, builds the bridge and the index, and prints the `.mcp.json` block. `npm run doctor` verifies an existing installation. Day-to-day: `npx d365fo-mcp start|update|index|instance …` (each command also runs non-interactively with arguments). The PowerShell scripts referenced below keep working as before.

> **Configuration lives in `config/d365fo-mcp.json`**, written by the wizard (secrets in `config/secrets.json`); the generated `.mcp.json` block points the server at it via `D365FO_CONFIG`. Change one thing later with `npx d365fo-mcp config [section]`. Every setting, its default and the environment variable it maps to: [CONFIGURATION.md](CONFIGURATION.md). A `.env` from an older installation is still read as a fallback and is imported the first time `npm run setup` runs.

---

## Choosing a scenario

```mermaid
flowchart TD
    Q1{Team has an<br/>Azure instance?} -->|yes| Q2{Need to create/modify<br/>files on your VM?}
    Q2 -->|no| A[Scenario A<br/>Azure client]
    Q2 -->|yes| B[Scenario B<br/>Hybrid ★]
    Q1 -->|no| Q3{UDE / Power<br/>Platform Tools?}
    Q3 -->|yes| D[Scenario D<br/>UDE]
    Q3 -->|no| Q4{Several D365FO clients<br/>on one machine?}
    Q4 -->|yes| F[Scenario F<br/>Multi-instance]
    Q4 -->|no| E[Scenario E<br/>Local stdio ★]
```

| Scenario | Search index | Writes | Local install | Index build |
|----------|-------------|--------|---------------|-------------|
| **A** — Azure client | Azure | ❌ | none | none |
| **B** — Hybrid ★ | Azure | ✅ local bridge | clone + build | none |
| **C** — Local HTTP | local | ✅ | clone + build | yes |
| **D** — UDE | local | ✅ | clone + build | yes |
| **E** — Local stdio ★ | local | ✅ | clone + build | yes |
| **F** — Multi-instance | local ×N | ✅ | clone + build | per instance |

---

## Prerequisites

| Component | Version | Needed for |
|-----------|---------|-----------|
| Visual Studio 2026 / 2022 | 2026 (from 10.0.49) / ≥ 17.14 | MCP support |
| GitHub Copilot extension | latest | agent mode |
| Node.js + Python | 24.x LTS / 3.x | local & hybrid (native SQLite build) |
| .NET SDK | any current | C# bridge — **all writes** (pre-installed on D365FO VMs) |
| Git | any | local & hybrid |

> **From platform update 10.0.49 (PU74), Visual Studio 2026 is the only supported IDE for X++ development** — Microsoft no longer supports VS 2022. Earlier platform versions still use VS 2022 ≥ 17.14. ([announcement](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/fin-ops/get-started/whats-new-platform-updates-10-0-49))

## Enable MCP (one-time)

1. [github.com/settings/copilot/features](https://github.com/settings/copilot/features) → **MCP servers in Copilot**
2. VS → **Tools → Options → GitHub → Copilot** → **Enable MCP server integration in agent mode**
3. Copilot Chat → **Agent Mode** (tools only appear there)

## Place copilot-instructions.md (mandatory)

```powershell
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

VS searches `.github\copilot-instructions.md` upward from the solution folder — one copy in a common parent covers all solutions. It delivers the workflow rules (tool routing, confirm-before-write, no terminal file edits) the agent depends on. The fuller `xpp_system_instructions` MCP prompt is **opt-in** and must be invoked manually — never rely on it alone.

---

## Scenario A — Azure client

Team server on Azure; you connect read-only. No local install, no index.

```json
{
  "servers": {
    "d365fo-mcp-tools": { "url": "https://your-server.azurewebsites.net/mcp/" }
  }
}
```

> Cannot write files on your VM and cannot read your workspace context reliably (HTTP has no `env`). For real development use **Scenario B**.

## Scenario B — Hybrid (Azure search + local writes) ★

Azure serves the shared index; a lightweight local companion (starts < 1 s, no database) handles writes via the C# bridge. Copilot merges both tool lists and routes automatically.

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge; dotnet build -c Release; cd ..\..
npm run build
```

```json
{
  "servers": {
    "d365fo-azure": { "url": "https://your-server.azurewebsites.net/mcp/" },
    "d365fo-local": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_CONFIG": "K:\\d365fo-mcp-server\\config\\d365fo-mcp.json"
      }
    }
  }
}
```

`D365FO_CONFIG` points at the file `npm run setup` wrote — it already holds `server.mode: write-only`, the workspace and the solutions path for this companion. Add a variable to the `env` block only to override the file for that one server entry.

The local companion also exposes the bridge-backed reader `get_object_info` (and `get_method`), so freshly created objects are immediately readable without waiting for an Azure index refresh.

**Update:** `git pull && npm install && npm run build` whenever a new version ships.

## Scenario C — Local HTTP

Everything on your VM, served over `http://localhost:8080`.

```powershell
# after clone + build (see B)
npm run setup              # packages path, custom models, prefix, port
npm run extract-metadata   # custom models: minutes; full index: 1–2 h
npm run build-database
npm start                  # verify: http://localhost:8080/health
```

```json
{
  "servers": {
    "d365fo-mcp-tools": { "url": "http://localhost:8080/mcp/" }
  }
}
```

> Prefer **Scenario E** (stdio) when a single client drives the server — no port, no `npm start`, VS launches it for you. Choose local HTTP when **several clients share one code base** (e.g. VS Code + the CLI at the same time): stdio spawns one subprocess per client, each loading its own ~1.5 GB index, whereas a single HTTP instance loads the index once and serves them all.

## Scenario D — UDE (Unified Developer Experience)

The server reads your XPP config from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\` automatically — usually no paths needed.

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_CONFIG": "K:\\d365fo-mcp-server\\config\\d365fo-mcp.json"
      }
    }
  }
}
```

If auto-detection fails, add `D365FO_CUSTOM_PACKAGES_PATH` and `D365FO_MICROSOFT_PACKAGES_PATH` explicitly. For metadata extraction run `npm run select-config` first. Bridge build on UDE needs the DLL path:

```powershell
dotnet build -c Release -p:D365BinPath="<FrameworkDirectory>\bin"
```

## Scenario E — Local stdio ★ (single developer)

VS spawns the server as a subprocess — no HTTP, no manual start. Build the index as in Scenario C, then:

```json
{
  "servers": {
    "d365fo-mcp-tools": {
      "command": "node",
      "args": ["C:\\d365fo-mcp-server\\dist\\index.js"],
      "env": {
        "D365FO_CONFIG": "C:\\d365fo-mcp-server\\config\\d365fo-mcp.json"
      }
    }
  }
}
```

The database paths and `workspace.solutionsPath` come from the config file; the `env` block only has to say which config to load. `workspace.solutionsPath` is scanned for `.rnrproj` files at startup; the MCP roots protocol delivers the open workspace automatically. Switch projects without restart via `get_workspace_info(projectPath=...)`. Details: [MCP_CONFIG.md § Automatic workspace detection](MCP_CONFIG.md#automatic-workspace-detection)

## Scenario F — Multiple instances

One machine, several D365FO clients — each instance gets its own config file, database, and port:

```powershell
npx d365fo-mcp instance add             # name + port, then the same questions as `setup`,
                                        # → instances\<name>\{d365fo-mcp.json,data,metadata}
npx d365fo-mcp instance rebuild clientA # first build: extract + build index (--all for all instances)
npx d365fo-mcp instance run clientA     # start on its port
```

`instance upgrade <name>` repoints an instance at a new XPP config after a UDE version upgrade and rebuilds it. Each command is interactive when the name is omitted. To run an instance manually, point the server at its config: `D365FO_CONFIG=instances\clientA\d365fo-mcp.json node dist\index.js`.

Provisioning instances from a script instead of interactively? Copy `instances\d365fo-mcp.template.json` to `instances\<name>\d365fo-mcp.json` and fill in the blanks. The `instances\*.ps1` scripts remain for installations still configured through per-instance `.env` files.

> **Instance config under `instances\<name>\config\`?** Some builds wrote it one level deeper. Such an instance still runs, but `D365FO_CONFIG=instances\<name>\d365fo-mcp.json` as written above then names a file that does not exist and the server starts on defaults. `d365fo-mcp doctor` flags it; `instance upgrade <name>` moves `d365fo-mcp.json` and `secrets.json` up one level, or move the two files yourself.

### Keeping instances in sync

Updating the server code and reindexing an instance's database are **separate** steps, at different scopes:

- **Server binaries are repo-global.** All instances run the same `dist/`, so update it once — never per instance:
  ```powershell
  git pull; npm install; npm run build      # once; then restart the instances
  ```
- **Databases are per-instance.** `rebuild-instance.ps1` runs a full reindex from the current source. Only reindex when it's actually needed:

  | What changed | Command |
  |---|---|
  | First build of an instance | `rebuild-instance.ps1 <name>` |
  | **Microsoft base** upgraded (UDE version) | `upgrade-instance.ps1 <name>` |
  | Pull changed the **parser / DB schema** | `rebuild-instance.ps1 --all` |
  | Runtime-only code change | *(just `npm run build` + restart — no reindex)* |

  Add `--all` to rebuild every instance.

> `rebuild-instance.ps1` deliberately does **not** `git pull` or build binaries: that is a repo-wide action, and doing it while rebuilding a single instance would leave the others running new binaries against an old-schema database.

Point a per-solution `.mcp.json` at the right port:

```json
{
  "servers": {
    "d365fo-clientA": { "url": "http://localhost:3001/mcp/" }
  }
}
```

> `npx d365fo-mcp doctor` checks every instance after an upgrade: index size, a pinned XPP config that no longer resolves, and any legacy `.env` that contradicts the instance config.

---

## Building the C# bridge

**Mandatory on Windows D365FO VMs** — it is the only write path (`d365fo_file` action=create/modify). Without it the server runs read-only.

```powershell
cd bridge\D365MetadataBridge
dotnet build -c Release        # output: bin\Release\D365MetadataBridge.exe (auto-detected)
```

| Situation | Action |
|-----------|--------|
| UDE box (DLLs not in `PackagesLocalDirectory\bin`) | `dotnet build -c Release -p:D365BinPath="<FrameworkDirectory>\bin"` |
| Restrictive NuGet feed | add `--source https://api.nuget.org/v3/index.json` |
| After a D365FO version upgrade | rebuild to pick up new DLLs |

Healthy startup: `✅ C# bridge initialized (metadataAvailable: true, xrefAvailable: true)`. `xrefAvailable: false` is non-critical (xref tools fall back to SQLite FTS). Full reference: [ARCHITECTURE.md § C# Metadata Bridge](ARCHITECTURE.md#c-metadata-bridge)

---

## Where to place .mcp.json

| Location | Scope | Use when |
|----------|-------|----------|
| next to the `.sln` | that solution only | per-project servers/ports (Scenario F) |
| `%USERPROFILE%\.mcp.json` | all solutions | one environment for everything (recommended) |

The server searches from the working directory up to 5 parent levels.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tools don't appear in Copilot | VS ≥ 17.14 · MCP enabled on github.com **and** in VS options · Agent Mode active · restart VS after editing `.mcp.json` |
| Copilot uses built-in file search instead of tools | `.github\copilot-instructions.md` must exist in a parent of the solution folder |
| File created in the wrong model | use the two-level `D365FO_WORKSPACE_PATH`: `...\PackagesLocalDirectory\<Package>\<Model>` — see [MCP_CONFIG.md § Automatic workspace detection](MCP_CONFIG.md#automatic-workspace-detection) |
| Local companion won't start | `node --version` (24.x) · re-run `npm install && npm run build` · check the path in `args` |
| Writes fail / bridge missing | build the bridge (above) · check `.NET 4.8` · see startup log flags |
| No search results | Azure: open `/health` in a browser · local: `data/xpp-metadata.db` exists and is > 100 MB |

---

## Claude Code CLI

Same build as above — no Visual Studio required. Register the server with `claude mcp add-json`; the **`alwaysLoad`** flag loads the tool list at session start so Claude never routes X++ lookups to another tool.

```powershell
# Azure-hosted server (most teams)
claude mcp add-json --scope user d365fo-mcp-tools '{"type":"http","url":"https://your-server.azurewebsites.net/mcp/","alwaysLoad":true}'

# Local stdio (single developer)
claude mcp add-json --scope user d365fo-mcp-tools '{"type":"stdio","command":"node","args":["K:\\d365fo-mcp-server\\dist\\index.js"],"env":{"D365FO_CONFIG":"K:\\d365fo-mcp-server\\config\\d365fo-mcp.json"},"alwaysLoad":true}'
```

For a team-shared, project-scoped config, create `.mcp.json` in the solution root using Claude Code's **`mcpServers`** key (not `servers`). Finally, copy `.github/copilot-instructions.md` to the parent of your solutions renamed to **`CLAUDE.md`** — Claude Code reads it automatically from the working directory upward.

---

## Next steps

[MCP_CONFIG.md](MCP_CONFIG.md) — every option · [MCP_TOOLS.md](MCP_TOOLS.md) — all 26 tools · [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) — real workflows · [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) — ISV/multi-model · [SETUP_AZURE.md § pipelines](SETUP_AZURE.md#azure-devops-pipelines) — automated index refresh
