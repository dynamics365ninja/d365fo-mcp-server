# D365 F&O MCP Server

<div align="center">

**AI-Powered Code Intelligence for Microsoft Dynamics 365 Finance & Operations**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange.svg)](https://modelcontextprotocol.io/)
[![Azure](https://img.shields.io/badge/Azure-Ready-0078D4.svg)](https://azure.microsoft.com/)

[Getting Started](#-quick-start) •
[Features](#-features) •
[Documentation](#-documentation) •
[Architecture](#-architecture) •
[Contributing](#-contributing)

</div>

---

## 📋 Overview

The **D365 F&O MCP Server** bridges the gap between AI-powered development tools and Microsoft Dynamics 365 Finance & Operations. It implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) to provide real-time X++ code intelligence directly within your IDE through GitHub Copilot.

### The Problem

Developing for D365 F&O presents unique challenges:

| Challenge | Impact |
|-----------|--------|
| **Massive Codebase** | 500,000+ symbols across standard application |
| **Limited IDE Support** | No IntelliSense outside Visual Studio |
| **AI Knowledge Gap** | GitHub Copilot lacks D365-specific context |
| **Slow Metadata Access** | AOT browsing is time-consuming |
| **Extension Complexity** | Finding correct extension points is difficult |

### The Solution

This MCP server provides GitHub Copilot with complete knowledge of your D365 F&O environment:

```
┌─────────────────────────────────────────────────────────────────────┐
│  "Show me methods available on CustTable"                           │
│                                                                     │
│  → GitHub Copilot queries MCP Server                                │
│  → Server searches 584,799 indexed symbols in <50ms                 │
│  → Returns class info, methods, parameters, inheritance             │
│  → Copilot generates accurate, context-aware code                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Important for GitHub Copilot Users

**When working with this repository, GitHub Copilot MUST use the specialized X++ MCP tools, NOT the built-in search tools.**

### 🚫 DO NOT USE (for X++ searches):
- ❌ `code_search` - Will hang for 5+ minutes with "Searching..." on large D365FO workspaces

### ⚠️ USE WITH CAUTION:
- ⚠️ `file_search` - OK for finding files in THIS workspace, but use MCP `search` for X++ objects

### ✅ ALWAYS USE (for X++ objects):
- ✅ `search` (MCP tool) - 100x faster, indexed SQL, X++-aware
- ✅ `get_class_info` - Get class structure instantly
- ✅ `get_table_info` - Get table structure instantly

**See [.github/copilot-instructions.md](.github/copilot-instructions.md) for complete guidelines.**

---

## 👥 Who Is This For?

<table>
<tr>
<td width="33%">

### 🔧 D365 Developers
- Get instant code completion for X++ classes and tables
- Discover methods, fields, and relationships
- Generate boilerplate code for common patterns

</td>
<td width="33%">

### 🏢 ISV Partners
- Search custom extensions separately from standard
- Find extension points across the application
- Maintain consistency across development teams

</td>
<td width="33%">

### 🚀 Technical Consultants
- Quickly explore unfamiliar modules
- Understand table relationships and data models
- Generate documentation and code reviews

</td>
</tr>
</table>

---

## ✨ Features

### Core Capabilities

#### Search & Discovery

| Tool | Description |
|------|-------------|
| **`search`** | Find X++ classes, tables, methods, and fields across all standard and custom modules |
| **`search_extensions`** | Search only within your custom extensions and ISV models |
| **`batch_search`** | Execute multiple searches in parallel for faster exploration |
| **`get_class_info`** | View complete class structure: methods, properties, inheritance hierarchy |
| **`get_table_info`** | View table schema: fields, indexes, relations, and configuration |
| **`code_completion`** | Get method and field suggestions while typing (IntelliSense-style) |

#### Intelligent Code Generation

| Tool | Description |
|------|-------------|
| **`analyze_code_patterns`** | Learn common coding patterns from your actual D365FO codebase |
| **`generate_code`** | Generate X++ code following patterns found in your environment |
| **`suggest_method_implementation`** | Get implementation examples from similar methods in your code |
| **`analyze_class_completeness`** | Check if a class is missing common methods (validate, find, etc.) |
| **`get_api_usage_patterns`** | See real examples of how to initialize and use D365FO APIs |

#### File Creation

| Tool | Deployment | Description |
|------|------------|-------------|
| **`generate_d365fo_xml`** | ☁️ Cloud + 💻 Local | Generate D365FO XML files (classes, tables, forms, enums). Works everywhere - Azure, local, containers. Returns XML content for Copilot to create file. |
| **`create_d365fo_file`** | 💻 Local only | Full automation: creates file + adds to Visual Studio project. Only works on local Windows D365FO VM with K:\ drive access. |

### 🔹 Workspace-Aware Features

The MCP server now supports **hybrid search** — combining external D365FO metadata with your local project files for context-aware code intelligence.

| Feature | Description |
|---------|-------------|
| **Workspace Scanning** | Automatically detects X++ files (AxClass, AxTable, AxForm, AxEnum) in your project |
| **Hybrid Search** | Searches both external D365FO metadata AND your local workspace |
| **Prioritization** | Workspace files appear first in search results (marked with 🔹) |
| **Pattern Analysis** | Analyzes code patterns from YOUR project, not just generic examples |

**Benefits:**
- ✅ See your custom extensions alongside standard D365FO code
- ✅ Pattern analysis learns from YOUR codebase
- ✅ Workspace code prioritized over external metadata
- ✅ No manual indexing needed — scans on-demand with caching

#### How to Use Workspace-Aware Features

**In VS Code (Automatic):**
GitHub Copilot automatically detects your workspace path and includes it in MCP tool calls.

**In Visual Studio 2022 (Manual Workaround):**
Since VS 2022 doesn't automatically provide workspace path, explicitly specify it in your query:

```
Search for "MyCustomClass" including my workspace at "C:\AOSService\PackagesLocalDirectory\MyModel"
```

Or set context once per session:
```
My workspace path is C:\D365\MyProject\PackagesLocalDirectory\MyModel
Remember this for all queries in this session.
```

#### Performance & Limitations

- **Caching:** Workspace scans are cached for 5 minutes
- **Speed:** Glob-based discovery is fast (<100ms for typical projects)
- **Deduplication:** Workspace files take priority over external metadata
- **Limitation:** Large workspaces (>1000 files) may be slower
- **No auto-refresh:** Manual refresh needed after file changes

### Technical Highlights

- 🔍 **Full-Text Search** — FTS5-powered search across 584,799+ symbols
- ⚡ **Sub-50ms Response** — Optimized SQLite queries with intelligent caching
- 🔐 **Enterprise Ready** — OAuth 2.0 authentication, rate limiting, Azure integration
- 💾 **Redis Caching** — Optional caching layer for improved performance
- 🌐 **Cloud Native** — Deploy to Azure App Service with automated CI/CD

---

## 📊 Comparison: Before vs After

| Scenario | Without MCP Server | With MCP Server |
|----------|-------------------|-----------------|
| Finding a class method | Open AOT → Navigate → Expand → Search | Ask: "What methods does SalesTable have?" |
| Understanding table schema | Open table in AOT → Check fields → Check relations | Ask: "Show me CustTable fields and relations" |
| Code generation | Copy from existing code → Modify manually | Ask: "Generate a batch job for inventory processing" |
| Extension discovery | Search solution → Check multiple projects | Ask: "Find all custom extensions for CustTable" |
| Learning new modules | Read documentation → Trial and error | Ask: "What classes handle sales order processing?" |

### Performance Metrics

```
┌────────────────────────────────────────────────────────────────┐
│  Symbols Indexed      584,799    (classes, tables, methods)   │
│  Database Size        ~2 GB      (SQLite with FTS5)           │
│  Search Latency       <50 ms     (with caching: <10 ms)       │
│  Startup Time         <5 sec     (database download)          │
└────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Deployment Options

The MCP server supports two deployment modes:

- **☁️ Cloud (Azure)** - Recommended for teams. Runs on Linux, provides XML generation only.
- **💻 Local (Windows)** - Full automation including file creation. Requires D365FO VM.

> **Note:** File creation tools work differently based on deployment:
> - `generate_d365fo_xml` - Works in both cloud and local (generates XML, Copilot creates file)
> - `create_d365fo_file` - Works only locally on Windows (full automation)

### Prerequisites

- **Node.js** 22 LTS or later
- **D365 F&O** development environment (for metadata extraction)
- **Azure Storage** account (for cloud deployment)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git
cd d365fo-mcp-server

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your settings

# 4. Extract metadata from D365FO
npm run extract-metadata

# 5. Build the SQLite database
npm run build-database

# 6. Start the server
npm run dev
```

The server will be available at `http://localhost:8080/mcp`

---

## 🖥️ Visual Studio 2022 Integration

This MCP server is designed to work seamlessly with **Visual Studio 2022** through GitHub Copilot's Agent Mode, providing AI-powered X++ code intelligence directly in your D365 F&O development environment.

### Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Visual Studio 2022 | 17.14+ | Required for MCP support |
| GitHub Copilot Extension | Latest | Enterprise or Individual subscription |
| GitHub Copilot Chat | Latest | Agent Mode enabled |

### Setup Instructions

1. **Enable Editor Preview Features** in your GitHub account:
   
   👉 https://github.com/settings/copilot/features
   
   > ⚠️ Without this setting enabled, MCP tools will not load in GitHub Copilot.

2. **Enable MCP Integration in Visual Studio**:
   
   Navigate to **Tools** → **Options** → **GitHub** → **Copilot** and enable:
   - ✅ *"Enable MCP server integration in agent mode"*

3. **Create `.mcp.json`** in your solution root:

   ```json
   {
     "servers": {
       "d365fo-code-intelligence": {
         "url": "https://your-app.azurewebsites.net/mcp/",
         "description": "D365 F&O Code Intelligence Server"
       },
       "context": {
         "workspacePath": "K:\\AOSService\\PackagesLocalDirectory\\MyModel"
       }
     }
   }
   ```

4. **Copy Copilot Instructions to Your Workspace** (CRITICAL):
   
   ```powershell
   # Copy .github folder from this repo to your D365FO workspace (Visual Studio solution folder)
   Copy-Item -Path ".github" -Destination "C:\Path\To\Your\D365FO\Workspace\" -Recurse
   ```
   
   The `.github/copilot-instructions.md` file ensures GitHub Copilot **always uses MCP tools before generating D365FO code**.
   
   ⚠️ **Without this file**, Copilot may use built-in code generation instead of querying your D365FO metadata, resulting in incorrect or outdated code.

5. **Restart Visual Studio** to apply changes

6. **Open Copilot Chat** in Agent Mode and verify tools are loaded

### Usage in Visual Studio

Once configured, simply ask GitHub Copilot natural language questions:

```
💬 "Show me all methods on the InventTable class"

💬 "What fields does CustTable have?"

💬 "Generate a batch job class for processing sales orders"

💬 "Find all custom extensions in my ISV module"
```

GitHub Copilot will automatically invoke the appropriate MCP tools and provide accurate, context-aware responses based on your D365 F&O metadata.

### Supported Workflows

| Workflow | How It Helps |
|----------|--------------|
| **Code Navigation** | Instantly find classes, methods, and tables without AOT browsing |
| **Code Completion** | Get accurate method signatures and field names |
| **Code Generation** | Generate boilerplate X++ code following best practices |
| **Code Review** | Analyze existing code with full metadata context |
| **Learning** | Explore unfamiliar modules with natural language queries |

---

## ⚙️ Configuration

Create a `.env` file in the project root:

```env
# Server
PORT=8080
NODE_ENV=production

# Database
DB_PATH=./data/xpp-metadata.db

# Metadata Source
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory

# Custom Extensions (ISV scenarios)
CUSTOM_MODELS=ISV_Module1,ISV_Module2
EXTENSION_PREFIX=ISV_

# Azure Blob Storage (cloud deployment)
AZURE_STORAGE_CONNECTION_STRING=your_connection_string
BLOB_CONTAINER_NAME=xpp-metadata

# Redis Cache (optional)
REDIS_ENABLED=false
REDIS_URL=redis://localhost:6379

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Layer                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Visual Studio 2022 + GitHub Copilot (MCP Client)             │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    Streamable HTTP + OAuth 2.0
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Azure Cloud                                 │
│  ┌─────────────────────────┐    ┌─────────────────────────────┐    │
│  │  Azure App Service      │    │  Azure Blob Storage          │    │
│  │  (Linux P0v3)           │◄───│  (xpp-metadata.db)           │    │
│  │  Node.js 22 LTS         │    │  ~2 GB                       │    │
│  └─────────────────────────┘    └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       MCP Server Components                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ HTTP         │  │ MCP Protocol │  │ Tool         │              │
│  │ Transport    │─▶│ Handler      │─▶│ Handlers     │              │
│  │ + Rate Limit │  │ JSON-RPC 2.0 │  │ (6 tools)    │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                              │                      │
│                    ┌─────────────────────────┼──────────────────┐   │
│                    │                         ▼                  │   │
│                    │  ┌──────────────┐  ┌──────────────┐        │   │
│                    │  │ SQLite + FTS5│  │ Redis Cache  │        │   │
│                    │  │ (584K symbols│  │ (Optional)   │        │   │
│                    │  └──────────────┘  └──────────────┘        │   │
│                    └────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

For detailed architecture diagrams with Mermaid visualizations, see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [**SETUP.md**](docs/SETUP.md) | Complete setup guide for local and Azure deployment |
| [**USAGE_EXAMPLES.md**](docs/USAGE_EXAMPLES.md) | Practical examples and use cases |
| [**ARCHITECTURE.md**](docs/ARCHITECTURE.md) | System architecture and design |
| [**PIPELINES.md**](docs/PIPELINES.md) | Azure DevOps pipeline automation |
| [**CUSTOM_EXTENSIONS.md**](docs/CUSTOM_EXTENSIONS.md) | ISV and custom extension development |
| [**TESTING.md**](docs/TESTING.md) | Testing guide and best practices |

---

## 🧪 Testing

```bash
# Run tests in watch mode
npm test

# Run tests once (CI mode)
npm test -- --run

# Run with coverage
npm test -- --coverage
```

---

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests to the `develop` branch.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built with ❤️ for the D365 F&O Community**

[Report Bug](https://github.com/dynamics365ninja/d365fo-mcp-server/issues) •
[Request Feature](https://github.com/dynamics365ninja/d365fo-mcp-server/issues) •
[Documentation](docs/)

</div>

### Rate Limiting

Built-in rate limiting protects the API from abuse:

- **General API**: 100 requests per 15 minutes (configurable)
- **Strict Endpoints**: 20 requests per 15 minutes for expensive operations
- **Authentication**: 5 attempts per 15 minutes

Rate limits can be customized via environment variables:
```bash
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_STRICT_MAX_REQUESTS=20
RATE_LIMIT_AUTH_MAX_REQUESTS=5
```

**Response Headers:**
- `RateLimit-Limit`: Maximum requests allowed
- `RateLimit-Remaining`: Requests remaining in current window
- `RateLimit-Reset`: When the current window resets
- `Retry-After`: Seconds to wait when rate limited (429 status)

### Memory Optimization

The server includes intelligent memory management for large D365FO metadata sets:

**Search Suggestions (Optional Feature):**
```bash
# Enable intelligent "Did you mean?" suggestions (requires more memory)
ENABLE_SEARCH_SUGGESTIONS=true

# Disable suggestions in production/CI environments to reduce memory usage
ENABLE_SEARCH_SUGGESTIONS=false  # Default in production
```

**Memory-Efficient Design:**
- ✅ **Iterator-based queries** - Processes large result sets without loading all into memory
- ✅ **Lazy initialization** - Term relationship graph builds asynchronously when enabled
- ✅ **Limited analysis sets** - Analyzes 2,000-5,000 symbols instead of full database
- ✅ **Graceful degradation** - Falls back to basic tips if suggestions unavailable

**Recommendations by Environment:**

| Environment | ENABLE_SEARCH_SUGGESTIONS | Notes |
|-------------|---------------------------|-------|
| **Development** | `true` (default) | Full features including AI suggestions |
| **Azure Pipeline** | `false` or omit | Minimize memory footprint during CI/CD |
| **Production** | `false` or `true`* | *Enable only if >2GB RAM available |
| **Docker Container** | `false` recommended | Use smaller memory limits |

**Memory Usage:**
- **Suggestions disabled**: ~200-500 MB heap
- **Suggestions enabled**: ~800MB-1.5GB heap (depends on symbol count)

**⚠️ If you encounter "JavaScript heap out of memory" errors:**
1. Set `ENABLE_SEARCH_SUGGESTIONS=false` in your environment
2. Or increase Node.js heap: `NODE_OPTIONS="--max-old-space-size=2048"` (2GB)
3. Or reduce symbol analysis limits in `symbolIndex.ts`

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Extract metadata
npm run extract-metadata

# Build database
npm run build-database
```

## Cost Estimate (Azure)

| Resource | Configuration | Monthly Cost |
|----------|---------------|--------------|
| App Service P0v3 | 1 vCPU, 4 GB RAM, Always-On | ~$62 |
| Blob Storage | 2 GB Hot LRS | ~$3 |
| Azure Cache for Redis | Basic C0 (optional) | ~$16 |
| Application Insights | Basic monitoring | ~$0-5 |
| **Total (without Redis)** | | **~$65-70/month** |
| **Total (with Redis)** | | **~$81-86/month** |

### Redis Setup (Optional)

For production deployments with Redis:

```bash
# Create Azure Cache for Redis
az redis create \
  --name your-cache-name \
  --resource-group your-rg \
  --location eastus \
  --sku Basic \
  --vm-size c0

# Get connection string
az redis list-keys --name your-cache-name --resource-group your-rg
```

Update your `.env`:
```env
REDIS_ENABLED=true
REDIS_URL=redis://:your-key@your-cache-name.redis.cache.windows.net:6380?ssl=true
```

## License

MIT - See [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support & Community

- **GitHub Repository**: [dynamics365ninja/d365fo-mcp-server](https://github.com/dynamics365ninja/d365fo-mcp-server)
- **Report Issues**: [GitHub Issues](https://github.com/dynamics365ninja/d365fo-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/dynamics365ninja/d365fo-mcp-server/discussions)
- **CI/CD Status**: [GitHub Actions](https://github.com/dynamics365ninja/d365fo-mcp-server/actions)

## Related Documentation

- [docs/ORCHESTRATOR_SETUP.md](docs/ORCHESTRATOR_SETUP.md) - **How to configure AI orchestrators to use X++ MCP tools**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture diagrams and detailed explanations
- [docs/TESTING.md](docs/TESTING.md) - Testing guide and coverage information
- [docs/USAGE_EXAMPLES.md](docs/USAGE_EXAMPLES.md) - Practical usage examples and scenarios
- [docs/AZURE_PIPELINE_AUTOMATION.md](docs/AZURE_PIPELINE_AUTOMATION.md) - Azure DevOps pipeline automation for metadata extraction
- [docs/STANDARD_METADATA_NUGET.md](docs/STANDARD_METADATA_NUGET.md) - Standard metadata extraction from NuGet packages
- [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) - GitHub repository setup guide
- [docs/CUSTOM_EXTENSIONS.md](docs/CUSTOM_EXTENSIONS.md) - ISV extension configuration
- [docs/DEVELOPMENT_SETUP.md](docs/DEVELOPMENT_SETUP.md) - Development environment setup
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) - Project implementation status
- [docs/IMPLEMENTATION_SUMMARY.md](docs/IMPLEMENTATION_SUMMARY.md) - Feature summary
