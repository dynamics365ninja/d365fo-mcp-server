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
- **Node.js** 24.x or later (LTS recommended)
- **Git**
- **Azure CLI** (for Azure deployment only)

### Azure Resources (cloud deployment only)
- **Azure Blob Storage** — stores the metadata databases (~2 GB total: 1-1.5 GB symbols + 500 MB labels for 4 languages)
- **Azure App Service** — B1 minimum, P0v3 recommended for production
- **Azure Cache for Redis** — optional, speeds up repeated queries

### D365FO Access

- A D365FO development environment with PackagesLocalDirectory (traditional), or
- A UDE environment with Power Platform Tools in VS2022 (custom + Microsoft metadata roots), or
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
# Environment type: auto (default), traditional, ude
DEV_ENVIRONMENT_TYPE=auto

# --- Traditional ---
PACKAGES_PATH=C:/AosService/PackagesLocalDirectory
CUSTOM_MODELS=YourModel1,YourModel2

# --- UDE (Unified Developer Experience) ---
# Leave XPP_CONFIG_NAME empty to auto-select newest config
# Tip: run  npm run select-config  to pick interactively
# XPP_CONFIG_NAME=

# --- Database ---
DB_PATH=./data/xpp-metadata.db                 # Symbols (~1-1.5 GB)
LABELS_DB_PATH=./data/xpp-metadata-labels.db   # Labels (~500 MB for 4 languages)
LABEL_LANGUAGES=en-US,cs,sk,de                 # Reduce with fewer languages

# --- Cloud (optional) ---
# AZURE_STORAGE_CONNECTION_STRING=...
# REDIS_ENABLED=false
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

Index all extracted symbols into the SQLite databases:

```powershell
npm run build-database
```

This creates:
- `data/xpp-metadata.db` — Symbols database (~1-1.5 GB)
- `data/xpp-metadata-labels.db` — Labels database (~500 MB for 4 languages, up to 8 GB for all 70 languages)

**Performance:** Separated databases ensure symbol search remains fast (<500ms) even with 20M+ labels.

### 5. Start the Server

```powershell
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

The server runs at `http://localhost:8080`. Check `http://localhost:8080/health` to confirm it is up.

### Startup behaviour by configuration

The server automatically decides whether to download the database on startup based on your environment variables.

| Scenario | Required settings | What happens on startup |
|----------|-------------------|------------------------|
| **Local dev — database from Azure** | `AZURE_STORAGE_CONNECTION_STRING` + `BLOB_CONTAINER_NAME` | Downloads `xpp-metadata.db` (~1–1.5 GB) and `xpp-metadata-labels.db` (~500 MB) from Blob Storage if missing or outdated. Validates integrity before use. |
| **Local dev — database built locally** | `PACKAGES_PATH` + run `npm run build-database` once | No download. Opens `data/xpp-metadata.db` directly. If it doesn't exist the server warns and starts with an empty index. |
| **Azure App Service** (read-only mode) | `MCP_SERVER_MODE=read-only` + `AZURE_STORAGE_CONNECTION_STRING` | Downloads the latest database on each cold start. Only search and analysis tools are exposed — file-operation tools are hidden. |
| **Local hybrid companion** (write-only mode) | `MCP_SERVER_MODE=write-only` | Skips all database work entirely. Starts in under one second. Only exposes `create_d365fo_file`, `modify_d365fo_file`, and `create_label`. |

> **Hybrid setup:** When the Azure server runs in `read-only` mode and the local companion runs in `write-only` mode, GitHub Copilot connects to both simultaneously and routes each tool call to the correct instance automatically. See [MCP_CONFIG.md](MCP_CONFIG.md#hybrid-setup-azure--local) for the `.mcp.json` configuration.

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
  --runtime "NODE:24-lts"
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

# Include package.json and package-lock.json so App Service can run
# npm ci at deploy time and compile better-sqlite3 for its own environment.
# Do NOT include node_modules — Oryx builds them on the server.
Compress-Archive -Path dist, package.json, package-lock.json, startup.sh `
  -DestinationPath deploy.zip

az webapp deployment source config-zip \
  --resource-group your-rg \
  --name xpp-mcp-server \
  --src deploy.zip
```

> `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (set in the Bicep template) tells Oryx
> to run `npm ci` after the zip is unpacked. This compiles native addons such as
> `better-sqlite3` against the exact Node.js version running on App Service,
> avoiding the *"Module did not self-register"* error.

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

- **Traditional:** Check that `PACKAGES_PATH` points to a directory containing XML model files and that `CUSTOM_MODELS` matches the actual folder names exactly
- **UDE:** Run `npm run select-config` to verify the correct XPP config is active and that the custom/Microsoft package paths exist
- Verify file permissions on the packages directory

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
