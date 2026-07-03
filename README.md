# D365 F&O MCP Server

<div align="center">

**26 AI tools that know every X++ class, table, form, and EDT in your D365FO codebase**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-1400%2B-brightgreen.svg)](docs/TESTING.md)

*Grounded AI development for Dynamics 365 Finance & Operations — works with GitHub Copilot and Claude Code*

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_d365fo-0098FF?style=flat-square&logo=githubcopilot&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=d365fo&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22d365fo_server_url%22%2C%22description%22%3A%22D365FO%20MCP%20server%20URL%20(e.g.%20https%3A%2F%2Fyour-server.azurewebsites.net%2Fmcp%2F)%22%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22%24%7Binput%3Ad365fo_server_url%7D%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_d365fo-24bfa5?style=flat-square&logo=githubcopilot&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=d365fo&quality=insiders&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22d365fo_server_url%22%2C%22description%22%3A%22D365FO%20MCP%20server%20URL%20(e.g.%20https%3A%2F%2Fyour-server.azurewebsites.net%2Fmcp%2F)%22%7D%5D&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22%24%7Binput%3Ad365fo_server_url%7D%22%7D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_d365fo-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=d365fo&config=eyJ1cmwiOiJodHRwczovL3lvdXItc2VydmVyLmF6dXJld2Vic2l0ZXMubmV0L21jcC8ifQ%3D%3D)

