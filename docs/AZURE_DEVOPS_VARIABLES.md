# Azure DevOps Variable Configuration

This document lists all required variables for running the Azure Pipeline automation.

## Variable Group: `xpp-mcp-server-config`

Create a Variable Group in Azure DevOps with the following variables:

### Azure Storage (Required for all pipelines)

| Variable Name | Description | Example Value | Secret | Required |
|--------------|-------------|---------------|--------|----------|
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Blob Storage connection string | `DefaultEndpointsProtocol=https;AccountName=...` | ✅ Yes | ✅ Yes |
| `BLOB_CONTAINER_NAME` | Container name for metadata storage | `xpp-metadata` | ❌ No | ✅ Yes |

**How to get:**
```bash
# Get connection string from Azure Portal or CLI
az storage account show-connection-string \
  --name <storage-account-name> \
  --resource-group <resource-group-name> \
  --query connectionString -o tsv
```

### Custom Models Configuration (Required for custom/quick pipelines)

| Variable Name | Description | Example Value | Secret | Required |
|--------------|-------------|---------------|--------|----------|
| `CUSTOM_MODELS` | Comma-separated list of custom model names | `ISV_Module1,ISV_Module2,CustomExtensions` | ❌ No | ✅ Yes |
| `EXTENSION_PREFIX` | Prefix used for custom extensions | `ISV_` | ❌ No | ⚠️ Optional |

### Azure App Service (Required for restart stage)

| Variable Name | Description | Example Value | Secret | Required |
|--------------|-------------|---------------|--------|----------|
| `AZURE_SUBSCRIPTION` | Azure subscription service connection name | `My-Azure-Subscription` | ❌ No | ✅ Yes |
| `AZURE_APP_SERVICE_NAME` | Name of the App Service hosting MCP server | `d365fo-mcp-server` | ❌ No | ✅ Yes |

**How to set up:**
1. In Azure DevOps: Project Settings → Service Connections → New Service Connection
2. Choose "Azure Resource Manager"
3. Name it (e.g., "My-Azure-Subscription")
4. Use the name as `AZURE_SUBSCRIPTION` variable value

## Setup Instructions

### Step 1: Create Variable Group

1. Go to Azure DevOps → Pipelines → Library
2. Click "+ Variable group"
3. Name: `xpp-mcp-server-config`
4. Add all variables listed above

### Step 2: Mark Secrets

For sensitive variables (marked with ✅ in "Secret" column):
1. Click the padlock icon 🔒 next to the variable
2. This encrypts the value and hides it in logs

### Step 3: Grant Pipeline Access

1. Click "Pipeline permissions"
2. Add all three pipelines:
   - `azure-pipelines-standard-extract`
   - `azure-pipelines-quick`
   - `azure-pipelines` (full extraction)

### Step 4: Verify Configuration

Run this PowerShell script locally to verify your configuration:

```powershell
# Load from .env file (for local testing)
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $key = $matches[1].Trim()
        $value = $matches[2].Trim()
        Write-Host "$key = $value"
    }
}

# Check required variables
$required = @(
    'AZURE_STORAGE_CONNECTION_STRING',
    'BLOB_CONTAINER_NAME',
    'CUSTOM_MODELS'
)

foreach ($var in $required) {
    $value = [Environment]::GetEnvironmentVariable($var)
    if ($value) {
        Write-Host "✅ $var is set"
    } else {
        Write-Host "❌ $var is MISSING" -ForegroundColor Red
    }
}
```

## Pipeline-Specific Variables

### All Pipelines (Common)

```yaml
variables:
  - group: xpp-mcp-server-config  # Links to Variable Group
  - name: nodeVersion
    value: '22.x'
  - name: METADATA_PATH
    value: './extracted-metadata'
  - name: DB_PATH
    value: './data/xpp-metadata.db'
```

### Standard NuGet Extraction Pipeline

Additional variables (defined in YAML, no need to configure):

| Variable | Value | Purpose |
|----------|-------|---------|
| `NugetConfigsPath` | `$(Build.SourcesDirectory)/nuget-config` | NuGet config location |
| `NugetsPath` | `$(Build.SourcesDirectory)/nuget-packages` | Download location |
| `NugetsPathNoVer` | `$(Build.SourcesDirectory)/standard-packages` | Extracted packages |
| `ToolsPackage` | `Microsoft.Dynamics.AX.Platform.CompilerPackage` | Compiler package name |

### Custom Extraction Pipeline

Uses `PACKAGES_PATH` which is set to:
- Quick pipeline: `$(Pipeline.Workspace)/d365fo-source` (Git checkout)
- Full pipeline: `$(Pipeline.Workspace)/d365fo-source` (Git checkout)

## Environment-Specific Configuration

If you need different settings for dev/staging/production:

### Option 1: Multiple Variable Groups

Create separate variable groups:
- `xpp-mcp-server-config-dev`
- `xpp-mcp-server-config-staging`
- `xpp-mcp-server-config-prod`

Reference in pipeline:
```yaml
variables:
  - group: xpp-mcp-server-config-${{ parameters.environment }}
```

