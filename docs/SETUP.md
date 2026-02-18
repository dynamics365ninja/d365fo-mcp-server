# Setup Guide

Complete guide for installing and deploying the D365 F&O MCP Server.

## Table of Contents

- [What You Need](#what-you-need)
- [Local Setup (Windows VM)](#local-setup-windows-vm)
- [Azure Deployment](#azure-deployment)
- [Azure DevOps Pipelines](#azure-devops-pipelines)
- [Visual Studio 2022 Configuration](#visual-studio-2022-configuration)
- [Troubleshooting](#troubleshooting)

---

## What You Need

### Software
- **Node.js** 22.x or later (LTS recommended)
- **Git**
- **Azure CLI** (for Azure deployment only)

### Azure Resources (cloud deployment only)
- **Azure Blob Storage** — stores the metadata database (~2 GB)
- **Azure App Service** — B1 minimum, P0v3 recommended for production
- **Azure Cache for Redis** — optional, speeds up repeated queries

### D365FO Access
- A D365FO development environment with PackagesLocalDirectory, or
- A metadata export from your D365FO environment

---

## Local Setup (Windows VM)

### 1. Clone and Install

```powershell
git clone https://github.com/dynamics365ninja/d365fo-mcp-server.git
cd d365fo-mcp-server
npm install
```

### 2. Configure Environment

Copy the example configuration file and fill in your values:

```powershell
copy .env.example .env
```

Key settings in `.env`:

```env
# Path to your D365FO packages
PACKAGES_PATH=C:/AosService/PackagesLocalDirectory

# Your custom model names (comma-separated)
CUSTOM_MODELS=YourModel1,YourModel2
EXTENSION_PREFIX=YourCompanyPrefix

# Where to store the database
DB_PATH=./data/xpp-metadata.db

# Azure Blob Storage (only needed for cloud sync)
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
BLOB_CONTAINER_NAME=xpp-metadata

# Redis (optional — leave disabled for local use)
REDIS_ENABLED=false
```

### 3. Extract Metadata

Pull symbol information from your D365FO installation:

```powershell
# Extract only your custom models (fast, a few minutes)
npm run extract-metadata

# Or extract everything including standard Microsoft models
$env:EXTRACT_MODE="all"; npm run extract-metadata
```

### 4. Build the Database

Index all extracted symbols into the SQLite database:

```powershell
npm run build-database
```

This creates `data/xpp-metadata.db` (~2 GB for full extraction).

### 5. Start the Server

```powershell
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

The server runs at `http://localhost:8080`. Check `http://localhost:8080/health` to confirm it is up.

---

## Azure Deployment

### 1. Create Azure Resources

```bash
# Storage account (holds the metadata database)
az storage account create \
  --name yourstorageaccount \
  --resource-group your-rg \
  --location westeurope \
  --sku Standard_LRS

az storage container create \
  --name xpp-metadata \
  --account-name yourstorageaccount

# App Service plan
az appservice plan create \
  --name xpp-mcp-plan \
  --resource-group your-rg \
  --sku P0v3 \
  --is-linux

# Web app
az webapp create \
  --name xpp-mcp-server \
  --plan xpp-mcp-plan \
  --resource-group your-rg \
  --runtime "NODE:22-lts"
```

For a development/test server B1 SKU is sufficient. For production use P0v3 or higher.

### 2. Configure App Settings

```bash
az webapp config appsettings set \
  --name xpp-mcp-server \
  --resource-group your-rg \
  --settings \
    AZURE_STORAGE_CONNECTION_STRING="..." \
    BLOB_CONTAINER_NAME="xpp-metadata" \
    DB_PATH="./data/xpp-metadata.db" \
    NODE_ENV="production"
```

### 3. Deploy the Application

```bash
npm run build
Compress-Archive -Path dist/* -DestinationPath deploy.zip

az webapp deployment source config-zip \
  --resource-group your-rg \
  --name xpp-mcp-server \
  --src deploy.zip
```

### 4. Verify

```bash
curl https://xpp-mcp-server.azurewebsites.net/health
```

---

## Azure DevOps Pipelines

Three ready-to-use pipelines are in `.azure-pipelines/`:

| Pipeline | When to use | Duration |
|----------|-------------|----------|
| `d365fo-mcp-data-build-custom.yml` | After any change to your custom models | ~5–15 min |
| `d365fo-mcp-data-build-standard.yml` | After a D365FO version upgrade or hotfix | ~30–45 min |
| `d365fo-mcp-data-platform-upgrade.yml` | Full rebuild: standard + custom + database | ~1.5–2 h |

### Required Variable Group

Create a variable group named `xpp-mcp-server-config` in Azure DevOps with these variables:

| Variable | Secret | Example value |
|----------|--------|--------------|
| `AZURE_STORAGE_CONNECTION_STRING` | ✅ Yes | Connection string from Azure Portal |
| `BLOB_CONTAINER_NAME` | No | `xpp-metadata` |
| `CUSTOM_MODELS` | No | `AslCore,AslFinance` |
| `AZURE_SUBSCRIPTION` | No | Name of your Azure service connection |
| `AZURE_APP_SERVICE_NAME` | No | `xpp-mcp-server` |

### Uploading Standard Packages

Before running the standard or platform upgrade pipelines, upload `PackagesLocalDirectory.zip`
to your Blob Storage container named `packages`:

```powershell
# From your D365FO VM
Compress-Archive -Path "C:\AosService\PackagesLocalDirectory" -DestinationPath "PackagesLocalDirectory.zip"

az storage blob upload \
  --connection-string $env:AZURE_STORAGE_CONNECTION_STRING \
  --container-name packages \
  --name PackagesLocalDirectory.zip \
  --file PackagesLocalDirectory.zip \
  --overwrite
```

---

## Visual Studio 2022 Configuration

### Requirements

| Component | Minimum version |
|-----------|----------------|
| Visual Studio 2022 | 17.14 |
| GitHub Copilot extension | Latest |

### Steps

1. Enable *Editor Preview Features* at **https://github.com/settings/copilot/features**

2. In Visual Studio: **Tools → Options → GitHub → Copilot**
   - Enable **"Enable MCP server integration in agent mode"**

3. Create `.mcp.json` in your solution root:

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    },
    "context": {
      "workspacePath": "K:\\AosService\\PackagesLocalDirectory\\YourModel"
    }
  }
}
```

4. Copy `.github/copilot-instructions.md` from this repo into your D365FO solution workspace.

5. Restart Visual Studio and open Copilot Chat in **Agent Mode**.

See [MCP_CONFIG.md](MCP_CONFIG.md) for all configuration options.

---

## Troubleshooting

### "fts5: syntax error" when searching
Your search query contains special characters. The server now handles this automatically
with a fallback to LIKE search. If you still see this error, update to the latest version.

### Database build fails with "FTS5 not available"
Reinstall the native SQLite module:
```powershell
npm rebuild better-sqlite3
```

### No metadata found after extraction
- Check that `PACKAGES_PATH` points to a directory containing XML model files
- Check that your model names in `CUSTOM_MODELS` match the actual folder names exactly
- Verify file permissions on PackagesLocalDirectory

### Slow response times on Azure
1. Enable Redis: set `REDIS_ENABLED=true` and configure `REDIS_URL`
2. Scale up App Service to B2 or P1v3
3. Check available memory — minimum 1.75 GB for B1, 3.5 GB for P0v3

### MCP tools not loading in Visual Studio
- Confirm Visual Studio version is 17.14 or later
- Confirm *Editor Preview Features* are enabled in your GitHub account
- Confirm the `.mcp.json` file is in the solution root (same folder as the `.sln` file)
- Check Copilot Chat is in **Agent Mode** (not Ask or Edit mode)

### File created in wrong D365FO model
Always provide a `workspacePath` in `.mcp.json` or let GitHub Copilot auto-detect
the `.rnrproj` from the open workspace. See [WORKSPACE_DETECTION.md](WORKSPACE_DETECTION.md).

---

## Next Steps

- [MCP_CONFIG.md](MCP_CONFIG.md) — configure workspace paths
- [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) — try example prompts
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) — ISV and multi-model setups
- [PIPELINES.md](PIPELINES.md) — automate metadata refresh
