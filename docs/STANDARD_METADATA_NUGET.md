# Standard Metadata Extraction from NuGet Packages

This guide explains how to set up automatic extraction of standard D365 Finance & Operations metadata from Microsoft NuGet packages.

## Overview

Standard D365FO models (Application Platform, Application Suite, etc.) are distributed as NuGet packages. Instead of extracting from a local VM, you can download them directly from Microsoft's NuGet feed and extract the metadata.

**Benefits:**
- No need for local D365 VM
- Always get the latest version from Microsoft
- Automated quarterly updates
- Clean, version-controlled process

## Prerequisites

1. Azure DevOps account with pipeline access
2. Azure Blob Storage configured (see [AZURE_BLOB_SETUP.md](AZURE_BLOB_SETUP.md))
3. NuGet package feed access

## Setup Instructions

### Step 1: Create NuGet Configuration Folder

Create a `nuget-config` folder in your repository root:

```bash
mkdir nuget-config
cd nuget-config
```

### Step 2: Create latest.csproj

Create `nuget-config/latest.csproj` with the following content:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props" Condition="Exists('$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props')" />
  <ItemGroup>
      <!-- Application Modules -->
      <PackageReference Include="Microsoft.Dynamics.AX.Application1.DevALM.BuildXpp" Version="10.0.*" NoWarn="NU1701"/>
      <PackageReference Include="Microsoft.Dynamics.AX.Application2.DevALM.BuildXpp" Version="10.0.*" NoWarn="NU1701"/>
      <PackageReference Include="Microsoft.Dynamics.AX.ApplicationSuite.DevALM.BuildXpp" Version="10.0.*" NoWarn="NU1701"/>
      
      <!-- Platform -->
      <PackageReference Include="Microsoft.Dynamics.AX.Platform.DevALM.BuildXpp" Version="7.0.*" NoWarn="NU1701"/>
      
      <!-- Compiler Tools -->
      <PackageReference Include="Microsoft.Dynamics.AX.Platform.CompilerPackage" Version="7.0.*" NoWarn="NU1701"/>
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

**Important Notes:**
- `Version="10.0.*"` - Downloads latest 10.0.x version
- `Version="7.0.*"` - Downloads latest 7.0.x version (Platform)
- `NoWarn="NU1701"` - Suppresses .NET Framework compatibility warnings
- Update versions when upgrading D365 major versions

### Step 3: Create nuget.config

Create `nuget-config/nuget.config` to specify the NuGet feed:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <!-- Microsoft Official Feed -->
    <add key="dynamics365" value="https://pkgs.dev.azure.com/msazure/One/_packaging/Dynamics365PackageFeed/nuget/v3/index.json" />
    
    <!-- Alternative: Your organization's feed (if you mirror packages) -->
    <!-- <add key="myorg" value="https://pkgs.dev.azure.com/yourorg/_packaging/yourfeed/nuget/v3/index.json" /> -->
    
    <!-- NuGet.org as fallback -->
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
  
  <packageSourceCredentials>
    <dynamics365>
      <!-- Credentials configured in Azure DevOps pipeline -->
      <add key="Username" value="AzureDevOps" />
      <add key="ClearTextPassword" value="%SYSTEM_ACCESSTOKEN%" />
    </dynamics365>
  </packageSourceCredentials>
</configuration>
```

**Authentication Options:**

**Option A: Using System Access Token (Recommended for Azure DevOps)**
```xml
<add key="ClearTextPassword" value="%SYSTEM_ACCESSTOKEN%" />
```

**Option B: Using Personal Access Token (PAT)**
```xml
<add key="ClearTextPassword" value="YOUR_PAT_TOKEN" />
```

**Option C: Interactive (Local Development Only)**
```bash
# Login interactively
nuget.exe sources update -Name dynamics365 -Username your.email@company.com
```

### Step 4: Configure Azure DevOps Pipeline

Import the pipeline file `.azure-pipelines/azure-pipelines-standard-extract.yml` into Azure DevOps.

**Pipeline Configuration:**
1. Go to Azure DevOps → Pipelines → New Pipeline
2. Select "Existing Azure Pipelines YAML file"
3. Choose `.azure-pipelines/azure-pipelines-standard-extract.yml`
4. Save (don't run yet)

### Step 5: Configure Variable Group

Ensure your `xpp-mcp-server-config` Variable Group includes:

| Variable | Value | Secret |
|----------|-------|--------|
| AZURE_STORAGE_CONNECTION_STRING | `DefaultEndpoints...` | ✅ |
| BLOB_CONTAINER_NAME | `xpp-metadata` | ❌ |

### Step 6: Grant NuGet Feed Access (If Using Microsoft Feed)

If using Microsoft's official feed, you may need to request access:

1. Contact Microsoft Support or your CSA (Customer Success Account Manager)
2. Request access to Dynamics365PackageFeed
3. Alternative: Mirror packages to your own Azure Artifacts feed

## Running the Pipeline

### First Time Setup

```bash
# Run manually to extract initial standard metadata
az pipelines run --name "Standard Metadata Extraction"
```

Pipeline will:
1. Download latest NuGet packages (~2-5 GB)
2. Extract metadata XML files
3. Run extraction script (extract only standard models)
4. Upload to Azure Blob Storage `/metadata/standard/`

**Time:** ~30-60 minutes (first run with download)

### Scheduled Runs

The pipeline is configured to run quarterly:
- January 1
- April 1
- July 1
- October 1

This aligns with typical D365 update cycles.

### Manual Runs

Run manually when:
- D365 version upgraded
- Hotfix released
- New standard models added

```bash
az pipelines run --name "Standard Metadata Extraction"
```

## Package Structure

After extraction, packages are organized:

```
$(NugetsPathNoVer)/
├── net40/                           # Extracted metadata
│   ├── ApplicationFoundation/
│   │   ├── AxClass/
│   │   ├── AxTable/
│   │   └── AxEnum/
│   ├── ApplicationPlatform/
│   ├── ApplicationSuite/
│   └── ...
└── tools/                           # Compiler tools
    └── ... (compiler binaries)
