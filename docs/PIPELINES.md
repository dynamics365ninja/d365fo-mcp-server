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

1. **Build Custom Pipeline** - Custom updates on code changes (~95% faster)
2. **Build Standard Pipeline** - Standard metadata extraction with database build
3. **Platform Upgrade Pipeline** - Complete D365 version upgrade

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

### 1. d365fo-mcp-data-build-custom.yml - Updates on Changes

**Purpose:** Fast updates of custom models when code changes

**Trigger:**
- Automatic on changes to `dev` branch in `src/**` or pipeline file
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

### 2. d365fo-mcp-data-build-standard.yml - Standard Metadata Extraction & Build

**Purpose:** Extract Microsoft standard models from PackagesLocalDirectory.zip and build database

**Trigger:**
- Manual execution only
- Scheduled quarterly (cron: "0 3 1 1,4,7,10 *" - Jan 1, Apr 1, Jul 1, Oct 1 at 3 AM UTC)

**Process:**
1. Checkout MCP Server code from GitHub
2. Install Node.js dependencies
3. Download PackagesLocalDirectory.zip from Azure Blob Storage
4. Extract the ZIP file
5. Extract standard metadata from packages (EXTRACT_MODE: 'standard')
6. Upload metadata to blob storage under `/metadata/standard/`
7. Build database from standard metadata
8. Upload database to Azure Blob Storage
9. Restart App Service to load new database

**When to Use:**
- After D365 platform/application updates
- New version release (quarterly)
- When PackagesLocalDirectory.zip is updated in Blob Storage

**Execution Time:** ~30-60 minutes

**Agent:** ubuntu-latest

**Storage Requirements:**
- PackagesLocalDirectory.zip must be pre-uploaded to Azure Blob Storage (container: `packages`)
- Extracts only standard models (all models NOT in CUSTOM_MODELS env variable)

### 3. d365fo-mcp-data-platform-upgrade.yml - Complete Platform Upgrade

**Purpose:** Complete D365 platform upgrade combining standard and custom metadata with service restart

**Trigger:**
- Manual execution only

**Process:**
1. Checkout MCP Server code from GitHub
2. Install Node.js dependencies
3. Download PackagesLocalDirectory.zip from Azure Blob Storage
4. Extract the ZIP file
5. Extract standard metadata from packages (EXTRACT_MODE: 'standard')
6. Download custom metadata from Azure Blob Storage
7. Build database (standard + custom, combined)
8. Upload database to Azure Blob Storage
9. Restart App Service to load new database

**Key Benefits:**
- **Complete upgrade** - combines standard and custom metadata in one run
- **Service restart** - automatically deploys new database to production
- **Efficient** - downloads pre-extracted custom metadata instead of re-extracting

**When to Use:**
- After D365 platform/application updates
- When you need to deploy updated database to production
- Complete upgrade with service restart

**Execution Time:** ~30-45 minutes

**Agent:** ubuntu-latest

**Important Notes:**
- **Requires pre-extracted custom metadata** in Blob Storage (from build-custom pipeline)
- **Restarts App Service** - impacts production availability briefly
- Uses PackagesLocalDirectory.zip from Blob Storage (not NuGet)

---

## Workflow Scenarios

### Scenario 1: Daily Development

**Situation:** Normal development, code commits to dev branch

**Recommended Approach:**
- Pipeline runs automatically when you push changes to `dev`
- No manual intervention needed

**Pipeline:** `d365fo-mcp-data-build-custom.yml` (auto on push to dev)

**Process:**
- Automatically checks out both D365FO source (Azure DevOps) and MCP Server (GitHub)
- Extracts only custom models from D365FO source
- Updates database with changes

**Result:** Updated metadata and database after each commit

---

### Scenario 2: Urgent Update

**Situation:** Need immediate metadata update after important commit

**Recommended Approach:**
1. Navigate to Pipelines → d365fo-mcp-data-build-custom.yml
2. Click "Run pipeline"
3. Keep default parameters:
   - extractionMode: custom
   - customModels: all
4. Wait 5-15 minutes

**Pipeline:** `d365fo-mcp-data-build-custom.yml` (manual)

**Process:**
- Checks out D365FO source from Azure DevOps (ASL/src/d365fo/metadata)
- Checks out MCP Server from GitHub
- Extracts custom models from local D365FO source
- Updates database

**Result:** Metadata updated within minutes

---

