# D365 F&O MCP Server

<div align="center">

**AI-Powered Code Intelligence for Microsoft Dynamics 365 Finance & Operations**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

[Getting Started](#-getting-started) &bull; [What It Does](#-what-it-does) &bull; [Setup](#-visual-studio-2022-setup) &bull; [Docs](#-documentation)

</div>

---

## What Is This?

**D365 F&O MCP Server** connects GitHub Copilot to your Dynamics 365 Finance & Operations
environment. With this server running, Copilot actually *knows* your codebase: it understands
which classes, tables, and methods exist, and generates X++ code that compiles on the first try.

### The Problem It Solves

Without this server, GitHub Copilot has no knowledge of D365FO. It guesses class and method
names, and those guesses are often wrong. You end up chasing compilation errors instead of
writing code.

| Without the server | With this server |
|--------------------|-----------------|
| Copilot guesses method names → compilation errors | Copilot knows exact signatures → code works |
| AOT browsing: 5–30 minutes of clicking | Answer in under 50 ms |
| 500 000+ symbols with no quick way to search | Everything indexed and instantly searchable |
| "What was that method on CustTable called again?" | Just ask Copilot |

---

## What It Does

You get **20 tools** for D365FO code intelligence. You ask Copilot in plain English; it picks
the right tool automatically.

### Finding and Exploring Code
- Search classes, tables, methods, fields, enums across 584 799+ symbols
- View a complete class structure: all methods, inheritance chain, source code
- View a table schema: fields with types, indexes, foreign key relations
- Browse forms, queries, and views
- Find everywhere a class, method, or field is used (where-used analysis)

### Generating Code
- Learns patterns from your *actual* codebase, not generic templates
- Builds correct Chain of Command (CoC) extensions with exact method signatures
- Suggests missing methods by comparing your class against similar ones
- Shows how a specific API is typically initialized and used in your environment

### Working with Files
- Generates correct D365FO XML for classes, tables, forms, enums
- On a local Windows VM: writes the file directly to the right AOT location
- Automatically adds the new file to your Visual Studio project (.rnrproj)
- Safely edits existing files with an automatic backup before every change

---

## Getting Started

### Prerequisites

| Component | Version |
|-----------|---------|
| Node.js | 22 LTS or newer |
| Visual Studio 2022 | 17.14 or newer |
| GitHub Copilot | Active subscription |
| D365FO dev environment | Local VM or Azure |

### Installation

```powershell
# 1. Clone the repository
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git
cd d365fo-mcp-server

# 2. Install dependencies
npm install

# 3. Configure environment variables
copy .env.example .env
# Edit .env with your paths and settings

# 4. Extract D365FO metadata
npm run extract-metadata

# 5. Build the symbol database
npm run build-database

# 6. Start the server
npm run dev
```

The server runs at `http://localhost:8080`.

For full details including Azure deployment, see [docs/SETUP.md](docs/SETUP.md).

---

## Visual Studio 2022 Setup

### Step 1 — Enable Agent Mode in your GitHub account

Go to **https://github.com/settings/copilot/features** and enable *Editor Preview Features*.

> Without this setting, Copilot will not load MCP tools at all.

### Step 2 — Enable MCP in Visual Studio

**Tools → Options → GitHub → Copilot** → check **"Enable MCP server integration in agent mode"**.

### Step 3 — Create `.mcp.json` in your solution root

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-server.azurewebsites.net/mcp/",
      "description": "D365 F&O Code Intelligence"
    },
    "context": {
      "workspacePath": "K:\\AosService\\PackagesLocalDirectory\\YourModel"
    }
  }
}
```

For a local server use `http://localhost:8080/mcp/` instead of the Azure URL.

### Step 4 — Copy Copilot instructions to your workspace

```powershell
# Copy the .github folder to your D365FO solution root
Copy-Item -Path ".github" -Destination "C:\Path\To\YourSolution\" -Recurse
```

The file `.github/copilot-instructions.md` tells Copilot to always use the MCP tools
instead of its built-in file search (which hangs for 5–30 minutes on large D365FO workspaces).

### Step 5 — Restart Visual Studio and verify

Open Copilot Chat in **Agent Mode** and ask:

```
Show me all methods on CustTable
```

Copilot should respond within 1 second with an exact list of methods.

---

## Example Prompts

Just ask in plain English — no need to know which tool to use.

```
What methods does SalesTable have?

Show me the structure of CustTable: fields, indexes, and relations

Create a helper class for customer validation

Where is CustTable.validateWrite() called?

How do I correctly initialize DimensionAttributeValueSet?

Create a CoC extension for SalesTable.validateWrite()

Check whether my class MyHelper is missing any standard methods

Find all my custom extensions for classes starting with ISV_
```

More examples in [docs/USAGE_EXAMPLES.md](docs/USAGE_EXAMPLES.md).

---

## Azure Deployment

You can host the server on Azure App Service so the whole team shares one instance.

Approximate monthly cost:

| Resource | Configuration | Monthly cost |
|----------|--------------|-------------|
| App Service P0v3 | 1 vCPU, 4 GB RAM | ~$62 |
| Blob Storage | 2 GB | ~$3 |
| Redis Cache (optional) | Basic C0 | ~$16 |
| **Total without Redis** | | **~$65 / month** |

Full setup instructions in [docs/SETUP.md](docs/SETUP.md).

---

## Documentation

| File | What you will find |
|------|-------------------|
| [docs/SETUP.md](docs/SETUP.md) | Installation, environment config, Azure deployment |
| [docs/MCP_CONFIG.md](docs/MCP_CONFIG.md) | The `.mcp.json` file — workspace paths and project settings |
| [docs/WORKSPACE_DETECTION.md](docs/WORKSPACE_DETECTION.md) | How the server auto-detects your model from `.rnrproj` |
| [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) | All 20 tools explained with example prompts |
| [docs/USAGE_EXAMPLES.md](docs/USAGE_EXAMPLES.md) | Practical examples: searching, code generation, CoC extensions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture (for contributors) |
| [docs/CUSTOM_EXTENSIONS.md](docs/CUSTOM_EXTENSIONS.md) | ISV partner and custom model configuration |
| [docs/PIPELINES.md](docs/PIPELINES.md) | Automating metadata extraction with Azure DevOps |
| [docs/TESTING.md](docs/TESTING.md) | Running the test suite |

---

## Contributing

Pull requests are welcome. Please target the `develop` branch.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-change`
3. Commit: `git commit -m "Description of change"`
4. Push: `git push origin feature/my-change`
5. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE).

<div align="center">

**Built for the D365 F&O developer community**

[Report a bug](https://github.com/dynamics365ninja/d365fo-mcp-server/issues) &bull;
[Request a feature](https://github.com/dynamics365ninja/d365fo-mcp-server/issues) &bull;
[Documentation](docs/)

</div>
