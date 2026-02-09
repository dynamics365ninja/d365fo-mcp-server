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
- **Node.js** 22.x LTS
- **TypeScript** 5.7+
- **Git** for version control
- **Azure CLI** (for deployment)
- **PowerShell** 7+ (for scripts)

### Azure Resources
- **Azure Blob Storage** account
- **Azure App Service** (P0v3 or higher recommended)
- **Azure Cache for Redis** (optional, for performance)

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
  --sku P0v3 \
  --is-linux

az webapp create \
  --name xpp-mcp-server \
  --plan xpp-mcp-plan \
  --resource-group your-rg \
  --runtime "NODE:22-lts"
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
# Build and deploy
npm run build
az webapp deployment source config-zip \
  --resource-group your-rg \
  --name xpp-mcp-server \
  --src dist.zip
```

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

Four pipelines are available in `.azure-pipelines/`:

#### **d365fo-mcp-data.yml** - Full Custom Metadata Extraction
- Triggered on changes to source code
- Downloads standard metadata from blob
- Extracts custom models from Git
- Builds database and uploads to blob
- Restarts App Service

#### **d365fo-mcp-data-quick.yml** - Updates on Changes
- Triggered on changes to src/** or pipeline file in main branch
- Quick custom metadata updates (~5-15 min)
- Parameters for custom execution

#### **d365fo-mcp-data-standard-extract.yml** - Standard Metadata Extraction
- Manual execution only
- Downloads standard packages from NuGet
- Extracts and uploads to blob
- Requires Windows agent

#### **d365fo-mcp-data-platform-upgrade.yml** - Complete Platform Upgrade
- Manual execution only
- Single unified stage on Windows
- Downloads NuGet → Extracts standard → Extracts custom → Builds database → Uploads all
- No intermediate blob operations (faster)
- Execution time: ~1.5-2 hours
- Use after D365 version updates

### 4. NuGet Configuration (for Standard Extraction)

Create files in `nuget-config/` folder:

**latest.csproj:**
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net48</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Dynamics.AX.Application.DevALM.BuildXpp" Version="10.0.*" />
    <PackageReference Include="Microsoft.Dynamics.AX.ApplicationSuite.DevALM.BuildXpp" Version="10.0.*" />
    <PackageReference Include="Microsoft.Dynamics.AX.Platform.DevALM.BuildXpp" Version="7.0.*" />
    <PackageReference Include="Microsoft.Dynamics.AX.Platform.CompilerPackage" Version="7.0.*" />
  </ItemGroup>
</Project>
```

**nuget.config:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="dynamics365-operations" value="https://pkgs.dev.azure.com/mseng/Dynamics365/_packaging/dynamics365-operations/nuget/v3/index.json" />
  </packageSources>
</configuration>
```

---

## Visual Studio 2022 Setup

### 1. Prerequisites

- **Visual Studio 2022** version 17.14 or later
- **GitHub Copilot** extension installed
- GitHub account with Copilot subscription
- **Enable Editor preview features** at https://github.com/settings/copilot/features

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
5. Verify X++ MCP tools are loaded (you should see search, get_class_info, get_table_info, code_completion, generate_code, search_extensions, analyze_code_patterns, suggest_method_implementation, analyze_class_completeness, get_api_usage_patterns)

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

**Issue:** Slow response times

**Solutions:**
1. Enable Redis caching
2. Scale up App Service plan (P1v3 or higher)
3. Enable Application Insights for monitoring
4. Check database size (should be ~500MB)

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
- Check [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- See [PIPELINES.md](PIPELINES.md) for automation details

---

## Support

For issues and questions:
- GitHub Issues: https://github.com/dynamics365ninja/d365fo-mcp-server/issues
- Documentation: https://github.com/dynamics365ninja/d365fo-mcp-server/tree/main/docs