*One-click install connects to an already-deployed server — VS Code asks for the URL, Cursor installs a placeholder to edit. Visual Studio & Claude Code: see [Quick Start](#quick-start).*

</div>

---

## Why

AI assistants excel at C#, Python, and JavaScript. X++ is different: your D365FO codebase is private, deeply customized, and invisible to every model — so AI confidently generates code that doesn't compile.

This server pre-indexes your entire D365FO installation (580 000+ symbols across standard, ISV, and custom models) and exposes it as 26 specialized MCP tools. Every signature, every CoC wrapper, every label, every form pattern — verified against your real metadata **before** the AI writes a single line.

![Solution Architecture](docs/img/solution-architecture-diagram.svg)

| Task | Without this server | With this server |
|------|--------------------|------------------|
| Method signatures | Guessed → compile errors | Exact, from your codebase |
| Existing CoC wrappers | Manual AOT search | `extension_info(mode="coc")` in < 50 ms |
| New forms | Hand-written XML, broken patterns | Cloned from reference forms, validated against the pattern catalog |
| Labels | Hardcoded strings | Right `@SYS`/`@MODULE` key found instantly |
| Security chains | Hours of manual tracing | Role → Duty → Privilege → Entry Point in one call |
| Generated code | Hallucinated fields and types | Every reference proven against the index, gated before write |

---

## Capabilities

| Feature | Description |
|---|---|
| 🔍 **Full-codebase intelligence** | 580K+ symbols indexed: classes, tables, forms, EDTs, enums, labels (20M+ rows), security artifacts — FTS5 search in < 10 ms |
| 🛡️ **Grounded generation** | Fail-closed gates: `prepare` issues grounding tokens, `validate_code(mode="references")` proves every identifier, `validate_code(mode="syntax")` enforces best practices — hallucinated code never reaches disk |
| 🧩 **Form pattern engine** | Complete catalog of Microsoft form patterns and sub-patterns: recommends the right pattern, clones reference forms with datasource re-binding, **deterministically expands** patterns that have no reference form, **auto-repairs** a form's missing required controls, validates structure and blocks invalid writes |
| ✍️ **Safe metadata writes** | C# bridge uses Microsoft's own `IMetadataProvider` — no string-replacement XML corruption, automatic `.rnrproj` registration, one-call undo |
| 🏗️ **SDLC integration** | MSBuild compilation with structured diagnostics, DB sync, xppbp best practices, SysTestRunner — all from chat |
| 📐 **X++ knowledge base** | Queryable rules: select grammar, CoC authoring, financial dimensions, the posting engine (`LedgerVoucher`), number sequences, `SysExtension`, Electronic Reporting, AX2012→D365FO migration — prevents deprecated APIs |

### Pattern-grounded form development

Forms are the hardest artifact to generate correctly — each pattern dictates required containers, ordering, and allowed sub-patterns. The form pattern engine makes it a guided pipeline:

```mermaid
flowchart LR
    A["object_patterns<br/>(domain=form, action=analyze)"] --> B["object_patterns<br/>(domain=form, action=spec)"]
    B --> C["generate_object<br/>objectType=form, cloneFrom"]
    C --> D["object_patterns<br/>(domain=form, action=validate) FP001–FP010"]
    D -->|clean| E["d365fo_file<br/>(action=create) write + project"]
    D -->|errors| C
```

Structural violations (wrong order, missing container, disallowed control) **block the write** — recommendations only warn. Mined pattern statistics from your own environment ground every suggestion in reality.

---

## Quick Start

Pick your path:

| Path | Who | Install effort |
|------|-----|---------------|
| **A — Azure client** | Team member, server already deployed | `.mcp.json` only — 2 minutes |
| **B — Hybrid** (recommended for teams) | Azure search + local writes on your VM | Clone + build, no indexing |
| **C/E — Local** | Single developer, everything on the VM | Clone + build + index (~15 min) |

Full walkthrough with all scenarios: **[docs/QUICK_START.md](docs/QUICK_START.md)**

### Interactive setup (recommended)

After cloning and `npm install`, the management CLI walks you through everything else — scenario selection, C# bridge build, `.env` configuration, index build — and prints the `.mcp.json` block to paste:

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
npm run setup        # first-time setup wizard
npm run doctor       # health check — verifies Node, build, index, bridge
```

Day-to-day management runs through the same CLI (`npx d365fo-mcp` or `npm run cli --`): `start`, `update`, `index`, and `instance add/list/run/rebuild/upgrade` for multi-instance setups. Every command works non-interactively with arguments, or asks with predefined choices when run bare.

### Manual setup

```powershell
# Local / hybrid install (on the D365FO VM)
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git K:\d365fo-mcp-server
cd K:\d365fo-mcp-server
npm install
cd bridge\D365MetadataBridge; dotnet build -c Release; cd ..\..   # C# bridge — required for writes
npm run build

# Local only — build the metadata index (skip for hybrid)
copy .env.example .env            # set PACKAGES_PATH, CUSTOM_MODELS
npm run extract-metadata
npm run build-database
```

> **UDE / Power Platform Tools?** Run `npm run select-config` instead of editing `PACKAGES_PATH`.

### Connect GitHub Copilot

1. Enable *MCP servers in Copilot* at [github.com/settings/copilot/features](https://github.com/settings/copilot/features)
2. Visual Studio → **Tools → Options → GitHub → Copilot** → *Enable MCP server integration in agent mode*
3. Create `%USERPROFILE%\.mcp.json`:

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

4. Copy the instruction files into a parent folder of your solutions (one copy covers everything beneath it):

```powershell
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

All options: **[docs/MCP_CONFIG.md](docs/MCP_CONFIG.md)**

### Connect Claude Code

```powershell
claude mcp add-json --scope user d365fo-mcp-tools '{"type":"http","url":"https://your-server.azurewebsites.net/mcp/","alwaysLoad":true}'
Copy-Item "K:\d365fo-mcp-server\CLAUDE.template.md" "C:\source\repos\CLAUDE.md"
```

Stdio variant and troubleshooting: **[docs/CLAUDE_CODE_SETUP.md](docs/CLAUDE_CODE_SETUP.md)**

### Verify

Open the AI chat (Copilot Agent Mode / Claude Code) and ask:

```
What tables contain "CustAccount" field?
```

A `search` tool call returning results from your codebase = you're connected.

---

## Azure Deployment

One shared instance for the whole team — the metadata index lives in Blob Storage and downloads automatically on startup.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fdynamics365ninja%2Fd365fo-mcp-server%2Frefs%2Fheads%2Fmain%2Finfrastructure%2Fazuredeploy.json)

Deployment guide: [docs/SETUP_AZURE.md](docs/SETUP_AZURE.md) · CI/CD automation: [docs/PIPELINES.md](docs/PIPELINES.md)

---

## Documentation

| Getting started | Reference | Operations |
|-----------------|-----------|------------|
| [Quick Start](docs/QUICK_START.md) — 5 steps to running | [All 26 tools](docs/MCP_TOOLS.md) | [Azure deployment](docs/SETUP_AZURE.md) |
| [Setup scenarios A–F](docs/SETUP.md) | [`.mcp.json` reference](docs/MCP_CONFIG.md) | [DevOps pipelines](docs/PIPELINES.md) |
| [Claude Code setup](docs/CLAUDE_CODE_SETUP.md) | [Architecture](docs/ARCHITECTURE.md) | [Testing](docs/TESTING.md) |
| [Usage examples](docs/USAGE_EXAMPLES.md) — real tool chains | [C# Bridge](docs/BRIDGE.md) | [Custom / ISV models](docs/CUSTOM_EXTENSIONS.md) |
| | [Workspace detection](docs/WORKSPACE_DETECTION.md) | [SQLite vs Bridge](docs/SQLITE_DEPENDENCY.md) |
| | [Backlog](docs/BACKLOG.md) — deferred work & ideas | |

## License

MIT
