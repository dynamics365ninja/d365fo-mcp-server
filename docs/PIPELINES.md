# Azure Pipelines - Automation Guide

Complete guide for Azure DevOps pipeline automation of D365FO metadata extraction and deployment.

## Table of Contents

- [Overview](#overview)
- [Pipeline Architecture](#pipeline-architecture)
- [Pipeline Configurations](#pipeline-configurations)
- [Workflow Scenarios](#workflow-scenarios)
- [Monitoring and Maintenance](#monitoring-and-maintenance)

<!-- AUTO-GENERATED MARKER: DO NOT EDIT BELOW THIS LINE MANUALLY -->

---

## Overview

### Problem Statement

Manual metadata extraction and database builds are time-consuming:
- Full extraction: 2-3 hours
- Database build: 30-60 minutes
- Manual deployment required
- Risk of human error

### Solution

Four automated pipelines covering the full lifecycle — from application deployment to metadata extraction:

1. **d365fo-mcp-app-deploy** — Deploy MCP Server app to Azure App Service (auto-trigger on `main`)
2. **d365fo-mcp-data-extract-and-build-custom** — Custom model updates from Git source (~15-30 min, manual)
3. **d365fo-mcp-data-extract-and-build-platform** — Standard metadata from PackagesLocalDirectory.zip (~60-120 min, manual)
4. **d365fo-mcp-data-platform-upgrade** — Complete D365 version upgrade: standard + custom + labels (~90-120 min, manual)

### Benefits

- ⚡ **Fast custom updates** — Custom models in 15-30 minutes (vs 2-3 hours full extraction)
- 📊 **Separation of concerns** — Standard vs custom metadata, app code vs data
- 💰 **Cost optimization** — Pay only for what you update
- 🛡️ **Reliable** — Consistent, repeatable automated process
- 🎯 **Flexible** — `skipExtraction` parameter lets you rebuild DB without re-extracting

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
│   │   └── ... (350+ models)
│   └── custom/             # Your models (updated on demand)
│       ├── YourModel1/
│       ├── YourModel2/
│       └── ...
└── database/
    ├── xpp-metadata.db          # Symbols database (~2–3 GB without/with UnitTest models)
    └── xpp-metadata-labels.db   # Labels database (~500 MB for 4 languages)
```

### Pipeline Flow

```
┌──────────────────────────────────────────────────────────────┐
│  d365fo-mcp-app-deploy                                        │
│  Auto-trigger: push to main (src/**, package.json, …)        │
│  → TypeScript compile → zip with node_modules → App Service  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  d365fo-mcp-data-extract-and-build-custom  (manual)          │
│  1. Checkout D365FO source (Azure DevOps)                    │
│  2. Checkout MCP Server (GitHub)                             │
│  3. Download existing DB (custom mode) OR std metadata       │
│  4. Extract custom models from Git source                    │
│  5. Build database (incremental — standard already indexed)  │
│  6. Upload metadata + symbols DB + labels DB                 │
│  7. Restart App Service                                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  d365fo-mcp-data-extract-and-build-platform  (manual)        │
│  1. Download PackagesLocalDirectory.zip from Blob            │
│  2. Extract zip → extract standard metadata                  │
│  3. Upload standard metadata to blob                         │
│  4. Build database (standard only, with labels)              │
│  5. Upload symbols DB + labels DB                            │
│  6. Restart App Service                                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  d365fo-mcp-data-platform-upgrade  (manual)                  │
│  1. Download PackagesLocalDirectory.zip from Blob            │
│  2. Extract zip → extract standard metadata → upload blob    │
│  3. Download custom metadata from blob                       │
│  4. Build DB (symbols + labels, SKIP_FTS=true)               │
│  5. Rebuild FTS index separately                             │
│  6. Upload symbols DB + labels DB                            │
│  7. Restart App Service                                      │
└──────────────────────────────────────────────────────────────┘
```

---

## Pipeline Configurations

### 1. d365fo-mcp-app-deploy.yml — Deploy Application

**Purpose:** Compile TypeScript, package the application, and deploy to Azure App Service.

**Trigger:**
- Automatic on push to `main` branch when any of the following paths change:
  `src/**`, `package.json`, `package-lock.json`, `startup.sh`, `tsconfig.json`,
  `.azure-pipelines/d365fo-mcp-app-deploy.yml`

**No parameters.**

**Process:**
1. Checkout MCP Server from GitHub
2. Install Node.js 24.x
3. `npm ci` — compiles `better-sqlite3` native addon for Node 24 / Linux (ubuntu-latest matches App Service glibc)
4. `npm run build` — TypeScript compile → `dist/`
5. Archive everything (including pre-built `node_modules`) into `app.zip`
6. Publish artifact
7. Set App Service settings (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`, `MCP_SERVER_MODE=read-only`)
8. Deploy zip via Zip Deploy
9. Poll `/health` every 15 s for up to 10 minutes until HTTP 200 (app downloads DB from Blob on cold start — typically 2–5 min)

**When to Use:**
- Every merge to `main` — triggered automatically
- Manual re-deploy after infrastructure changes

**Execution Time:** ~5-10 minutes

**Agent:** ubuntu-latest

---

### 2. d365fo-mcp-data-extract-and-build-custom.yml — Custom Metadata Update

**Purpose:** Fast updates of custom models from the Azure DevOps Git repository.

**Trigger:** Manual only (`trigger: none`)

**Parameters:**

| Parameter | Type | Default | Values |
|-----------|------|---------|--------|
| `extractionMode` | string | `custom` | `custom`, `standard`, `all` |
| `customModels` | string | `all` | comma-separated model names or `all` |
| `skipExtraction` | boolean | `false` | `true` = rebuild DB from existing blob metadata without Git extraction |

**Source Code Checkouts:**
1. D365FO source code from Azure DevOps (`checkout: self`) — location: `$(Build.SourcesDirectory)`
   - Contains D365FO metadata at the path configured in `PACKAGES_PATH` pipeline variable
2. MCP Server from GitHub (`dynamics365ninja/d365fo-mcp-server`) — location: `$(Pipeline.Workspace)/mcp-server`

**Process (custom mode, skipExtraction=false — default):**
1. Checkout D365FO source + MCP Server
2. Install Node.js 24.x + `npm ci`
3. Download existing symbols DB from blob (preserves already-indexed standard models)
4. Delete old custom metadata from blob
5. Extract custom models from Git source (`PACKAGES_PATH` env var)
6. Build database incrementally (standard stays in DB; custom models replaced)
7. Upload custom metadata to blob (`metadata/custom/`)
8. Upload symbols DB + labels DB to blob
9. Restart App Service

**Process (skipExtraction=true):**
- Skips steps 4–5 (delete blob, Git extraction) and step 7 (upload metadata)
- Downloads standard metadata from blob via **azcopy** (massively parallel)
- Downloads custom metadata from blob via **azcopy**
- Downloads existing labels DB from blob (no `PACKAGES_PATH` available)
- Rebuilds database from blob metadata only

**Process (standard / all mode):**
- Downloads standard metadata from blob via **azcopy** instead of downloading the DB
- Extracts standard or all models from Git source
- Builds database from scratch

**Memory Configuration:**
```yaml
NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc'
ENABLE_SEARCH_SUGGESTIONS: 'false'
```

**When to Use:**
- After committing changes to custom D365FO models
- Targeted update: set `customModels: "YourModel"`
- DB rebuild without re-extraction: `skipExtraction: true`

**Execution Time:** ~15-30 minutes (custom mode, default)

**Agent:** ubuntu-latest

---

### 3. d365fo-mcp-data-extract-and-build-platform.yml — Standard Metadata Extraction

**Purpose:** Extract Microsoft standard models from `PackagesLocalDirectory.zip` and build the standard database (symbols + labels).

**Trigger:** Manual only (`trigger: none`)

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `skipExtraction` | boolean | `false` | `true` = skip zip download/extraction, rebuild DB from existing blob metadata |

**Process (skipExtraction=false — default):**
1. Checkout MCP Server from GitHub
2. Install Node.js 24.x + `npm ci`
3. Download `PackagesLocalDirectory.zip` from blob (container: `packages`)
4. Extract zip
5. Extract standard metadata (`EXTRACT_MODE: standard`)
6. Upload standard metadata to blob (`metadata/standard/`)
7. Build database from standard metadata (with labels, `INCLUDE_LABELS: true`)
8. Upload symbols DB + labels DB to blob
9. Restart App Service

**Process (skipExtraction=true):**
- Skips steps 3–6
- Downloads standard metadata from blob via **azcopy**
- Downloads existing labels DB from blob
- Rebuilds database without re-extracting

**Memory Configuration:**
```yaml
NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc'
ENABLE_SEARCH_SUGGESTIONS: 'false'
COMPUTE_STATS: 'true'
```

**When to Use:**
- After D365 platform/application hotfix or new version
- When `PackagesLocalDirectory.zip` is updated in blob storage
- `skipExtraction: true` when zip is unchanged but DB needs rebuilding

**Execution Time:** ~60-120 minutes (full extraction; `skipExtraction` saves ~30-60 min)

**Agent:** ubuntu-latest / Timeout: 120 minutes

---

### 4. d365fo-mcp-data-platform-upgrade.yml — Complete Platform Upgrade

**Purpose:** Full D365 version upgrade — standard + custom metadata + FTS index, all in one run with service restart.

**Trigger:** Manual only (`trigger: none`)

**No parameters.**

**Process:**
1. Checkout MCP Server from GitHub
2. Install Node.js 24.x + `npm ci`
3. Download `PackagesLocalDirectory.zip` from blob (container: `packages`)
4. Extract zip
5. Extract standard metadata
6. Upload standard metadata to blob (`metadata/standard/`)
7. Download custom metadata from blob (`metadata/custom/`)
8. Build database — symbols + labels (`SKIP_FTS: true`, `INCLUDE_LABELS: true`, 4 GB heap)
9. Rebuild FTS index separately (`npm run build-fts`)
10. Upload symbols DB + labels DB to blob
11. Restart App Service

> **Why two DB steps?** Building symbols + labels + FTS in a single pass risks hitting memory limits on the hosted agent. Splitting FTS into a dedicated step keeps each pass within the 4 GB heap.

**Memory Configuration:**
```yaml
# Step 8 (symbols + labels, no FTS)
NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc'
SKIP_FTS: 'true'
INCLUDE_LABELS: 'true'

# Step 9 (FTS only)
NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc'
INCLUDE_LABELS: 'false'
```

**Key Notes:**
- Requires pre-existing custom metadata in blob (run custom pipeline first if needed)
- Restarts App Service — brief production impact (~30 sec)
- Custom metadata is downloaded from blob, **not** re-extracted from Git source

**When to Use:**
- After Microsoft releases a new D365 version
- When both standard and custom metadata need refreshing in one shot

**Execution Time:** ~90-120 minutes

**Agent:** ubuntu-latest / Timeout: 120 minutes

---

## Workflow Scenarios

### Scenario 1: Custom Code Change

**Situation:** You committed changes to custom D365FO models and want MCP updated.

**Pipeline:** `d365fo-mcp-data-extract-and-build-custom`

1. Navigate to Pipelines → `d365fo-mcp-data-extract-and-build-custom`
2. Click **Run pipeline**
3. Keep defaults: `extractionMode: custom`, `customModels: all`, `skipExtraction: false`
4. Wait ~15-30 minutes

**Result:** Updated custom metadata and database deployed to App Service.

---

### Scenario 2: Specific Model Update

**Situation:** Changed only `YourCustomModel2`, want a targeted (faster) update.

**Pipeline:** `d365fo-mcp-data-extract-and-build-custom`

1. Click **Run pipeline**
2. Set `customModels: YourCustomModel2`
3. Wait ~5-10 minutes

**Result:** Only `YourCustomModel2` updated in metadata and database.

---

### Scenario 3: Rebuild DB Without Re-extraction

**Situation:** DB is corrupted or you want a fresh rebuild without changing source.

**Pipeline:** `d365fo-mcp-data-extract-and-build-custom` or `d365fo-mcp-data-extract-and-build-platform`

1. Click **Run pipeline**
2. Set `skipExtraction: true`

**Result:** Fresh database from existing blob metadata; no Git checkout of D365FO source needed.

---

### Scenario 4: D365 Platform / Hotfix Update

**Situation:** Microsoft released a new D365 application update. You have a new `PackagesLocalDirectory.zip`.

**Recommended (Standard Only First):**
1. Upload new `PackagesLocalDirectory.zip` to blob (container: `packages`)
2. Run `d365fo-mcp-data-extract-and-build-platform` (~60-120 min)
3. Optionally run `d365fo-mcp-data-extract-and-build-custom` if custom models also changed

**Alternative (Complete Upgrade in One Run):**
1. Upload `PackagesLocalDirectory.zip` to blob
2. Run `d365fo-mcp-data-extract-and-build-custom` first if custom models changed
3. Run `d365fo-mcp-data-platform-upgrade` (~90-120 min) — standard + custom + FTS in one step

**Result:** Latest Microsoft metadata + your custom models deployed to production.

---

### Scenario 5: New Project Setup

**Situation:** Setting up the MCP server for the first time.

1. Configure variable group `xpp-mcp-server-config` in Azure DevOps (see [SETUP.md](SETUP.md))
2. Upload `PackagesLocalDirectory.zip` to blob storage (container: `packages`)
3. Run `d365fo-mcp-data-extract-and-build-platform` for standard models (~60-120 min)
4. Run `d365fo-mcp-data-extract-and-build-custom` for initial custom extraction (~15-30 min)
5. Run `d365fo-mcp-data-platform-upgrade` to combine and deploy complete database (~90-120 min)
6. Push a commit to `main` — `d365fo-mcp-app-deploy` auto-deploys the app

**Result:** Complete setup with all metadata and database deployed.

---

### Scenario 6: App Code Change

**Situation:** You changed MCP Server TypeScript code (e.g. fixed a bug, added a tool).

**Pipeline:** `d365fo-mcp-app-deploy` — **triggers automatically** on push to `main`.

No manual action needed. Monitor the pipeline run and the `/health` poll step at the end.

---

## Monitoring and Maintenance

### Pipeline Monitoring

**Azure DevOps Portal:**
1. Navigate to **Pipelines** → **All pipelines**
2. Check last run status and execution time trends
3. Set up email notifications for failures

**Expected Execution Times:**

| Pipeline | Typical Duration |
|----------|----------------|
| d365fo-mcp-app-deploy | 5-10 min |
| d365fo-mcp-data-extract-and-build-custom | 15-30 min |
| d365fo-mcp-data-extract-and-build-platform | 60-120 min |
| d365fo-mcp-data-platform-upgrade | 90-120 min |

### Memory Management

All data pipelines use memory-optimized settings:

```yaml
NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc'  # 4 GB heap
ENABLE_SEARCH_SUGGESTIONS: 'false'   # saves ~800 MB–1.5 GB during build
```

**Settings Explanation:**
- `ENABLE_SEARCH_SUGGESTIONS=false` — disables term relationship graph during build; not needed in CI/CD
- `--max-old-space-size=4096` — 4 GB heap (hosted agents have 14 GB RAM)
- `--expose-gc` — enables manual GC calls during large object processing
- Platform upgrade splits DB build into two steps (symbols+labels first, FTS second) to avoid peak memory spikes

**⚠️ If Pipeline Fails with "heap out of memory":**
1. Confirm `ENABLE_SEARCH_SUGGESTIONS=false` is set
2. Confirm `NODE_OPTIONS` contains `--max-old-space-size=4096`
3. For platform upgrade: confirm FTS rebuild is in a separate step (already the case)
4. Reduce scope with `customModels` parameter

### Cost Optimization

**Compute Costs (Azure Pipeline Minutes):**

| Pipeline | Trigger | Frequency | Duration | Est. Monthly Cost |
|----------|---------|-----------|----------|------------------|
| d365fo-mcp-app-deploy | Auto (main push) | ~5-10/month | ~8 min | ~$0.10 |
| d365fo-mcp-data-extract-and-build-custom | Manual | ~5-15/month | ~25 min | ~$0.50 |
| d365fo-mcp-data-extract-and-build-platform | Manual | ~1-4/quarter | ~90 min | ~$1-2/year |
| d365fo-mcp-data-platform-upgrade | Manual | ~1-4/year | ~110 min | ~$1-2/year |

**Storage Costs:**
- Standard metadata: ~2-3 GB → ~$0.04/month
- Custom metadata: <1 GB → ~$0.01/month
- Symbols DB: ~2-3 GB → ~$0.04/month
- Labels DB: ~500 MB → ~$0.01/month
- `PackagesLocalDirectory.zip`: ~5-10 GB → ~$0.10-0.20/month
- **Total: ~$0.20-0.30/month**

**Optimization Tips:**
1. Use `customModels` parameter to limit extraction scope
2. Use `skipExtraction: true` when only a DB rebuild is needed
3. Clean old blob versions periodically
4. Monitor pipeline execution times for regressions

### Maintenance Tasks

#### Weekly
- ✅ Check pipeline success rate
- ✅ Review execution times for anomalies

#### Monthly
- ✅ Verify database size (~2.5–3.5 GB total: ~2–3 GB symbols + ~500 MB labels)
- ✅ Check blob storage usage
- ✅ Review App Service metrics

#### Quarterly
- ✅ Verify `PackagesLocalDirectory.zip` is current in blob storage
- ✅ Run `d365fo-mcp-data-extract-and-build-platform` after D365 updates
- ✅ Review and optimize custom models list

#### Yearly
- ✅ Audit Azure costs
- ✅ Review pipeline configurations
- ✅ Update Node.js version in pipeline YAML if needed (currently: `24.x`)

### Troubleshooting

#### Pipeline Fails: "Cannot find variable group"

```
1. Go to Pipelines → Library
2. Check "xpp-mcp-server-config" group exists
3. Verify it is linked to the pipeline security settings
```

#### Pipeline Fails: "Blob not found" (data pipeline)

```
1. Ensure PackagesLocalDirectory.zip is uploaded to blob container "packages"
2. Run d365fo-mcp-data-extract-and-build-platform first to populate metadata/standard/
3. Verify metadata/standard/ folder exists in blob before running custom or upgrade pipelines
```

#### Pipeline Fails: "PACKAGES_PATH not found" (custom pipeline)

```
1. Check PACKAGES_PATH variable in pipeline YAML points to the correct path inside the Git repo
2. Verify the D365FO source repository contains metadata at that path
3. Use skipExtraction: true to bypass Git extraction temporarily
```

#### App Service Health Check Fails After Deploy

```
1. Check App Service logs: az webapp log tail --name <app-name> --resource-group <rg>
2. App downloads DB from blob on cold start — can take 2–5 min; 10 min timeout is intentional
3. Verify AZURE_STORAGE_CONNECTION_STRING and BLOB_CONTAINER_NAME in App Service config
4. Check /health endpoint manually in browser
```

#### Slow Extraction

```
1. Specify exact models with customModels parameter instead of "all"
2. Check Git repository size and agent disk space
3. Use skipExtraction: true for a DB-only rebuild
```

---

## Best Practices

### 1. Use the Right Pipeline

| Situation | Pipeline |
|-----------|----------|
| Custom model code change | `d365fo-mcp-data-extract-and-build-custom` |
| D365 hotfix / new version (standard only) | `d365fo-mcp-data-extract-and-build-platform` |
| Full D365 version upgrade (std + custom) | `d365fo-mcp-data-platform-upgrade` |
| DB rebuild (no code change) | Any data pipeline with `skipExtraction: true` |
| App code change | `d365fo-mcp-app-deploy` (auto-triggered) |

### 2. Parameterize Targeted Updates

- Use `customModels: "YourModel1,YourModel2"` for targeted extraction
- Use `skipExtraction: true` when no source change is needed (faster)

### 3. Run Standard Before Upgrade

Always run `d365fo-mcp-data-extract-and-build-platform` **before** `d365fo-mcp-data-platform-upgrade`
so that the latest standard metadata is in blob storage for the upgrade to consume.

### 4. Security

- Store secrets in variable group `xpp-mcp-server-config`
- Use Azure Key Vault for sensitive connection strings
- Limit pipeline service connection permissions to the minimum required
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
- Test scripts locally with `scripts/tests/test-pipeline.ps1`

GitHub Issues: https://github.com/dynamics365ninja/d365fo-mcp-server/issues
