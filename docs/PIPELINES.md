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

1. **Build Custom Pipeline** - Fast custom model updates (~5-15 minutes, manual trigger)
2. **Build Standard Pipeline** - Standard metadata extraction with database build (~45-90 minutes)
3. **Platform Upgrade Pipeline** - Complete D365 version upgrade (~50-70 minutes)

### Benefits

- ⚡ **95% faster custom updates** - Updates in 5-15 minutes (vs 2-3 hours full extraction)
- 📊 **Separation of concerns** - Standard vs custom metadata
- 💰 **Cost optimization** - Reduced compute time, pay only for custom model updates
- 🛡️ **Reliable** - Consistent, repeatable automated process
- 🎯 **Flexible** - Manual trigger allows control over when updates happen

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
1. Checkout D365FO source code from Azure DevOps (checkout: self)
2. Checkout MCP Server code from GitHub
3. Install Node.js dependencies (npm ci)
4. Download existing database from blob (contains standard models already indexed)
5. Delete old custom metadata from blob
6. Extract custom models from D365FO Git source (`PACKAGES_PATH: ASL/src/d365fo/metadata`)
7. Build database (fast - standard already indexed, only replaces custom models)
8. Upload new custom metadata to blob
9. Upload updated database to blob
10. Restart App Service

**Process (Standard/All Mode):**
1. Checkout D365FO source code from Azure DevOps (checkout: self)
2. Checkout MCP Server code from GitHub
3. Install Node.js dependencies (npm ci)
4. Download standard metadata from blob (only for standard/all modes, not custom)
5. Extract metadata based on mode from D365FO source
   - `standard`: Extract only standard models
   - `all`: Extract all models (standard + custom)
6. Build database from scratch
7. Upload metadata and database to blob
8. Restart App Service

**When to Use:**
- Daily automated sync
- Quick custom model updates
- Testing custom changes

**Execution Time:** ~5-15 minutes (95% faster!)

**Agent:** ubuntu-latest

### 2. d365fo-mcp-data-build-standard.yml - Standard Metadata Extraction & Build

**Purpose:** Extract Microsoft standard models from PackagesLocalDirectory.zip and build database

**Trigger:**
- Manual execution only (trigger: none)

**Process:**
1. Checkout MCP Server code from GitHub
2. Install Node.js dependencies
3. Download PackagesLocalDirectory.zip from Azure Blob Storage (container: `packages`)
4. Extract PackagesLocalDirectory.zip
5. Extract standard metadata from packages (EXTRACT_MODE: 'standard')
6. Upload standard metadata to blob storage under `/metadata/standard/`
7. Build database from standard metadata only
8. Upload compiled database to Azure Blob Storage
9. Restart App Service to load new database

**When to Use:**
- After D365 platform/application updates
- New version release (quarterly)
- When PackagesLocalDirectory.zip is updated in Blob Storage

**Execution Time:** ~45-90 minutes (includes database build with 350+ standard models)

**Agent:** ubuntu-latest

**Memory Configuration:**
- NODE_OPTIONS: `--max-old-space-size=8192 --expose-gc` (8GB heap)
- ENABLE_SEARCH_SUGGESTIONS: `false` (reduces memory usage)
- COMPUTE_STATS: `true` (optimized statistics with batching)
- Timeout: 120 minutes

**Storage Requirements:**
- PackagesLocalDirectory.zip must be pre-uploaded to Azure Blob Storage (container: `packages`)
- Extracts only standard models (all models NOT in CUSTOM_MODELS env variable)
- Builds complete database from standard models
- Uploads both metadata and database to blob storage

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

**Execution Time:** ~50-70 minutes (full standard + custom database build)

**Agent:** ubuntu-latest

**Memory Configuration:**
- NODE_OPTIONS: `--max-old-space-size=8192 --expose-gc` (8GB heap)
- ENABLE_SEARCH_SUGGESTIONS: `false` (reduces memory usage)
- No timeout limit (uses default)

