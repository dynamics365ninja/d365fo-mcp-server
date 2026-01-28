# Azure Pipeline Metadata Extraction Automation

This document describes a solution for automated X++ metadata extraction with separation of standard and custom models to optimize computation time.

## Solution Overview

### Problem
- **Standard metadata** changes a few times per year
- **Custom metadata** can change on a daily basis
- Full extraction of all models takes a long time and is inefficient for daily updates

### Solution
Separated metadata management in Azure Blob Storage:
```
/metadata/standard/    # Standard D365 models (updated few times per year)
/metadata/custom/      # Custom/ISV models (daily updates)
/databases/            # Compiled SQLite database
```

## Architecture

```
DevOps Git Repository (D365FO Source Code)
    ↓
Azure Pipeline (Extract Custom Models Only)
    ↓
Azure Blob Storage
    ├── /metadata/standard/  [Cached, static]
    ├── /metadata/custom/    [Daily updates]
    └── /databases/xpp-metadata-latest.db
    ↓
Azure App Service (MCP Server)
```

## Solution Components

### 1. Azure Blob Manager (`scripts/azure-blob-manager.ts`)

New TypeScript script for managing metadata in Azure Blob Storage.

**Functions:**
- `upload-standard` - Upload standard metadata
- `upload-custom` - Upload custom metadata
- `upload-all` - Upload all metadata
- `download-standard` - Download standard metadata (for build)
- `download-custom` - Download custom metadata
- `download-all` - Download all metadata
- `delete-custom` - Delete custom metadata from blob
- `delete-local-custom` - Delete local custom metadata
- `upload-database` - Upload compiled database
- `download-database` - Download database

**Usage:**
```bash
npm run blob-manager upload-custom
npm run blob-manager delete-custom Model1,Model2
npm run blob-manager download-standard
npm run blob-manager upload-database ./data/xpp-metadata.db
```

### 2. Azure Pipeline - Daily Updates (`azure-pipelines-quick.yml`)

Optimized pipeline for fast daily updates of custom models.

**Stages:**
1. **Download Standard Metadata** - Download cached standard metadata
2. **Delete Old Custom** - Delete old custom metadata
3. **Extract Custom** - Extract only custom models from Git
4. **Build Database** - Build database (standard + new custom)
5. **Upload** - Upload custom metadata and database to blob
6. **Restart App Service** - Restart MCP server

**Scheduler:**
- Runs daily at 2:00 AM UTC
- Processes only custom models
- Takes ~5-15 minutes instead of hours

### 3. Azure Pipeline - Full Extraction (`azure-pipelines.yml`)

Complete pipeline for periodic update of all models.

**Usage:**
- When standard D365 models change (upgrade, hotfix)
- Manual execution as needed
- ~Few times per year

### 4. Azure Pipeline - Standard NuGet Extraction (`azure-pipelines-standard-extract.yml`)

Automated pipeline for extracting standard D365 metadata from Microsoft NuGet packages.

**Features:**
- Downloads latest standard packages from NuGet feed
- No need for local D365 VM
- Quarterly scheduled runs
- Directly uploads to blob storage

**Usage:**
- Automatic: Runs quarterly (Jan, Apr, Jul, Oct)
- Manual: After D365 version upgrade
- See [STANDARD_METADATA_NUGET.md](STANDARD_METADATA_NUGET.md) for setup

## Configuration

### Environment Variables

In `.env` or Azure DevOps Variable Groups:

```env
# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
BLOB_CONTAINER_NAME=xpp-metadata

# Metadata Paths
METADATA_PATH=./extracted-metadata
DB_PATH=./data/xpp-metadata.db

# Custom Models Configuration
CUSTOM_MODELS=ISV_Module1,ISV_Module2,CustomExtensions
EXTENSION_PREFIX=ISV_
EXTRACT_MODE=custom  # Options: all, standard, custom

# D365 Source (DevOps Git)
PACKAGES_PATH=/path/to/d365fo/source
```

### Azure DevOps Variable Group

Create Variable Group `xpp-mcp-server-config`:

| Variable | Value | Secret |
|----------|-------|--------|
| AZURE_STORAGE_CONNECTION_STRING | `DefaultEndpoints...` | ✅ |
| BLOB_CONTAINER_NAME | `xpp-metadata` | ❌ |
| CUSTOM_MODELS | `ISV_Module1,ISV_Module2` | ❌ |
| EXTENSION_PREFIX | `ISV_` | ❌ |
| AZURE_SUBSCRIPTION | `Your Azure Subscription` | ❌ |
| AZURE_APP_SERVICE_NAME | `your-mcp-server` | ❌ |

## Workflow Scenarios

### Scenario 1: Daily Custom Models Update

**Trigger:** Automatic (2:00 AM UTC daily) or manual

**Process:**
1. Pipeline starts
2. Downloads standard metadata from blob (cached, fast)
3. Deletes old custom metadata from blob
4. Extracts custom models from DevOps Git
5. Builds database (standard + new custom)
6. Uploads to blob
7. Restarts App Service

**Time:** ~5-15 minutes

**Commands:**
```bash
# Manual execution
az pipelines run --name "Quick Custom Update"
```

### Scenario 2: Standard Models Update (D365 Upgrade)

**Trigger:** Manual after D365 upgrade

**Process:**
1. Run full pipeline with parameter `extractionMode=all`
2. Extract all models (standard + custom)
3. Upload everything to blob
4. Rebuild database

