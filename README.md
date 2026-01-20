# X++ MCP Code Completion Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
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

- Node.js 20 LTS or later
- TypeScript 5.0+
- Access to D365 F&O PackagesLocalDirectory (for metadata extraction)
- Azure Storage account (for cloud deployment)

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

This extracts X++ metadata from your D365 F&O installation.

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

See [GITHUB_SETUP.md](GITHUB_SETUP.md) for detailed deployment instructions.

**Quick Deploy:**
```bash
# Push to GitHub to trigger CI/CD
git push origin main

# Or deploy manually with Azure CLI
az webapp up --name your-app-name --resource-group your-rg --runtime "NODE:20-lts"
```

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

### Visual Studio 2022 Setup

1. Install Visual Studio 2022 version 17.14+
2. Install GitHub Copilot extension
3. Create `.mcp.json` in your solution root:

```json
{
  "servers": {
    "xpp-completion": {
      "type": "http",
      "url": "https://your-app.azurewebsites.net/mcp/"
    }
  }
}
```

4. Open Copilot Chat in Agent Mode
5. Enable the X++ completion tools

## Project Structure

```
d365fo-mcp-server/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── server/
│   │   ├── mcpServer.ts         # MCP server configuration
│   │   └── transport.ts         # HTTP transport layer
│   ├── tools/                   # MCP tools implementation
│   │   ├── search.ts            # Standard symbol search
│   │   ├── extensionSearch.ts   # Custom extension search
│   │   ├── classInfo.ts         # Class information
│   │   ├── tableInfo.ts         # Table information
│   │   ├── completion.ts        # Code completion
│   │   └── codeGen.ts           # Code generation
│   ├── metadata/                # X++ parsing and indexing
│   ├── cache/                   # Redis caching layer
│   │   └── redisCache.ts        # Cache service
│   ├── middleware/              # Express middleware
│   │   └── rateLimiter.ts       # Rate limiting
│   ├── prompts/                 # MCP prompts
│   └── database/                # Azure Blob integration
├── scripts/
│   ├── extract-metadata.ts      # Metadata extraction
│   └── build-database.ts        # Database builder
├── infrastructure/
│   └── main.bicep               # Azure IaC
└── package.json
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

- [GITHUB_SETUP.md](GITHUB_SETUP.md) - GitHub repository setup guide
- [PERFORMANCE.md](PERFORMANCE.md) - Performance optimization guide
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) - ISV extension configuration
- [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) - Project implementation status
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) - Feature summary