**Important Notes:**
- **Requires pre-extracted custom metadata** in Blob Storage (from build-custom pipeline)
- **Restarts App Service** - impacts production availability briefly (~15-30 seconds)
- Uses PackagesLocalDirectory.zip from Blob Storage (container: `packages`)
- Downloads custom metadata from blob (doesn't extract from source)
- Builds complete database combining standard + custom metadata

---

## Workflow Scenarios

### Scenario 1: Daily Development

**Situation:** Normal development, code commits to dev branch

**Recommended Approach:**
- Manually trigger pipeline after completing development work
- Update database with custom model changes

**Pipeline:** `d365fo-mcp-data-build-custom.yml` (manual trigger required)

**Process:**
1. Navigate to Pipelines → d365fo-mcp-data-build-custom.yml
2. Click "Run pipeline"
3. Pipeline checks out both D365FO source (Azure DevOps) and MCP Server (GitHub)
4. Extracts only custom models from D365FO source
5. Updates database with changes

**Result:** Updated metadata and database with latest custom models

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
3. Click "Run pipeline" (manual trigger only, no scheduled runs)
4. Wait for completion (~45-90 minutes) - includes database build and restart
5. Optionally run d365fo-mcp-data-build-custom.yml if custom models changed
6. Or run d365fo-mcp-data-platform-upgrade.yml for complete deployment with service restart

**Pipelines:** 
1. `d365fo-mcp-data-build-standard.yml` (manual only)
2. `d365fo-mcp-data-build-custom.yml` (manual - if custom models changed)
3. `d365fo-mcp-data-platform-upgrade.yml` (manual - final deployment)

**Result:** Latest Microsoft metadata + your custom models deployed to production

**Alternative Approach (Single Pipeline - Complete Upgrade):**
1. Upload new PackagesLocalDirectory.zip to Azure Blob Storage (container: `packages`)
2. Ensure custom metadata is up-to-date in Blob Storage (run build-custom first if needed)
3. Navigate to Pipelines → d365fo-mcp-data-platform-upgrade.yml
4. Click "Run pipeline"
5. Wait for completion (~50-70 minutes)

**Pipeline:** `d365fo-mcp-data-platform-upgrade.yml` (single run with service restart)

**Result:** Complete upgrade - standard metadata updated + custom metadata combined + database deployed + service restarted

---

### Scenario 4: New Project Setup

**Situation:** Setting up MCP server for the first time

**Recommended Approach:**
1. Configure all Azure DevOps variables (see variable group setup)
2. Upload PackagesLocalDirectory.zip to Azure Blob Storage (container: `packages`)
3. Run `d365fo-mcp-data-build-standard.yml` for standard models (~45-90 min, includes database build)
4. Run `d365fo-mcp-data-build-custom.yml` for initial custom extraction (~5-15 min)
5. Run `d365fo-mcp-data-platform-upgrade.yml` to deploy complete database to production (~50-70 min)

**Pipelines:**
1. `d365fo-mcp-data-build-standard.yml` (manual)
2. `d365fo-mcp-data-build-custom.yml` (manual)
3. `d365fo-mcp-data-platform-upgrade.yml` (manual - final deployment)

**Result:** Complete setup with all metadata and database deployed to production

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
- Build-custom pipeline: Should complete in 5-15 minutes (custom models only)
- Build-standard pipeline: Should complete in 45-90 minutes (standard extraction + database build)
- Platform upgrade pipeline: Should complete in 50-70 minutes (standard + custom, full rebuild)
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

### Memory Management

**Pipeline Node.js Heap Configuration:**

All pipelines are configured with memory-optimized settings:

```yaml
env:
  ENABLE_SEARCH_SUGGESTIONS: 'false'  # Disable in CI/CD to reduce memory
  NODE_OPTIONS: '--max-old-space-size=8192 --expose-gc'  # 8GB heap size with GC
  COMPUTE_STATS: 'true'  # Optimized statistics with batching (build-standard only)
```

**Settings Explanation:**
- `ENABLE_SEARCH_SUGGESTIONS=false` - Disables term relationship graph building during database build
  - Saves ~800MB-1.5GB memory during pipeline execution
  - Search suggestions are not needed during metadata extraction
  - Reduces risk of "JavaScript heap out of memory" errors
- `NODE_OPTIONS='--max-old-space-size=8192 --expose-gc'` - Memory optimization for large databases
  - Sets Node.js heap limit to 8GB for indexing 350+ models (584K+ symbols)
  - `--expose-gc` enables manual garbage collection for memory management
  - Standard Azure Pipeline agents have 14GB RAM, so 8GB heap is safe
  - Build-custom pipeline also uses this configuration for consistency

**⚠️ If Pipeline Fails with "heap out of memory":**
1. Verify `ENABLE_SEARCH_SUGGESTIONS=false` is set in pipeline YAML (already configured)
2. Current heap size is already 8GB (`--max-old-space-size=8192`)
3. Check metadata size - 500K+ symbols is normal for full D365FO
4. If still failing, increase agent VM size or reduce CUSTOM_MODELS scope
5. Verify `--expose-gc` flag is present for garbage collection

### Cost Optimization

**Compute Costs (Azure Pipeline Minutes):**
- Build-custom pipeline: ~5-15 min/run, auto-triggered on dev branch changes (~1-2 runs/day)
  - Monthly: ~20-30 runs × 15 min = 300-450 minutes ≈ $0.50-1.00/month
- Build-standard pipeline: ~45-90 min/run, manual trigger only
  - Quarterly: 4 runs/year × 90 min = 360 minutes ≈ $2-5/year
- Platform upgrade pipeline: ~50-70 min/run, manual trigger for production deployment
  - Ad-hoc: ~2-4 runs/year × 70 min = 140-280 minutes ≈ $1-2/year

**Storage Costs:**
- Metadata: ~2-3 GB → ~$0.05/month
- Database: ~1.5 GB → ~$0.03/month
- PackagesLocalDirectory.zip: ~5-10 GB → ~$0.15/month
- Total: ~$0.23/month

**Total Monthly Cost:** ~$1-2/month

**Optimization Tips:**
1. Use build-custom pipeline for daily updates (auto-triggered on dev branch)
2. Run build-standard pipeline manually after D365 upgrades (no automatic schedule)
3. Clean old blob versions periodically to reduce storage costs
4. Use Basic tier Redis or disable caching if not needed
5. Monitor pipeline execution times for performance degradation

### Maintenance Tasks

#### Weekly
- ✅ Check pipeline success rate
- ✅ Review execution times for anomalies

#### Monthly
- ✅ Verify database size (~1.5GB expected)
- ✅ Check blob storage usage
- ✅ Review App Service metrics

#### Quarterly
- ✅ Verify PackagesLocalDirectory.zip is current version in Blob Storage
- ✅ Run build-standard extraction manually after D365 updates (no automatic schedule)
- ✅ Review and optimize custom models list
- ✅ Run platform upgrade pipeline for production deployment if needed

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
4. Expected size: ~1.5GB
```

---

## Best Practices

### 1. Use Appropriate Pipeline

- **Code changes** → Build-custom pipeline (manual trigger, fastest update)
- **D365 upgrades** → Build-standard pipeline (manual trigger, quarterly or as needed)
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

---

## Support

For pipeline issues:
- Check Azure DevOps pipeline logs
- Review variable group configuration
- Verify Azure service connections
- Test scripts locally with `scripts/test-pipeline.ps1`

GitHub Issues: https://github.com/dynamics365ninja/d365fo-mcp-server/issues