**Time:** ~1-3 hours (depends on model count)

**Commands:**
```bash
# Manual execution
az pipelines run --name "Full Metadata Rebuild" --parameters extractionMode=all
```

### Scenario 3: Update Specific Custom Models

**Trigger:** Manual with parameters

**Process:**
1. Run with parameter `customModels=Model1,Model2`
2. Extract only specified models
3. Upload to blob

**Commands:**
```bash
az pipelines run --name "Quick Custom Update" --parameters customModels=ISV_Module1,ISV_Module2
```

## Azure Blob Storage Structure

```
xpp-metadata/
├── metadata/
│   ├── standard/
│   │   ├── ApplicationFoundation/
│   │   │   ├── classes/
│   │   │   │   ├── SysClass1.json
│   │   │   │   └── ...
│   │   │   ├── tables/
│   │   │   │   ├── SysTable1.json
│   │   │   │   └── ...
│   │   │   └── enums/
│   │   ├── ApplicationPlatform/
│   │   ├── ApplicationSuite/
│   │   └── ... (all standard models)
│   └── custom/
│       ├── ISV_Module1/
│       │   ├── classes/
│       │   ├── tables/
│       │   └── enums/
│       ├── ISV_Module2/
│       └── ... (custom models)
└── databases/
    └── xpp-metadata-latest.db
```

## Monitoring and Troubleshooting

### Pipeline Logs

Each pipeline stage logs:
- Number of processed files
- Number of extracted classes/tables/enums
- Parsing errors
- Duration

### Blob Storage Verification

```bash
# List all metadata
az storage blob list --account-name <account> --container-name xpp-metadata --prefix metadata/

# Check database
az storage blob show --account-name <account> --container-name xpp-metadata --name databases/xpp-metadata-latest.db

# Download for local testing
npm run blob-manager download-all
npm run build-database
```

### Local Testing

```bash
# 1. Download standard metadata
npm run blob-manager download-standard

# 2. Extract custom models locally
EXTRACT_MODE=custom CUSTOM_MODELS=ISV_Module1 npm run extract-metadata

# 3. Build database
npm run build-database

# 4. Test upload
npm run blob-manager upload-custom
npm run blob-manager upload-database ./data/xpp-metadata.db
```

## Performance Optimization

### Time Savings

| Operation | Before Optimization | After Optimization | Savings |
|---------|------------------|-----------------|---------|
| Daily update | 2-3 hours | 5-15 minutes | ~95% |
| Standard update | 2-3 hours | 2-3 hours | 0% (few times per year) |
| Database build | 10-20 minutes | 5-10 minutes | ~50% |

### Tips

1. **Cache Standard Metadata**: Never delete, only refresh on D365 upgrade
2. **Incremental Custom**: Only changed custom models
3. **Parallel Processing**: Pipeline uses artifacts for parallelization
4. **Redis Cache**: Optional, but recommended for production

## Costs

### Azure Resources

| Resource | Configuration | Monthly Cost |
|----------|---------------|--------------|
| Blob Storage | 500 MB (standard) + 50 MB (custom) | ~$1-2 |
| Pipeline Minutes | ~15 min/day × 30 = 450 min | Free (2000 min included) |
| App Service | P0v3 | ~$62 |
| **Total** | | **~$63-64/month** |

## Security

### Recommendations

1. **Connection Strings**: Always in Variable Groups as Secret
2. **RBAC**: Restrict pipeline access to dev team only
3. **Blob SAS**: Use SAS tokens instead of connection strings (optional)
4. **Git Permissions**: DevOps Git read-only for pipeline

### SAS Token Example

```bash
# Generate SAS token with read/write/delete permissions
az storage container generate-sas \
  --account-name <account> \
  --name xpp-metadata \
  --permissions rwdl \
  --expiry 2026-12-31 \
  --https-only
```

## Migration from Current Setup

### Step 1: Initial Standard Metadata Upload

```bash
# Extract all models for the first time
EXTRACT_MODE=all npm run extract-metadata

# Upload standard models
npm run blob-manager upload-standard

# Upload custom models
npm run blob-manager upload-custom

# Upload database
npm run build-database
npm run blob-manager upload-database ./data/xpp-metadata.db
```

### Step 2: Configure Azure Pipeline

1. Create new pipeline in Azure DevOps
2. Use `azure-pipelines-quick.yml`
3. Configure Variable Group
4. Test run (manually)

### Step 3: Verification

```bash
# Download and verify
npm run blob-manager download-all
npm run build-database

# Test MCP server locally
npm run dev
```

### Step 4: Production Deployment

1. Setup scheduler (daily at 2:00 AM UTC)
2. Monitor first 2-3 runs
3. Optimize as needed

## Support

For questions and issues:
- GitHub Issues: [dynamics365ninja/d365fo-mcp-server](https://github.com/dynamics365ninja/d365fo-mcp-server/issues)
- Documentation: [docs/](../docs/)

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [STANDARD_METADATA_NUGET.md](STANDARD_METADATA_NUGET.md) - NuGet package extraction setup
- [AZURE_BLOB_SETUP.md](AZURE_BLOB_SETUP.md) - Azure Blob Storage setup
- [AZURE_TROUBLESHOOTING.md](AZURE_TROUBLESHOOTING.md) - Troubleshooting guide
- [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) - Development environment
