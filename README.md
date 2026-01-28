# X++ MCP Code Completion Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Build Status](https://github.com/dynamics365ninja/d365fo-mcp-server/workflows/CI/badge.svg)](https://github.com/dynamics365ninja/d365fo-mcp-server/actions)
[![Azure](https://img.shields.io/badge/Azure-Ready-0078D4.svg)](https://azure.microsoft.com/)
[![MCP](https://img.shields.io/badge/MCP-1.0-orange.svg)](https://modelcontextprotocol.io/)

A Model Context Protocol (MCP) server for X++ code completion in Microsoft Dynamics 365 Finance and Operations development.

## Features

- 🔍 **Symbol Search**: Fast full-text search across X++ classes, tables, methods, and fields
- 🎯 **Extension Search**: Search only in custom extensions/ISV models
- 📚 **Class Information**: Get detailed class metadata including methods, inheritance, and implementations
- 📊 **Table Information**: Access table schemas, fields, indexes, and relations
- ✨ **Code Completion**: Method and field completions for classes and tables
- 🎯 **Code Generation**: Templates for common X++ patterns (classes, batch jobs, form handlers, etc.)
- 💾 **Redis Caching**: Optional Redis integration for improved performance
- 🚦 **Rate Limiting**: Built-in protection against API abuse
- 🔐 **Azure Integration**: Built-in Azure Blob Storage support for metadata caching
- 🚀 **GitHub Copilot**: Integrates with Visual Studio 2022 via GitHub Copilot Agent Mode

## Architecture

For a comprehensive visual overview of the system architecture, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
Visual Studio 2022 (GitHub Copilot) 
    ↓ Streamable HTTP + OAuth
Azure App Service (Linux P0v3)
    ↓ MCP Protocol
X++ MCP Server (TypeScript)
    ↓ SQLite + FTS5
X++ Metadata Database (~500MB)
    ↑ Download on startup
Azure Blob Storage
```

## Prerequisites

- Node.js 22 LTS or later
- TypeScript 5.0+
- Access to D365 F&O PackagesLocalDirectory (for metadata extraction)
- Azure Storage account (for cloud deployment)

## Key Dependencies

- **dotenv**: Loads environment variables from .env file
- **xml2js**: Parses D365 AOT XML files
- **better-sqlite3**: SQLite database with FTS5 full-text search
- **@modelcontextprotocol/sdk**: MCP protocol implementation
- **express**: HTTP server for streamable transport

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Extract metadata from D365FO
npm run extract-metadata

# 3. Build database
npm run build-database

# 4. Start server
npm run dev
```

For detailed setup instructions, see [docs/SETUP.md](docs/SETUP.md).

## Documentation

- **[SETUP.md](docs/SETUP.md)** - Complete setup guide for local and Azure deployment
- **[PIPELINES.md](docs/PIPELINES.md)** - Azure DevOps pipeline automation guide
- **[USAGE_EXAMPLES.md](docs/USAGE_EXAMPLES.md)** - Practical examples and use cases
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - System architecture and design
- **[PERFORMANCE.md](docs/PERFORMANCE.md)** - Performance optimization tips
- **[CUSTOM_EXTENSIONS.md](docs/CUSTOM_EXTENSIONS.md)** - Custom extension development
- **[TESTING.md](docs/TESTING.md)** - Testing guide

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file:

```env
# Server configuration
PORT=8080

# Database path
DB_PATH=/tmp/xpp-metadata.db

# Redis Cache (optional - improves performance)
REDIS_ENABLED=false
REDIS_URL=redis://localhost:6379
CACHE_TTL=3600  # Cache TTL in seconds

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100  # Max requests per window
RATE_LIMIT_STRICT_MAX_REQUESTS=20  # Strict limit
RATE_LIMIT_AUTH_MAX_REQUESTS=5  # Auth attempts

# Azure Blob Storage (optional)
AZURE_STORAGE_CONNECTION_STRING=your_connection_string
BLOB_CONTAINER_NAME=xpp-metadata
BLOB_DATABASE_NAME=databases/xpp-metadata-latest.db

# Metadata extraction
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory

# Custom Extensions (optional - for ISV scenarios)
CUSTOM_MODELS=ISV_Module1,ISV_Module2
EXTENSION_PREFIX=ISV_
EXTRACT_MODE=all  # Options: 'all', 'standard', 'custom'
```

## Usage

### 1. Extract Metadata from D365 F&O

```bash
npm run extract-metadata
```

This extracts X++ metadata from your D365 F&O installation:
- Scans PackagesLocalDirectory (packages contain multiple models)
- Parses AxClass, AxTable, AxEnum XML files using xml2js
- Extracts methods with parameters (from source code), fields, relationships
- Can extract all models or filter to custom models only (see EXTRACT_MODE)

### 2. Build SQLite Database

```bash
npm run build-database
```

This creates the SQLite database with FTS5 indexes for fast search.

### 3. Start Server Locally

```bash
npm run dev
```

Server will be available at `http://localhost:8080/mcp`

### 4. Deploy to Azure (Optional)

See [docs/SETUP.md](docs/SETUP.md) for detailed deployment instructions and [docs/PIPELINES.md](docs/PIPELINES.md) for automated CI/CD setup.

**Quick Deploy:**
```bash
# Push to GitHub to trigger CI/CD
git push origin main

# Or deploy manually with Azure CLI
az webapp up --name your-app-name --resource-group your-rg --runtime "NODE:22-lts"
```

## Testing

The project has comprehensive test coverage using Vitest:

```bash
# Run tests in watch mode
npm test

# Run tests once (CI mode)
npm test -- --run

# Run tests with coverage
npm test -- --coverage
```

### Test Suite

- **Unit Tests**: Individual tool functions (search, classInfo, tableInfo)
- **Integration Tests**: MCP protocol flow and HTTP transport
- **Database Tests**: Symbol indexing and full-text search

For detailed information, see [docs/TESTING.md](docs/TESTING.md).

## CI/CD

The project includes automated workflows:

- **CI Workflow** ([.github/workflows/ci.yml](.github/workflows/ci.yml))
  - Runs on every push/PR to `main` or `develop`
  - Tests on Node.js 20.x and 22.x
  - Runs linting, building, and security audits
  - Status: [![Build Status](https://github.com/dynamics365ninja/d365fo-mcp-server/workflows/CI/badge.svg)](https://github.com/dynamics365ninja/d365fo-mcp-server/actions)

- **Deploy Workflow** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml))
  - Deploys to Azure App Service
  - Supports production and staging environments
  - Automatic on push to `main` or manual trigger

- **Release Workflow** ([.github/workflows/release.yml](.github/workflows/release.yml))
  - Creates GitHub releases on version tags
  - Generates changelog automatically
  - Builds release artifacts

- **Dependabot** ([.github/dependabot.yml](.github/dependabot.yml))
  - Weekly dependency updates
  - Grouped updates for production and dev dependencies

## MCP Tools

The server provides these MCP tools:

### `xpp_search`

Search for X++ symbols by name or keyword.

**Arguments:**
- `query` (string): Search query
- `limit` (number, optional): Maximum results (default: 20)

**Example:**
```json
{
  "name": "xpp_search",
  "arguments": {
    "query": "CustTable",
    "limit": 10
  }
}
```

### `xpp_search_extensions`

Search for symbols only in custom extensions/ISV models. Results are grouped by model for better readability.

**Arguments:**
- `query` (string): Search query
- `prefix` (string, optional): Extension prefix filter (e.g., "ISV_", "Custom_")
- `limit` (number, optional): Maximum results (default: 20)

**Example:**
```json
{
  "name": "xpp_search_extensions",
  "arguments": {
    "query": "Custom",
    "prefix": "ISV_",
    "limit": 20
  }
}
```

### `xpp_get_class`

Get detailed information about an X++ class.

**Arguments:**
- `className` (string): Name of the class

**Example:**
```json
{
  "name": "xpp_get_class",
  "arguments": {
    "className": "SalesOrderProcessor"
  }
}
```

### `xpp_get_table`

Get detailed information about an X++ table.

**Arguments:**
- `tableName` (string): Name of the table

### `xpp_complete_method`

Get method/field completions for a class or table.

**Arguments:**
- `objectName` (string): Class or table name
- `prefix` (string, optional): Filter by prefix

### `xpp_generate_code`

Generate X++ code templates.

**Arguments:**
- `pattern` (string): Template type (class, runnable, form-handler, data-entity, batch-job)
- `name` (string): Name for the generated element

## GitHub Copilot Integration

### Prerequisites

⚠️ **Important**: To use custom MCP servers with GitHub Copilot, you must enable **"Editor preview features"** in your GitHub account settings:

👉 https://github.com/settings/copilot/features

Without this feature enabled, MCP tools will not be loaded in GitHub Copilot.

For more information about GitHub Copilot policies and feature management, see:
📖 [Managing Policies for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-policies#about-policies-for-github-copilot)

### Visual Studio 2022 Setup

1. Install Visual Studio 2022 version 17.14+
2. Install GitHub Copilot extension
3. **Enable MCP integration**: Go to **Tools** → **Options** → **GitHub** → **Copilot** and enable **"Enable MCP server integration in agent mode"**
4. Create `.mcp.json` in your solution root:

```json
{
  "servers": {
    "xpp-completion": {
      "url": "https://your-app.azurewebsites.net/mcp/",
      "description": "X++ Code Completion Server for D365 F&O"
    }
  }
}
```

5. Restart Visual Studio to apply changes
6. Open Copilot Chat in Agent Mode
7. Verify that X++ MCP tools are loaded and available

## Project Structure

```
d365fo-mcp-server/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── cache/
│   │   └── redisCache.ts        # Redis caching service
│   ├── database/
│   │   └── download.ts          # Azure Blob integration
│   ├── metadata/
│   │   ├── symbolIndex.ts       # SQLite FTS5 indexing
│   │   ├── types.ts             # Type definitions
│   │   └── xmlParser.ts         # X++ XML parser
│   ├── middleware/
│   │   └── rateLimiter.ts       # API rate limiting
│   ├── prompts/
│   │   ├── codeReview.ts        # Code review prompt
│   │   ├── index.ts             # Prompt exports
│   │   └── xppPrompts.ts        # X++ prompts
│   ├── resources/
│   │   └── classResource.ts     # Class resource provider
│   ├── server/
│   │   ├── mcpServer.ts         # MCP server configuration
│   │   └── transport.ts         # HTTP transport layer
│   ├── tools/
│   │   ├── classInfo.ts         # Class information
│   │   ├── codeGen.ts           # Code generation
│   │   ├── completion.ts        # Method completion
│   │   ├── extensionSearch.ts   # Custom extension search
│   │   ├── index.ts             # Tool exports
│   │   ├── search.ts            # Symbol search
│   │   ├── tableInfo.ts         # Table information
│   │   ├── toolHandler.ts       # Central tool handler
│   │   └── xppTools.ts          # X++ tools
│   └── types/
│       └── context.ts           # Server context
├── scripts/
│   ├── build-database.ts        # Database builder
│   ├── extract-metadata.ts      # Metadata extraction
│   └── test-mcp.ps1             # PowerShell test script
├── config/
│   └── standard-models.json     # Standard D365 models
├── docs/
│   ├── AZURE_TROUBLESHOOTING.md
│   ├── CUSTOM_EXTENSIONS.md
│   ├── DEVELOPMENT_SETUP.md
│   ├── GITHUB_SETUP.md
│   ├── IMPLEMENTATION_STATUS.md
│   ├── IMPLEMENTATION_SUMMARY.md
│   ├── PERFORMANCE.md
│   └── VISUAL_STUDIO_MCP_SETUP.md
├── infrastructure/
│   └── main.bicep               # Azure IaC
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
└── startup.sh
```

## Performance Features

### Redis Caching

The server supports optional Redis caching to improve response times for frequently accessed data:

```bash
# Enable Redis
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
CACHE_TTL=3600  # 1 hour cache
```

**Cached Operations:**
- Symbol searches (both standard and extension)
- Class information lookups
- Table schema queries
- Code completions

**Cache Key Patterns:**
- `xpp:search:{query}:{limit}` - Standard search results
- `xpp:ext:{query}:{prefix}:{limit}` - Extension search results
- `xpp:class:{className}` - Class metadata
- `xpp:table:{tableName}` - Table metadata

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
├── infrastructure/
│   └── main.bicep               # Azure IaC
└── package.json
```

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
| Blob Storage | 500 MB Hot LRS | ~$1 |
| Azure Cache for Redis | Basic C0 (optional) | ~$16 |
| Application Insights | Basic monitoring | ~$0-5 |
| **Total (without Redis)** | | **~$63-68/month** |
| **Total (with Redis)** | | **~$79-84/month** |

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

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture diagrams and detailed explanations
- [docs/TESTING.md](docs/TESTING.md) - Testing guide and coverage information
- [docs/USAGE_EXAMPLES.md](docs/USAGE_EXAMPLES.md) - Practical usage examples and scenarios
- [docs/AZURE_PIPELINE_AUTOMATION.md](docs/AZURE_PIPELINE_AUTOMATION.md) - Azure DevOps pipeline automation for metadata extraction
- [docs/STANDARD_METADATA_NUGET.md](docs/STANDARD_METADATA_NUGET.md) - Standard metadata extraction from NuGet packages
- [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) - GitHub repository setup guide
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) - Performance optimization guide
- [docs/CUSTOM_EXTENSIONS.md](docs/CUSTOM_EXTENSIONS.md) - ISV extension configuration
- [docs/DEVELOPMENT_SETUP.md](docs/DEVELOPMENT_SETUP.md) - Development environment setup
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) - Project implementation status
- [docs/IMPLEMENTATION_SUMMARY.md](docs/IMPLEMENTATION_SUMMARY.md) - Feature summary