### Option 2: Environment Variables in Pipeline

Override specific variables per environment:
```yaml
- stage: Deploy
  variables:
    - group: xpp-mcp-server-config
    - name: AZURE_APP_SERVICE_NAME
      value: 'd365fo-mcp-server-prod'  # Override for prod
```

## Security Best Practices

### ✅ DO:
- ✅ Use Variable Groups for all sensitive data
- ✅ Mark connection strings as "Secret"
- ✅ Use Azure Service Connections for subscriptions
- ✅ Limit variable group access to specific pipelines only
- ✅ Rotate secrets regularly (every 90 days)

### ❌ DON'T:
- ❌ Commit secrets to repository
- ❌ Hard-code connection strings in YAML
- ❌ Share PAT tokens via email/chat
- ❌ Use production secrets in dev pipelines

## Troubleshooting

### Error: "Variable group 'xpp-mcp-server-config' could not be found"

**Solution:**
1. Verify Variable Group exists in Pipelines → Library
2. Check Variable Group name matches exactly (case-sensitive)
3. Grant pipeline access to Variable Group

### Error: "The term 'AZURE_STORAGE_CONNECTION_STRING' is not recognized"

**Solution:**
1. Variable is not set in Variable Group
2. Variable Group not linked to pipeline
3. Check for typos in variable name

### Error: "Access to the path is denied"

**Solution:**
1. Check Azure Storage connection string is valid
2. Verify storage account key hasn't been rotated
3. Test connection string locally:
```bash
az storage container list \
  --connection-string "YOUR_CONNECTION_STRING"
```

### Error: "Service connection does not exist"

**Solution:**
1. Create Azure Resource Manager service connection
2. Name must match `AZURE_SUBSCRIPTION` variable
3. Grant contributor access to App Service resource

## Validation Checklist

Before running pipelines, verify:

- [ ] Variable Group `xpp-mcp-server-config` created
- [ ] All required variables added
- [ ] Secrets marked with padlock icon 🔒
- [ ] Pipeline permissions granted
- [ ] Azure service connection configured
- [ ] Storage container exists (`xpp-metadata`)
- [ ] Custom models list is correct
- [ ] App Service name is correct
- [ ] NuGet config files created (for standard pipeline)

## Quick Start - Minimal Configuration

To run **quick custom update pipeline** (most common), you need:

```
Variable Group: xpp-mcp-server-config
├── AZURE_STORAGE_CONNECTION_STRING (secret) ✅
├── BLOB_CONTAINER_NAME = "xpp-metadata" ✅
├── CUSTOM_MODELS = "YourModel1,YourModel2" ✅
├── AZURE_SUBSCRIPTION = "Your-Service-Connection" ✅
└── AZURE_APP_SERVICE_NAME = "your-app-service" ✅
```

That's it! These 5 variables are enough to run the quick daily update pipeline.

## Advanced Configuration

### Redis Cache (Optional)

If using Redis for caching:

| Variable | Example |
|----------|---------|
| `REDIS_ENABLED` | `true` |
| `REDIS_URL` | `redis://:key@cache.redis.cache.windows.net:6380?ssl=true` |
| `CACHE_TTL` | `3600` |

### Rate Limiting (Optional)

Customize API rate limits:

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `900000` | 15 minutes |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |

## Example Variable Group Configuration

Here's a complete example screenshot of what your Variable Group should look like:

```
Name: xpp-mcp-server-config
Description: Configuration for X++ MCP Server pipelines

Variables:
┌─────────────────────────────────────┬───────────────────────┬────────┐
│ Name                                │ Value                 │ Secret │
├─────────────────────────────────────┼───────────────────────┼────────┤
│ AZURE_STORAGE_CONNECTION_STRING     │ DefaultEndpoints...   │   🔒   │
│ BLOB_CONTAINER_NAME                 │ xpp-metadata          │        │
│ CUSTOM_MODELS                       │ ISV_Module1,ISV_M...  │        │
│ EXTENSION_PREFIX                    │ ISV_                  │        │
│ AZURE_SUBSCRIPTION                  │ My-Azure-Subscript... │        │
│ AZURE_APP_SERVICE_NAME              │ d365fo-mcp-server     │        │
└─────────────────────────────────────┴───────────────────────┴────────┘

Pipeline permissions:
✅ azure-pipelines-standard-extract
✅ azure-pipelines-quick
✅ azure-pipelines
```

## Getting Help

If you encounter issues:
1. Check [AZURE_TROUBLESHOOTING.md](AZURE_TROUBLESHOOTING.md)
2. Verify all variables in checklist above
3. Test locally with `.env` file first
4. Check pipeline logs for specific error messages

## Related Documentation

- [AZURE_PIPELINE_AUTOMATION.md](AZURE_PIPELINE_AUTOMATION.md) - Pipeline overview
- [STANDARD_METADATA_NUGET.md](STANDARD_METADATA_NUGET.md) - NuGet setup
- [AZURE_BLOB_SETUP.md](AZURE_BLOB_SETUP.md) - Blob Storage setup