### Scenario 3: D365 Platform Upgrade

**Situation:** Microsoft released new D365 version or you have new PackagesLocalDirectory.zip

**Recommended Approach (Separate Pipelines - Recommended):**
1. Upload new PackagesLocalDirectory.zip to Azure Blob Storage (container: `packages`)
2. Navigate to Pipelines → d365fo-mcp-data-build-standard.yml
3. Click "Run pipeline" (or wait for quarterly scheduled run)
4. Wait for completion (~30-60 minutes)
5. Run d365fo-mcp-data-build-custom.yml to rebuild custom metadata
6. Run d365fo-mcp-data-platform-upgrade.yml to deploy to production

**Pipelines:** 
1. `d365fo-mcp-data-build-standard.yml` (manual or scheduled quarterly)
2. `d365fo-mcp-data-build-custom.yml` (optional - if custom models changed)
3. `d365fo-mcp-data-platform-upgrade.yml` (manual - final deployment)

**Result:** Latest Microsoft metadata + your custom models deployed to production

**Alternative Approach (Single Pipeline):**
1. Upload new PackagesLocalDirectory.zip to Azure Blob Storage
2. Ensure custom metadata is up-to-date in Blob Storage
3. Navigate to Pipelines → d365fo-mcp-data-platform-upgrade.yml
4. Click "Run pipeline"
5. Wait for completion (~30-45 minutes)

**Pipeline:** `d365fo-mcp-data-platform-upgrade.yml` (single run with service restart)

**Result:** Complete upgrade - standard metadata updated + custom metadata combined + database deployed + service restarted

---

### Scenario 4: New Project Setup

**Situation:** Setting up MCP server for the first time

**Recommended Approach:**
1. Configure all Azure DevOps variables
2. Upload PackagesLocalDirectory.zip to Azure Blob Storage (container: `packages`)
3. Run `d365fo-mcp-data-build-standard.yml` for standard models (~30-60 min)
4. Run `d365fo-mcp-data-build-custom.yml` for initial custom extraction (~5-15 min)
5. Run `d365fo-mcp-data-platform-upgrade.yml` to deploy to production

**Pipelines:**
1. `d365fo-mcp-data-build-standard.yml` (manual)
2. `d365fo-mcp-data-build-custom.yml` (manual first run, then auto on code changes to dev)
3. `d365fo-mcp-data-platform-upgrade.yml` (manual - final deployment)

**Result:** Complete setup with automated updates on code changes

---

### Scenario 5: Specific Model Update

**Situation:** Changed only YourCustomModel2, no need to extract all

**Recommended Approach:**
1. Run build-custom pipeline manually
2. Set parameters:
   - extractionMode: custom
   - customModels: "YourCustomModel2"
3. Wait 3-5 minutes

**Pipeline:** `d365fo-mcp-data-build-custom.yml` (manual with parameter)

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
- Build-custom pipeline: Should complete in 5-15 minutes
- Build-standard pipeline: Should complete in 30-60 minutes
- Platform upgrade pipeline: Should complete in 30-45 minutes
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
- Build-custom pipeline: ~$0.50/month (daily runs)
- Build-standard pipeline: ~$2-5/year (quarterly runs)

**Storage Costs:**
- Metadata: ~2-3 GB → ~$0.05/month
- Database: ~500 MB → ~$0.01/month
- PackagesLocalDirectory.zip: ~5-10 GB → ~$0.15/month
- Total: ~$0.21/month

**Total Monthly Cost:** ~$1-2/month

**Optimization Tips:**
1. Use build-custom pipeline for daily updates
2. Let build-standard run on quarterly schedule
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
- ✅ Verify PackagesLocalDirectory.zip is current version in Blob Storage
- ✅ Run build-standard extraction after D365 updates (or rely on scheduled run)
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
1. Ensure PackagesLocalDirectory.zip is uploaded to Blob Storage (container: packages)
2. Execute d365fo-mcp-data-build-standard.yml
3. Verify metadata/standard/ folder in blob
4. Retry failed pipeline
```

#### Slow Extraction

**Solution:**
```bash
# Optimize extraction
1. Specify exact models with customModels parameter
2. Check Git repository size
3. Verify agent performance
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

- **Code changes** → Build-custom pipeline (auto trigger on dev branch)
- **D365 upgrades** → Build-standard pipeline (quarterly or manual)
- **Production deployment** → Platform upgrade pipeline (manual with service restart)

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