```

## Troubleshooting

### Issue: NuGet Restore Fails

**Error:** `Unable to load the service index`

**Solution:**
1. Check network connectivity to NuGet feed
2. Verify credentials in nuget.config
3. Check Azure DevOps pipeline has access to feed
4. Try using PAT token instead of System Access Token

### Issue: Package Not Found

**Error:** `Unable to find package Microsoft.Dynamics.AX.Application1.DevALM.BuildXpp`

**Solution:**
1. Verify you have access to Microsoft's feed
2. Check version specification (10.0.* vs specific version)
3. Contact Microsoft for feed access

### Issue: Extraction Fails

**Error:** Metadata extraction produces no files

**Solution:**
1. Check `PACKAGES_PATH` points to correct location
2. Verify metadata XML files exist in net40 folder
3. Check logs for parsing errors
4. Ensure `EXTRACT_MODE=standard` is set

### Issue: Upload to Blob Fails

**Error:** Connection string invalid or container doesn't exist

**Solution:**
1. Verify `AZURE_STORAGE_CONNECTION_STRING` in Variable Group
2. Check `BLOB_CONTAINER_NAME` is correct
3. Ensure container exists in Azure Storage
4. Run `npm run blob-manager` locally to test

## Local Testing

Test the extraction process locally:

```powershell
# 1. Download packages
cd nuget-config
nuget.exe restore latest.csproj -ConfigFile nuget.config -OutputDirectory ../nuget-packages

# 2. Extract versions
cd ..
New-Item -ItemType Directory -Force -Path standard-packages/net40
Get-ChildItem -Path nuget-packages\*\*\ref\net40 -Recurse | Move-Item -Destination standard-packages/net40

# 3. Extract metadata
$env:PACKAGES_PATH = "standard-packages/net40"
$env:EXTRACT_MODE = "standard"
npm run extract-metadata

# 4. Upload to blob
npm run blob-manager upload-standard
```

## Version Management

### Updating D365 Version

When upgrading from 10.0.x to 10.0.y:

1. **Update latest.csproj** (if major version changes):
```xml
<!-- Change from 10.0.* to 10.1.* for example -->
<PackageReference Include="Microsoft.Dynamics.AX.Application1.DevALM.BuildXpp" Version="10.1.*" />
```

2. **Commit changes**:
```bash
git add nuget-config/latest.csproj
git commit -m "Update to D365 version 10.1.x"
git push
```

3. **Run pipeline**:
```bash
az pipelines run --name "Standard Metadata Extraction"
```

### Pinning to Specific Version

For reproducible builds, pin to exact versions:

```xml
<!-- Instead of 10.0.* -->
<PackageReference Include="Microsoft.Dynamics.AX.Application1.DevALM.BuildXpp" Version="10.0.1234.56" />
```

## Integration with Other Pipelines

### Workflow

```
1. Standard Extraction (Quarterly)
   ↓
2. Standard Metadata in Blob (Cached)
   ↓
3. Quick Custom Update (Daily)
   ↓ (downloads standard from blob)
4. Build Database (Standard + Custom)
   ↓
5. Upload Database to Blob
   ↓
6. Restart App Service
```

### Triggering Downstream Pipelines

After standard extraction completes, optionally trigger custom extraction:

```yaml
# Add to end of azure-pipelines-standard-extract.yml
- task: TriggerBuild@4
  displayName: 'Trigger custom metadata update'
  inputs:
    buildDefinition: 'Quick Custom Update'
    queueBuildForUserThatTriggeredBuild: true
```

## Cost Optimization

### NuGet Package Download

- First download: ~2-5 GB (~$0.10 data transfer)
- Subsequent downloads: Cached by NuGet (minimal cost)
- Quarterly schedule: ~$0.40/year for downloads

### Storage

- Standard metadata: ~500 MB
- Blob Storage cost: ~$0.01/month
- Total: ~$0.12/year

### Pipeline Minutes

- Standard extraction: ~30-60 minutes
- Quarterly: 4 runs/year = 120-240 minutes
- Azure DevOps: Free tier includes 1800 minutes/month

**Total Cost:** < $1/year for standard metadata automation

## Security Best Practices

1. **Never commit PAT tokens** to repository
2. **Use Variable Groups** for sensitive data
3. **Limit feed access** to pipeline service principal only
4. **Enable pipeline approval** for production runs
5. **Audit package versions** in compliance reports

## Related Documentation

- [AZURE_PIPELINE_AUTOMATION.md](AZURE_PIPELINE_AUTOMATION.md) - Main pipeline documentation
- [AZURE_BLOB_SETUP.md](AZURE_BLOB_SETUP.md) - Blob Storage setup
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) - Custom models configuration

## Support

For issues with:
- **NuGet packages**: Contact Microsoft Support
- **Pipeline configuration**: GitHub Issues
- **Blob Storage**: Azure Support
