# D365 F&O MCP Server

<div align="center">

**54 AI tools that know every X++ class, table, method, and EDT in your D365FO codebase**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)

*Built for D365FO developers who write X++ in Visual Studio — not for generic web dev*

</div>

---

## Why this exists

GitHub Copilot excels at C#, Python, and JavaScript — languages with rich public training data. X++ is different. Your D365FO codebase is private, highly customized, and deeply interconnected: thousands of CoC extensions layered over standard Microsoft code, ISV packages adding their own tables and classes, custom EDTs that drive field validation across dozens of forms. Copilot has never seen any of it.

The result is AI that confidently generates code that doesn't compile: wrong method signatures, missing parameters, fields that don't exist on the table, CoC chains broken because Copilot didn't know an extension already wrapped the method.

This MCP server solves that by pre-indexing your entire D365FO installation — 584,799+ symbols across standard and custom models — and exposing it to Copilot as 54 specialized tools. Before generating any X++ code, Copilot can look up exact method signatures, check what CoC extensions already exist, trace security hierarchies, find label translations, and understand the full shape of your data model. The result is code that compiles on the first try and integrates correctly with your existing customizations.

![Solution Architecture](docs/img/solution-architecture-diagram.png)

| Without this server | With this server |
|---------------------|-----------------|
| Copilot guesses method signatures → compile errors | Exact signatures pulled from your actual codebase |
| "Does CustTable.validateWrite() have any CoC wrappers?" requires manual AOT search | `find_coc_extensions` answers in < 50 ms |
| ISV and custom model extensions invisible to Copilot | All models fully indexed and searchable |
| Security hierarchy takes hours to trace manually | `get_security_coverage_for_object` traces Role → Duty → Privilege → Entry Point instantly |
| Copilot generates hardcoded strings instead of label references | `search_labels` finds the right `@SYS`/`@MODULE` label key immediately |
| "Which tables reference CustTable?" requires digging through AOT relations | `get_table_relations` returns every FK relation and cardinality in one call |
| EDT base types and field lengths are a constant lookup | `get_edt_details` returns the full EDT definition including extends chain |
| Copilot doesn't know which SysOperation framework class to extend | `search_classes` with a description filter surfaces the right base class |
| New CoC extension may silently duplicate an existing one | `find_coc_extensions` reveals all existing wrappers before you write a line |
| Menu item to form mapping requires navigating the AOT manually | `get_menu_item_details` resolves the full path from menu item to form to data source |

---

## Key Capabilities
- **Massive Metadata Index:** Instantly looks up signatures, tables, enums, EDTs across standard and ISV code out of 580,000+ objects.
- **Smart Object Generation:** AI-driven tools build XML structures exactly matching D365 standard patterns (SimpleList, Forms, Tables).
- **X++ Knowledge Base:** Queryable knowledge base of D365FO patterns, best practices, and AX2012→D365FO migration guidance — prevents deprecated API usage.
- **Code Review & Git Diff:** Reviews uncommitted workspace changes locally matching D365 Best Practice metrics directly against Copilot chat.
- **D365 SDLC Native Integration:** Triggers local MSBuild, sync.exe database updates, SysTestRunner tests, and xppbp.exe best practice validations smoothly behind the scenes.
- **XML Parsing without Corruption:** Intelligently mutates AxTable and AxForm files locally avoiding the common string replacement corruption associated with VS agents.

## Quick Start

**Prerequisites** — install required software via [d365fo.tools](https://github.com/d365collaborative/d365fo.tools):

```powershell
Install-D365SupportingSoftware -Name vscode,python,node.js
```

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git
cd d365fo-mcp-server
npm install

# Build the C# bridge (required on Windows D365FO VMs for file create/modify)
cd bridge\D365MetadataBridge
dotnet build -c Release
cd ..\..                         # Back to repo root

copy .env.example .env           # Set PACKAGES_PATH, CUSTOM_MODELS, LABEL_LANGUAGES, ...
npm run extract-metadata         # Extract XML from D365FO packages
npm run build-database           # Build SQLite index
npm run dev
```

> **UDE / Power Platform Tools?** Run `npm run select-config` instead of setting `PACKAGES_PATH` manually.

---

## Connect to GitHub Copilot

**1.** Enable *MCP servers in Copilot* at **github.com/settings/copilot/features**

**2.** In Visual Studio: **Tools → Options → GitHub → Copilot** → check *Enable MCP server integration in agent mode*

**3.** Create `%USERPROFILE%\.mcp.json` (covers all solutions on the machine, recommended) or place `.mcp.json` next to a specific `.sln` file:

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
        "D365FO_SOLUTIONS_PATH": "K:\\VSProjects\\MySolution"
      }
    },
    "context": {
      "workspacePath": "K:\\AosService\\PackagesLocalDirectory\\YourPackageName\\YourModelName"
    }
  }
}
```

**4.** Copy the Copilot instruction files so Copilot knows the D365FO workflow rules:

```powershell
# Place .github in a parent folder shared by all your D365FO solutions, e.g.:
Copy-Item -Path ".github" -Destination "C:\source\repos\" -Recurse
```

> **Tip:** Visual Studio 2022 searches for `.github\copilot-instructions.md` upward from the solution folder, so one copy in a common parent directory covers all solutions underneath — no need to copy it into every solution separately.

> **Full config options** (UDE paths, explicit projectPath, solutionPath): [docs/MCP_CONFIG.md](docs/MCP_CONFIG.md)

---

## Azure Deployment

Host on Azure App Service so the whole team shares one instance — nobody needs the server running locally.

![Deployment Modes](docs/img/solution-architecture-diagram-deployment-modes.png)

| Resource | Configuration | Monthly cost |
|----------|---------------|-------------|
| App Service Basic B3 | 4 vCPU, 7 GB RAM | ~$52 |
| Blob Storage | ~2.5–3.5 GB (symbols + labels, without/with UnitTest models) | ~$3 |
| **Total** | | **~$55 / month** |

The database downloads from Azure Blob Storage automatically on startup.

Setup guide: [docs/SETUP.md](docs/SETUP.md) · CI/CD pipeline: [docs/PIPELINES.md](docs/PIPELINES.md)


[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fdynamics365ninja%2Fd365fo-mcp-server%2Frefs%2Fheads%2Fmain%2Finfrastructure%2Fazuredeploy.json)

---

## Documentation

| File | Contents |
|------|---------|
| [docs/SETUP.md](docs/SETUP.md) | Installation, configuration, Azure deployment |
| [docs/MCP_CONFIG.md](docs/MCP_CONFIG.md) | `.mcp.json` reference — workspace paths, UDE, project settings |
| [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) | All 54 tools with parameters and example prompts |
| [docs/USAGE_EXAMPLES.md](docs/USAGE_EXAMPLES.md) | Practical examples: search, CoC, SysOperation, security |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture, dual-database design, cache invalidation |
| [docs/BRIDGE.md](docs/BRIDGE.md) | C# Metadata Bridge reference — mandatory on Windows VMs for all write operations |
| [docs/CUSTOM_EXTENSIONS.md](docs/CUSTOM_EXTENSIONS.md) | ISV / custom model configuration |
| [docs/PIPELINES.md](docs/PIPELINES.md) | Automated metadata extraction via Azure DevOps |
