# D365FO MCP Server - Setup Guide

Complete guide for setting up and deploying the X++ MCP (Model Context Protocol) server for Dynamics 365 Finance & Operations.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development Setup](#local-development-setup)
- [Azure Deployment](#azure-deployment)
- [Azure DevOps Configuration](#azure-devops-configuration)
- [Visual Studio Setup](#visual-studio-setup)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software
- **Node.js** 22.x or higher (LTS recommended)
- **TypeScript** 5.7+
- **Git** for version control
- **Azure CLI** (for deployment)
- **PowerShell** 7+ (optional, for Windows scripts)

### Azure Resources
- **Azure Blob Storage** account for storing metadata and database
- **Azure App Service** (B1 or higher recommended, P0v3+ for production)
- **Azure Cache for Redis** (optional, improves performance significantly)

### D365FO Access
- Access to D365FO PackagesLocalDirectory or metadata packages
- Development environment or metadata export

---

## Local Development Setup

### 1. Clone Repository

```bash
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git
cd d365fo-mcp-server
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create `.env` file in project root:

```env
# Metadata Configuration
PACKAGES_PATH=C:/AOSService/PackagesLocalDirectory
METADATA_PATH=./extracted-metadata
DB_PATH=./data/xpp-metadata.db

# Custom Models (comma-separated)
CUSTOM_MODELS=YourCustomModel1,YourCustomModel2
EXTENSION_PREFIX=YourCompany

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
BLOB_CONTAINER_NAME=xpp-metadata

# Redis (optional)
REDIS_URL=redis://localhost:6379
REDIS_ENABLED=false

# Server Configuration
PORT=8080
NODE_ENV=development
```

### 4. Extract Metadata

Extract metadata from your D365FO environment:

```bash
# Extract only custom models (fast)
npm run extract-metadata

# Or extract all models
EXTRACT_MODE=all npm run extract-metadata
```

### 5. Build Database

Build SQLite database with FTS5 full-text search:

```bash
npm run build-database
```

### 6. Start Server

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm start
```

Server runs on `http://localhost:8080` with health check at `/health`.

> **Note:** The default port is 8080. You can override this with the `PORT` environment variable in `.env`.

---

## Azure Deployment

### 1. Create Azure Resources

#### Storage Account

```bash
az storage account create \
  --name yourstorageaccount \
  --resource-group your-rg \
  --location westeurope \
  --sku Standard_LRS

az storage container create \
  --name xpp-metadata \
  --account-name yourstorageaccount
```

#### App Service

```bash
az appservice plan create \
  --name xpp-mcp-plan \
  --resource-group your-rg \
  --sku B1 \
  --is-linux

az webapp create \
  --name xpp-mcp-server \
  --plan xpp-mcp-plan \
  --resource-group your-rg \
  --runtime "NODE:22-lts"
```

For production environments, use P0v3 or higher SKU:
```bash
az appservice plan create \
  --name xpp-mcp-plan-prod \
  --resource-group your-rg \
  --sku P0v3 \
  --is-linux
```

#### Redis Cache (Optional)

```bash
az redis create \
  --name xpp-mcp-redis \
  --resource-group your-rg \
  --location westeurope \
  --sku Basic \
  --vm-size c0
```

### 2. Configure App Service

Set environment variables:

```bash
az webapp config appsettings set \
  --name xpp-mcp-server \
  --resource-group your-rg \
  --settings \
    AZURE_STORAGE_CONNECTION_STRING="..." \
    BLOB_CONTAINER_NAME="xpp-metadata" \
    DB_PATH="./data/xpp-metadata.db" \
    REDIS_URL="redis://..." \
    NODE_ENV="production"
```

### 3. Deploy Application

```bash
# Build the application
npm run build

# Create deployment package
cd dist
zip -r ../deploy.zip .
cd ..

# Deploy to Azure
az webapp deployment source config-zip \
  --resource-group your-rg \
  --name xpp-mcp-server \
  --src deploy.zip
```

Alternatively, use Azure DevOps pipelines for automated deployment (see [PIPELINES.md](PIPELINES.md)).

### 4. Verify Deployment

```bash
curl https://xpp-mcp-server.azurewebsites.net/health
```

---

## Azure DevOps Configuration

### 1. Create Variable Group

In Azure DevOps, create variable group `xpp-mcp-server-config`:

| Variable | Value | Secret |
|----------|-------|--------|
| `AZURE_STORAGE_CONNECTION_STRING` | Your storage connection string | ✅ Yes |
| `BLOB_CONTAINER_NAME` | `xpp-metadata` | No |
| `CUSTOM_MODELS` | Your custom models (comma-separated) | No |
| `AZURE_SUBSCRIPTION` | Azure service connection name | No |
| `AZURE_APP_SERVICE_NAME` | Your App Service name | No |
| `EXTENSION_PREFIX` | Your company prefix | No |

### 2. Setup Service Connection

1. Go to **Project Settings** → **Service connections**
2. Create **Azure Resource Manager** connection
3. Name it (e.g., `Azure-Production`)
4. Use this name in `AZURE_SUBSCRIPTION` variable

### 3. Configure Pipelines

Three pipelines are available in `.azure-pipelines/`:

#### **d365fo-mcp-data-build-custom.yml** - Custom Metadata Extraction
- Triggers automatically on changes to `dev` branch (src/** or pipeline file)
- Downloads standard metadata from Azure Blob Storage
- Extracts custom models from Git repository
- Builds database and uploads to blob
- Restarts App Service to apply changes
- Quick updates (~5-15 min)
- Supports manual trigger with parameters (extraction mode, custom models)

#### **d365fo-mcp-data-build-standard.yml** - Standard Metadata Extraction
- Manual execution only
- Downloads PackagesLocalDirectory.zip from Azure Blob Storage
- Extracts standard D365FO models
- Uploads extracted metadata to blob
- Run after D365 version upgrades or hotfixes (few times per year)
- Execution time: ~30-45 min

#### **d365fo-mcp-data-platform-upgrade.yml** - Complete Platform Upgrade
- Manual execution only
- Single unified stage for complete metadata refresh
- Downloads PackagesLocalDirectory.zip → Extracts standard → Extracts custom → Builds database → Uploads all
- No intermediate blob operations (faster, more efficient)
- Execution time: ~1.5-2 hours
- Use after major D365 version updates or platform upgrades

### 4. Upload Standard Packages to Azure Blob

Before running the pipelines, you need to upload `PackagesLocalDirectory.zip` to Azure Blob Storage:

**Option 1: From D365FO Development VM**
```bash
# Compress PackagesLocalDirectory folder
Compress-Archive -Path "C:\AOSService\PackagesLocalDirectory" -DestinationPath "PackagesLocalDirectory.zip"

# Upload to Azure Blob Storage using Azure CLI
az storage blob upload \
  --connection-string "$AZURE_STORAGE_CONNECTION_STRING" \
  --container-name packages \
  --name PackagesLocalDirectory.zip \
  --file PackagesLocalDirectory.zip \
  --overwrite
```

**Option 2: Download from LCS**
1. Download Deployable Package from LCS (Lifecycle Services)
2. Extract the package to get standard models
3. Compress as `PackagesLocalDirectory.zip`
4. Upload to Azure Blob Storage container named `packages`

**Container Structure:**
```
Azure Blob Storage
└── packages (container)
    └── PackagesLocalDirectory.zip  (standard D365FO models)
└── xpp-metadata (container)
    └── metadata files (extracted by pipelines)
    └── xpp-metadata.db (built by pipelines)
```

---

## Visual Studio 2022 Setup

### 1. Prerequisites

- **Visual Studio 2022** version 17.14 or later (with MCP support)
- **GitHub Copilot** extension installed
- GitHub account with Copilot subscription (required for agent mode)
- **Enable Editor preview features** at https://github.com/settings/copilot/features

> **Note:** MCP integration in Visual Studio 2022 requires version 17.14 or newer. Earlier versions do not support MCP servers.

### 2. Enable MCP Integration

1. Open Visual Studio 2022
2. Go to **Tools** → **Options**
3. Navigate to **GitHub** → **Copilot**
4. Enable **"Enable MCP server integration in agent mode"**
5. Click **OK** to save

### 3. Configure MCP Server

Create `.mcp.json` file in your D365FO solution root directory:

```json
{
  "servers": {
    "xpp-completion": {
      "url": "https://your-app-name.azurewebsites.net/mcp/",
      "description": "X++ Code Completion Server for D365 F&O"
    }
  }
}
```

**For local development:**
```json
{
  "servers": {
    "xpp-completion": {
      "url": "http://localhost:8080/mcp/",
      "description": "X++ Code Completion Server (Local)"
    }
  }
}
```

### 4. Using MCP in GitHub Copilot

1. Restart Visual Studio 2022 to apply changes
2. Open your D365FO solution
3. Open **Copilot Chat** window (View → GitHub Copilot Chat)
4. Switch to **Agent Mode** in Copilot Chat
5. Verify X++ MCP tools are loaded - you should see these 11 tools:
   - `search` - Search X++ symbols
   - `batch_search` - Parallel batch search
   - `search_extensions` - Search custom extensions only
   - `get_class_info` - Get class structure and methods
   - `get_table_info` - Get table fields and relations
   - `code_completion` - Discover methods and fields
   - `generate_code` - Generate X++ code templates
   - `analyze_code_patterns` - Analyze code patterns
   - `suggest_method_implementation` - Get method implementation suggestions
   - `analyze_class_completeness` - Check for missing methods
   - `get_api_usage_patterns` - Get API usage examples

### 5. Example Prompts

After configuration, you can use natural language prompts in Copilot Chat:

```
Find all classes that extend SalesFormLetter
Show me table structure for CustTable
Generate X++ code for creating a sales order
Review this X++ method for best practices
Search for custom extensions with prefix ISV_
```

See [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) for more examples.

---

## Troubleshooting

### Database Build Fails

**Issue:** Database build fails with FTS5 not available

**Solution:**
```bash
# Reinstall better-sqlite3 with native compilation
npm rebuild better-sqlite3
```

### Azure Blob Connection Issues

**Issue:** Cannot connect to Azure Blob Storage

**Solutions:**
1. Verify connection string format
2. Check firewall rules on storage account
3. Ensure container exists
4. Test with Azure Storage Explorer

### Metadata Extraction Issues

**Issue:** Extraction finds no models

**Solutions:**
1. Verify `PACKAGES_PATH` points to correct directory
2. Check that models contain XML files
3. Verify model names in `CUSTOM_MODELS` match folder names
4. Check file permissions

### App Service Performance

**Issue:** Slow response times or timeouts

**Solutions:**
1. Enable Redis caching (`REDIS_ENABLED=true`)
2. Scale up App Service plan (B2 for dev, P1v3+ for production)
3. Enable Application Insights for monitoring
4. Verify database size (typically ~1.5GB for standard + custom models)
5. Check if App Service has sufficient memory (minimum 1.75GB for B1, 3.5GB for P0v3)

### Pipeline Failures

**Issue:** Azure Pipeline fails

**Common Causes:**
1. Missing variable group
2. Invalid service connection
3. Insufficient agent permissions
4. NuGet authentication issues (for standard extraction)

**Debug Steps:**
1. Check pipeline logs for specific error
2. Verify all variables are set correctly
3. Test scripts locally
4. Validate Azure permissions

### Redis Connection Issues

**Issue:** Redis connection fails or times out

**Solutions:**
1. Verify Redis URL format: `redis://host:port`
2. Check Redis firewall rules
3. Set `REDIS_ENABLED=false` to disable if not needed
4. Verify Redis instance is running

---

## Next Steps

- Review [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) for practical examples
- Check [ARCHITECTURE.md](ARCHITECTURE.md) for system design details
- See [PIPELINES.md](PIPELINES.md) for pipeline automation details
- Read [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) for ISV configuration
- Explore [WORKSPACE_AWARE.md](WORKSPACE_AWARE.md) for workspace integration features

---

## Support

For issues and questions:
- GitHub Issues: https://github.com/dynamics365ninja/d365fo-mcp-server/issues
- Documentation: https://github.com/dynamics365ninja/d365fo-mcp-server/tree/main/docs
