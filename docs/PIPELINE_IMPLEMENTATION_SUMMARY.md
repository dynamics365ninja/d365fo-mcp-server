# Implementation Overview - Azure Pipeline Automation

## Implemented Changes

### 1. New Files

#### `scripts/azure-blob-manager.ts`
Comprehensive TypeScript script for managing metadata in Azure Blob Storage.

**Features:**
- Upload/download standard and custom metadata
- Delete custom metadata (blob and local)
- Upload/download compiled database
- Automatic detection of custom vs. standard models
- Hierarchical structure in blob storage

**Key Methods:**
- `uploadMetadata(type, models?)` - Upload metadata
- `downloadMetadata(type, models?)` - Download metadata
- `deleteCustomMetadata(models?)` - Delete custom metadata
- `uploadDatabase()` / `downloadDatabase()` - Database management

#### `azure-pipelines.yml`
Complete Azure DevOps pipeline with 5 stages:
1. **Prepare** - Download standard metadata
2. **ExtractCustom** - Extract custom models from Git
3. **BuildDatabase** - Build SQLite database
4. **UploadToBlob** - Upload to Azure Blob
5. **Deploy** - Deploy to Azure App Service

#### `azure-pipelines-quick.yml`
Optimized pipeline for daily updates:
- **QuickUpdate** - Fast custom models update (~5-15 min)
- **FullRebuild** - Complete rebuild when needed
- Scheduler: Daily at 2:00 AM UTC
- Parameterized execution

#### `scripts/test-pipeline.ps1`
PowerShell test script for local workflow testing:
- Interactive menu with 8 operations
- Pipeline step simulation
- Configuration validation

#### `docs/AZURE_PIPELINE_AUTOMATION.md`
Complete documentation:
- Problem description and solution
- System architecture
- Workflow scenarios
- Configuration and setup
- Monitoring and troubleshooting
- Optimization and costs

### 2. Modified Files

#### `package.json`
Added new script:
```json
"blob-manager": "tsx scripts/azure-blob-manager.ts"
```

#### `README.md`
- Added link to new documentation
- Updated related documentation list

### 3. Azure Blob Storage Structure

```
xpp-metadata/
├── metadata/
│   ├── standard/           # Standard D365 models
│   │   ├── ApplicationFoundation/
│   │   ├── ApplicationPlatform/
│   │   └── ... (500+ models)
│   └── custom/             # Custom/ISV models
│       ├── ISV_Module1/
│       ├── ISV_Module2/
│       └── ...
└── databases/
    └── xpp-metadata-latest.db
```

## Workflow

### Daily Automation (Custom Models)

```
1. Azure Pipeline Trigger (2:00 AM UTC daily)
   ↓
2. Download Standard Metadata from Blob (cached, fast)
   ↓
3. Delete Old Custom Metadata (blob + local)
   ↓
4. Extract Custom Models from DevOps Git
   ↓
5. Build Database (standard + new custom)
   ↓
6. Upload Custom Metadata + Database to Blob
   ↓
7. Restart App Service
```

**Time:** 5-15 minutes (instead of 2-3 hours)
**Savings:** ~95%

### Periodic Update (Standard Models)

```
1. Manual Trigger (few times per year)
   ↓
2. Clean All Metadata
   ↓
3. Extract ALL Models (standard + custom)
   ↓
4. Build Database
   ↓
5. Upload ALL to Blob
```

**Time:** 1-3 hours
**Frequency:** Few times per year (D365 upgrade, hotfix)

## Usage

### Local Testing

```powershell
# Interactive menu
.\scripts\test-pipeline.ps1

# Or directly
npm run blob-manager download-standard
npm run blob-manager upload-custom
npm run blob-manager delete-custom Model1,Model2
```

### Azure Pipeline

```bash
# Daily custom update (automatic)
# Runs by scheduler at 2:00 AM UTC

# Manual custom update execution
az pipelines run --name "Quick Custom Update"

# Manual full rebuild
az pipelines run --name "Full Metadata Rebuild" --parameters extractionMode=all

# Specific models
az pipelines run --name "Quick Custom Update" --parameters customModels=ISV_Module1,ISV_Module2
```

### Configuration

#### .env / Azure DevOps Variables

```env
# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
BLOB_CONTAINER_NAME=xpp-metadata

# Custom Models
CUSTOM_MODELS=ISV_Module1,ISV_Module2
EXTENSION_PREFIX=ISV_
EXTRACT_MODE=custom

# Paths
METADATA_PATH=./extracted-metadata
DB_PATH=./data/xpp-metadata.db
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory  # or DevOps Git path
```

#### Azure DevOps Variable Group

Create `xpp-mcp-server-config`:
- AZURE_STORAGE_CONNECTION_STRING (secret)
- BLOB_CONTAINER_NAME
- CUSTOM_MODELS
- EXTENSION_PREFIX
- AZURE_SUBSCRIPTION
- AZURE_APP_SERVICE_NAME

## Solution Benefits

### Performance
- ✅ **95% time savings** for daily updates
- ✅ **5-15 minutes** instead of 2-3 hours
- ✅ **Caching** of standard metadata

### Costs
- ✅ **Minimal** - Blob Storage ~$1-2/month
- ✅ **Free Pipeline** - 2000 minutes/month included
- ✅ **Efficient** use of computation time

### Flexibility
- ✅ **Separated** management of standard vs. custom
- ✅ **Incremental** updates
- ✅ **Parameterized** execution
- ✅ **Local testing**

### Automation
- ✅ **Daily scheduler** for custom models
- ✅ **Git integration** - automatic extraction from DevOps
- ✅ **Auto-restart** App Service after update
- ✅ **Monitoring** through Azure Pipeline logs

## Migration

### First Setup

1. **Extract all models for the first time:**
```bash
EXTRACT_MODE=all npm run extract-metadata
npm run blob-manager upload-all
npm run build-database
npm run blob-manager upload-database
```

2. **Setup Azure Pipeline:**
- Create Variable Group in Azure DevOps
- Import `azure-pipelines-quick.yml`
- Configure scheduler
- Test run

3. **Verification:**
```bash
npm run blob-manager download-all
npm run build-database
npm run dev  # Test MCP server
```

### Daily Operations

- Pipeline runs automatically every day at 2:00 AM UTC
- Processes only custom models
- Automatic App Service restart
- Monitoring through Azure DevOps

## Documentation

- **Main README**: [README.md](../README.md)
- **MCP Usage**: [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md)
- **Pipeline Automation**: [AZURE_PIPELINE_AUTOMATION.md](AZURE_PIPELINE_AUTOMATION.md)
- **Architecture**: [ARCHITECTURE.md](ARCHITECTURE.md)
- **Custom Extensions**: [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md)

## Support

For questions:
- GitHub Issues: [dynamics365ninja/d365fo-mcp-server](https://github.com/dynamics365ninja/d365fo-mcp-server/issues)
- Documentation: [docs/](../docs/)

## Status

✅ **Implemented and ready for deployment**

- ✅ Azure Blob Manager
- ✅ Azure Pipeline YAML
- ✅ Test scripts
- ✅ Documentation
- ✅ Integration into package.json
- ✅ README updated
