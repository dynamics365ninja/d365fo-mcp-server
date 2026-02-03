# Azure Pipelines - Automation Guide

Complete guide for Azure DevOps pipeline automation of D365FO metadata extraction and deployment.

## Table of Contents

- [Overview](#overview)
- [Pipeline Architecture](#pipeline-architecture)
- [Pipeline Configurations](#pipeline-configurations)
- [Workflow Scenarios](#workflow-scenarios)
- [Monitoring and Maintenance](#monitoring-and-maintenance)

---

## Overview

### Problem Statement

Manual metadata extraction and database builds are time-consuming:
- Full extraction: 2-3 hours
- Database build: 30-60 minutes
- Manual deployment required
- Risk of human error

### Solution

Three automated pipelines that separate standard (quarterly) and custom (daily) metadata:

1. **Full Pipeline** - Complete custom metadata extraction
2. **Quick Pipeline** - Custom updates on code changes (~95% faster)
3. **Standard Pipeline** - Standard metadata from NuGet
4. **Platform Upgrade Pipeline** - Complete D365 version upgrade

### Benefits

- ⚡ **95% faster updates** - Updates in 5-15 minutes on code changes
- 📊 **Separation of concerns** - Standard vs custom metadata
- 💰 **Cost optimization** - Reduced compute time
- 🛡️ **Reliable** - Consistent, repeatable process

---

## Pipeline Architecture

### Storage Structure

Azure Blob Storage hierarchy:

```
xpp-metadata/
├── metadata/
│   ├── standard/           # Microsoft models (quarterly updates)
│   │   ├── ApplicationCommon/
│   │   ├── ApplicationPlatform/
│   │   ├── ApplicationSuite/
│   │   └── ... (36 models)
│   └── custom/             # Your models (daily updates)
│       ├── YourModel1/
│       ├── YourModel2/
│       └── ...
└── database/
    └── xpp-metadata.db     # Compiled SQLite database
```

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Standard Extraction                       │
│                    (Quarterly - NuGet)                       │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  │ Upload
                  ▼
         ┌────────────────┐
         │ Standard Models │
         │  in Blob Store  │
         └────────────────┘
                  │
                  │ Download (cached)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Daily Custom Extraction                         │
│  1. Checkout D365FO source (Azure DevOps)                   │
│  2. Checkout MCP Server (GitHub)                            │
│  3. Download Standard → Extract Custom → Build → Upload     │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
         ┌────────────────┐
         │  Full Database  │
         │ Standard+Custom │
         └────────────────┘
                  │
                  │ Upload to Blob
                  ▼
         ┌────────────────┐
         │  App Service    │
         │    Restart      │
         └────────────────┘
```

---

## Pipeline Configurations

### 1. d365fo-mcp-data.yml - Full Custom Extraction

**Purpose:** Complete extraction of custom models from Git repository

**Trigger:**
- Changes to `src/`, `scripts/`, or pipeline files
- Manual execution

**Process:**
1. Download standard metadata from blob (cached)
2. Extract custom models from Git repository
3. Build SQLite database (standard + custom)
4. Upload custom metadata to blob
5. Upload database to blob
6. Restart App Service

**When to Use:**
- Initial setup
- Major code changes
- After Git force-push or rebase
- Troubleshooting metadata issues

**Execution Time:** ~30-45 minutes

**Agent:** ubuntu-latest

### 2. d365fo-mcp-data-quick.yml - Updates on Changes

**Purpose:** Fast updates of custom models when code changes

**Trigger:**
- Automatic on changes to `main` branch in `src/**` or pipeline file
- Manual with parameters

**Parameters:**
- `extractionMode`: `custom` (default), `standard`, `all`
- `customModels`: Specific models or 'all' for all (default: 'all')

**Source Code Checkouts:**
1. D365FO source code from Azure DevOps repository (checkout: self)
   - Location: `$(Build.SourcesDirectory)`
   - Contains D365FO metadata at `ASL/src/d365fo/metadata`
2. MCP Server code from GitHub (dynamics365ninja/d365fo-mcp-server)
   - Location: `$(Pipeline.Workspace)/mcp-server`
   - Contains scripts and tools

**Process (Custom Mode - Default):**
1. Checkout D365FO source code from Azure DevOps
2. Checkout MCP Server code from GitHub
3. Install Node.js dependencies
4. Download existing database from blob
5. Download standard metadata from blob (cached, unchanged)
6. Delete old custom metadata from blob
7. Extract custom models from D365FO Git source
8. Build database (fast - standard already indexed, only custom models updated)
9. Upload new custom metadata
10. Upload database
11. Restart App Service

**Process (Standard/All Mode):**
1. Checkout D365FO source code from Azure DevOps
2. Checkout MCP Server code from GitHub
3. Install Node.js dependencies
4. Extract metadata based on mode (standard/all)
5. Build database from scratch
6. Upload metadata and database
7. Restart App Service

**When to Use:**
- Daily automated sync
- Quick custom model updates
- Testing custom changes

**Execution Time:** ~5-15 minutes (95% faster!)

**Agent:** ubuntu-latest

### 3. d365fo-mcp-data-standard-extract.yml - NuGet Extraction

**Purpose:** Extract Microsoft standard models from NuGet packages

**Trigger:**
- Manual execution only
- Use before D365 platform upgrades

**Process:**
1. Download NuGet packages (Application, Platform, Compiler)
2. Extract metadata from packages
3. Upload to blob storage under `/metadata/standard/`

**When to Use:**
- After D365 platform/application updates
- New version release

**Execution Time:** ~2-3 hours (runs rarely)

**Agent:** windows-latest (required for NuGet.exe)

**NuGet Packages:**
- Microsoft.Dynamics.AX.Application.DevALM.BuildXpp (10.0.*)
- Microsoft.Dynamics.AX.ApplicationSuite.DevALM.BuildXpp (10.0.*)
- Microsoft.Dynamics.AX.Platform.DevALM.BuildXpp (7.0.*)
- Microsoft.Dynamics.AX.Platform.CompilerPackage (7.0.*)

### 4. d365fo-mcp-data-platform-upgrade.yml - Complete Platform Upgrade

**Purpose:** Complete D365 platform upgrade in single pipeline run - no intermediate uploads/downloads

**Trigger:**
- Manual execution only

**Process:**
1. Download latest NuGet packages (Application 10.0.*, Platform 7.0.*, Compiler 7.0.*)
2. Extract standard metadata from packages (local)
3. Extract custom metadata from Git source (local)
4. Build database (standard + custom, local)
5. Upload everything to blob storage (standard + custom + database)
6. Restart App Service

**Key Benefits:**
- **Single stage** - no intermediate blob operations
- **Faster** - eliminates upload/download between extraction steps
- **Simpler** - unified process on one agent
- **More efficient** - all metadata stays local until final upload

**When to Use:**
- After D365 platform/application updates
- New version release
- Complete upgrade in single run

**Execution Time:** ~1.5-2 hours (optimized, single stage)

**Agent:** windows-latest (required for NuGet.exe)

---

## Workflow Scenarios

### Scenario 1: Daily Development

**Situation:** Normal development, code commits to main branch

**Recommended Approach:**
- Pipeline runs automatically when you push changes to `main`
- No manual intervention needed

**Pipeline:** `d365fo-mcp-data-quick.yml` (auto on push)

**Process:**
- Automatically checks out both D365FO source (Azure DevOps) and MCP Server (GitHub)
- Extracts only custom models from D365FO source
- Updates database with changes

**Result:** Updated metadata and database after each commit

---

### Scenario 2: Urgent Update

**Situation:** Need immediate metadata update after important commit

**Recommended Approach:**
1. Navigate to Pipelines → d365fo-mcp-data-quick.yml
2. Click "Run pipeline"
3. Keep default parameters:
   - extractionMode: custom
   - customModels: all
4. Wait 5-15 minutes

**Pipeline:** `d365fo-mcp-data-quick.yml` (manual)

**Process:**
- Checks out D365FO source from Azure DevOps (ASL/src/d365fo/metadata)
- Checks out MCP Server from GitHub
- Extracts custom models from local D365FO source
- Updates database

**Result:** Metadata updated within minutes

---

### Scenario 3: D365 Platform Upgrade

**Situation:** Microsoft released new D365 version (e.g., 10.0.42)

**Recommended Approach (Option 1 - Single Pipeline):**
1. Navigate to Pipelines → d365fo-mcp-data-platform-upgrade.yml
2. Click "Run pipeline"
3. Enter D365 version number (e.g., "10.0.42")
4. Wait for completion (~2-3 hours)

**Pipeline:** `d365fo-mcp-data-platform-upgrade.yml` (single run)

**Result:** Complete upgrade - standard metadata updated + custom rebuilt + database deployed

**Alternative Approach (Option 2 - Separate Pipelines):**
1. Update NuGet package versions in `nuget-config/latest.csproj`
2. Run `d365fo-mcp-data-standard-extract.yml` manually
3. Wait for completion (~2-3 hours)
4. Run `d365fo-mcp-data-quick.yml` to rebuild database

**Pipelines:** 
1. `d365fo-mcp-data-standard-extract.yml` (manual)
2. `d365fo-mcp-data-quick.yml` (manual)

**Result:** Latest Microsoft metadata + your custom models

---

### Scenario 4: New Project Setup

**Situation:** Setting up MCP server for the first time

**Recommended Approach:**
1. Configure all Azure DevOps variables
2. Run `d365fo-mcp-data-standard-extract.yml` for standard models
3. Run `d365fo-mcp-data.yml` for initial custom extraction

**Pipelines:**
1. `azure-pipelines-standard-extract.yml` (manual)
2. `d365fo-mcp-data.yml` (manual first run)
3. `d365fo-mcp-data-quick.yml` (auto on code changes)

**Result:** Complete setup with automated updates on code changes

---

### Scenario 5: Specific Model Update

**Situation:** Changed only YourCustomModel2, no need to extract all

**Recommended Approach:**
1. Run quick pipeline manually
2. Set parameters:
   - extractionMode: custom
   - customModels: "YourCustomModel2"
3. Wait 3-5 minutes

**Pipeline:** `d365fo-mcp-data-quick.yml` (manual with parameter)

**Process:**
- Checks out both D365FO source and MCP Server
- Extracts only YourCustomModel2 from D365FO source
- Updates database with specific model only

**Result:** Only YourCustomModel2 updated, faster than extracting all

---

## Monitoring and Maintenance

### Pipeline Monitoring

**Azure DevOps Portal:**
1. Navigate to **Pipelines** → **All pipelines**
2. Check last run status
3. Review execution time trends
4. Set up email notifications for failures

**Key Metrics:**
- Quick pipeline: Should complete in 5-15 minutes
- Full pipeline: Should complete in 30-45 minutes
- Standard pipeline: Should complete in 2-3 hours
- Success rate: Should be >95%

### Log Analysis

**Common Log Locations:**
```
Pipeline Logs:
├── Download metadata → Check blob connection
├── Extract metadata → Verify PACKAGES_PATH
├── Build database → Check SQLite errors
└── Upload → Verify blob write permissions
```

**Debugging Steps:**
1. Check step output for errors
2. Verify environment variables
3. Test blob storage connection
4. Validate model paths

### Cost Optimization

**Compute Costs:**
- Quick pipeline: ~$0.50/month (daily runs)
- Full pipeline: ~$2-5/month (occasional runs)
- Standard pipeline: ~$5-10/year (quarterly runs)

**Storage Costs:**
- Metadata: ~2-3 GB → ~$0.05/month
- Database: ~500 MB → ~$0.01/month
- Total: ~$0.06/month

**Total Monthly Cost:** ~$1-2/month

**Optimization Tips:**
1. Use quick pipeline for daily updates
2. Disable full pipeline auto-trigger if not needed
3. Clean old blob versions periodically
4. Use Basic tier Redis or disable caching

### Maintenance Tasks

#### Weekly
- ✅ Check pipeline success rate
- ✅ Review execution times for anomalies

#### Monthly
- ✅ Verify database size (~500MB expected)
- ✅ Check blob storage usage
- ✅ Review App Service metrics

#### Quarterly
- ✅ Update NuGet packages for D365 versions
- ✅ Run standard extraction after D365 updates
- ✅ Review and optimize custom models list

#### Yearly
- ✅ Audit Azure costs
- ✅ Review pipeline configurations
- ✅ Update Node.js version if needed

### Troubleshooting

#### Pipeline Fails: "Cannot find variable group"

**Solution:**
```bash
# Verify variable group exists
1. Go to Pipelines → Library
2. Check "xpp-mcp-server-config" exists
3. Link to pipeline security
```

#### Pipeline Fails: "Blob not found"

**Solution:**
```bash
# Run standard extraction first
1. Execute d365fo-mcp-data-standard-extract.yml
2. Verify metadata/standard/ folder in blob
3. Retry failed pipeline
```

#### Slow Extraction

**Solution:**
```bash
# Optimize extraction
1. Use quick pipeline instead of full
2. Specify exact models with customModels parameter
3. Check Git repository size
4. Verify agent performance
```

#### Database Too Large

**Solution:**
```bash
# Check what's being indexed
1. Review CUSTOM_MODELS variable
2. Remove unnecessary models
3. Re-run extraction
4. Expected size: ~500MB
```

---

## Best Practices

### 1. Use Appropriate Pipeline

- **Code changes** → Quick pipeline (auto trigger)
- **Major changes** → Full pipeline (manual)
- **D365 upgrades** → Platform upgrade pipeline (manual)

### 2. Parameterize When Possible

- Use `customModels` parameter for targeted updates
- Use `extractionMode` parameter for flexibility
- Test parameters locally before pipeline execution

### 3. Monitor Costs

- Review Azure DevOps parallel jobs usage
- Check blob storage costs monthly
- Monitor pipeline execution frequency

### 4. Version Control

- Keep pipeline YAML in Git
- Document configuration changes
- Review pipeline changes in PRs

### 5. Security

- Store secrets in variable groups
- Use Azure Key Vault for sensitive data
- Limit pipeline permissions
- Rotate connection strings periodically

---

## Next Steps

- Review [SETUP.md](SETUP.md) for initial configuration
- Check [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) for MCP usage
- See [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- Read [PERFORMANCE.md](PERFORMANCE.md) for optimization

---

## Support

For pipeline issues:
- Check Azure DevOps pipeline logs
- Review variable group configuration
- Verify Azure service connections
- Test scripts locally with `scripts/test-pipeline.ps1`

GitHub Issues: https://github.com/dynamics365ninja/d365fo-mcp-server/issues
