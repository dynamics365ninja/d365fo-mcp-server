# Azure Blob Storage Setup for SQLite Database

This guide explains how to create Azure Blob Storage, upload your SQLite database, and configure the MCP server to download it on startup.

## Overview

The D365 F&O MCP server uses a SQLite database containing indexed X++ metadata. Since Azure App Service has ephemeral storage, we store the database in Azure Blob Storage and download it on server startup.

## Prerequisites

- Azure subscription
- Azure CLI installed (`az`)
- SQLite database file (`xpp-metadata.db`) ready to upload
- PowerShell or Bash terminal

## Step 1: Create Storage Account

### Option A: Using Azure Portal

1. **Navigate to Azure Portal**
   - Go to https://portal.azure.com
   - Sign in with your Azure account

2. **Create Storage Account**
   - Click **+ Create a resource**
   - Search for **Storage account**
   - Click **Create**

3. **Configure Storage Account**
   - **Subscription**: Select your subscription
   - **Resource Group**: `d365fo-mcp-server` (or create new)
   - **Storage account name**: `d365fomcpdata` (must be globally unique)
   - **Region**: Same as your App Service (e.g., `West Europe`)
   - **Performance**: **Standard**
   - **Redundancy**: **Locally-redundant storage (LRS)**
   
4. **Review and Create**
   - Click **Review + create**
   - Click **Create**
   - Wait for deployment to complete

### Option B: Using Azure CLI

```powershell
# Login to Azure
az login

# Set your subscription (if you have multiple)
az account set --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133"

# Create resource group (if it doesn't exist)
az group create `
  --name "d365fo-mcp-server" `
  --location "westeurope"

# Create storage account
az storage account create `
  --name "d365fomcpdata" `
  --resource-group "d365fo-mcp-server" `
  --location "westeurope" `
  --sku "Standard_LRS" `
  --kind "StorageV2" `
  --access-tier "Hot"
```

## Step 2: Create Blob Container

### Option A: Using Azure Portal

1. **Navigate to Storage Account**
   - Go to your storage account (`d365fomcpdata`)
   - Click **Containers** in the left menu

2. **Create Container**
   - Click **+ Container**
   - **Name**: `xpp-databases`
   - **Public access level**: **Private** (no anonymous access)
   - Click **Create**

### Option B: Using Azure CLI

```powershell
# Get storage account key
$STORAGE_KEY = az storage account keys list `
  --account-name "d365fomcpdata" `
  --resource-group "d365fo-mcp-server" `
  --query "[0].value" `
  --output tsv

# Create container
az storage container create `
  --name "xpp-databases" `
  --account-name "d365fomcpdata" `
  --account-key $STORAGE_KEY `
  --public-access off
```

## Step 3: Upload SQLite Database

### Prerequisites

Build your database locally first:

```powershell
# Navigate to project directory
cd c:\Users\Admin7e00859cee\source\repos\d365fo-mcp-server

# Set environment variables (if needed)
$env:METADATA_PATH = "K:\AosService\PackagesLocalDirectory"
$env:MODEL_NAMES = "Foundation,ApplicationPlatform"

# Run metadata extraction
npm run index-metadata

# Verify database exists and has data
if (Test-Path "data\xpp-metadata.db") {
    $size = (Get-Item "data\xpp-metadata.db").Length / 1MB
    Write-Host "✓ Database created: $([math]::Round($size, 2)) MB"
} else {
    Write-Host "✗ Database not found"
}
```

### Upload Database

#### Option A: Using Azure Portal

1. **Navigate to Container**
   - Go to Storage Account → Containers → `xpp-databases`
   
2. **Upload File**
   - Click **Upload**
   - Click **Browse for files**
   - Select `data\xpp-metadata.db` from your project
   - Click **Upload**
   
3. **Verify Upload**
   - Confirm the file appears in the container
   - Note the file size

#### Option B: Using Azure CLI

```powershell
# Upload database
az storage blob upload `
  --account-name "d365fomcpdata" `
  --account-key $STORAGE_KEY `
  --container-name "xpp-databases" `
  --name "xpp-metadata.db" `
  --file "data\xpp-metadata.db" `
  --overwrite

Write-Host "✓ Database uploaded successfully"
```

#### Option C: Using Azure Storage Explorer

1. **Download Azure Storage Explorer**
   - https://azure.microsoft.com/features/storage-explorer/
   
2. **Connect to Account**
   - Open Storage Explorer
   - Sign in with your Azure account
   
3. **Upload File**
   - Navigate to: Storage Accounts → d365fomcpdata → Blob Containers → xpp-databases
   - Click **Upload** → **Upload Files**
   - Select `data\xpp-metadata.db`
   - Click **Upload**

## Step 4: Get Storage Connection String

### Option A: Using Azure Portal

1. **Navigate to Storage Account**
   - Go to `d365fomcpdata` storage account
   
2. **Get Connection String**
   - Click **Access keys** in the left menu
   - Under **key1**, click **Show** next to **Connection string**
   - Click **Copy** icon
   - Save this securely (you'll need it in Step 5)

### Option B: Using Azure CLI

```powershell
# Get connection string
$CONNECTION_STRING = az storage account show-connection-string `
  --name "d365fomcpdata" `
  --resource-group "d365fo-mcp-server" `
  --query "connectionString" `
  --output tsv

Write-Host "Connection String:"
Write-Host $CONNECTION_STRING
```

The connection string looks like:
```
DefaultEndpointsProtocol=https;AccountName=d365fomcpdata;AccountKey=YOUR_KEY_HERE;EndpointSuffix=core.windows.net
```

## Step 5: Configure App Service

Add the Azure Blob Storage settings to your App Service:

```powershell
# Set storage configuration
az webapp config appsettings set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --settings `
    AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=d365fomcpdata;AccountKey=YOUR_KEY;EndpointSuffix=core.windows.net" `
    BLOB_CONTAINER_NAME="xpp-databases" `
    BLOB_DATABASE_NAME="xpp-metadata.db" `
    DB_PATH="/tmp/xpp-metadata.db"
```

**Important**: Replace `YOUR_KEY` with your actual storage account key.

## Step 6: Verify Database Download on Startup

The MCP server will automatically download the database when it starts. Check the logs:

```powershell
# Stream logs
az webapp log tail `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server"
```

Expected output:
```
📥 Downloading database from Azure Blob Storage...
   Container: xpp-databases
   Blob: xpp-metadata.db
   Target: /tmp/xpp-metadata.db
✅ Database downloaded successfully (127.5 MB)
📚 Loading metadata from: /tmp/xpp-metadata.db
✅ Loaded 584799 symbols from database
```

## Step 7: Test the Server

```powershell
# Test health endpoint
Invoke-RestMethod -Uri "https://d365fo-mcp-server.azurewebsites.net/health"

# Expected response:
# {
#   "status": "healthy",
#   "service": "d365fo-mcp-server",
#   "version": "1.0.0",
#   "symbols": 584799
# }
```

## Updating the Database

When you need to update the database with new metadata:

```powershell
# 1. Extract new metadata locally
npm run index-metadata

# 2. Upload updated database
az storage blob upload `
  --account-name "d365fomcpdata" `
  --account-key $STORAGE_KEY `
  --container-name "xpp-databases" `
  --name "xpp-metadata.db" `
  --file "data\xpp-metadata.db" `
  --overwrite

# 3. Restart App Service to download new version
az webapp restart `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server"

# 4. Wait and verify
Start-Sleep -Seconds 30
Invoke-RestMethod -Uri "https://d365fo-mcp-server.azurewebsites.net/health"
```

## Alternative: Local Database (Development)

For local development, you don't need Azure Blob Storage:

```powershell
# In your .env file
DB_PATH=./data/xpp-metadata.db
# Don't set AZURE_STORAGE_CONNECTION_STRING

# Run locally
npm run dev
```

## Troubleshooting

### Issue: Database download fails

**Check**:
1. Connection string is correct
2. Container name is correct (`xpp-databases`)
3. Blob name is correct (`xpp-metadata.db`)
4. Storage account firewall rules allow Azure services

**Solution**:
```powershell
# Verify blob exists
az storage blob exists `
  --account-name "d365fomcpdata" `
  --account-key $STORAGE_KEY `
  --container-name "xpp-databases" `
  --name "xpp-metadata.db"

# Check App Service can access storage
az webapp config appsettings list `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --query "[?name=='AZURE_STORAGE_CONNECTION_STRING']"
```

### Issue: "No symbols found in database"

**Cause**: Database downloaded but is empty or corrupted

**Solution**:
```powershell
# Check local database has data
sqlite3 data\xpp-metadata.db "SELECT COUNT(*) FROM symbols;"

# If 0, re-extract metadata
npm run index-metadata

# Upload again
az storage blob upload `
  --account-name "d365fomcpdata" `
  --account-key $STORAGE_KEY `
  --container-name "xpp-databases" `
  --name "xpp-metadata.db" `
  --file "data\xpp-metadata.db" `
  --overwrite
```

### Issue: App Service times out during download

**Cause**: Large database takes too long to download

**Solutions**:
1. **Enable warm-up** (Premium tier required)
2. **Compress database** before upload
3. **Use smaller database** (index only essential models)

```powershell
# Option: Compress before upload
Compress-Archive -Path "data\xpp-metadata.db" -DestinationPath "data\xpp-metadata.db.zip"

# Upload compressed version
az storage blob upload `
  --account-name "d365fomcpdata" `
  --account-key $STORAGE_KEY `
  --container-name "xpp-databases" `
  --name "xpp-metadata.db.zip" `
  --file "data\xpp-metadata.db.zip" `
  --overwrite

# Update App Service config
az webapp config appsettings set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --settings BLOB_DATABASE_NAME="xpp-metadata.db.zip"
```

## Cost Considerations

### Storage Costs (as of 2024)
- **Storage**: ~$0.02 per GB per month (LRS, Hot tier)
- **Operations**: Minimal (download once per app restart)
- **Bandwidth**: First 100 GB outbound free per month

### Example Cost
- 200 MB database = ~$0.004/month
- 50 downloads/month = negligible
- **Total**: Less than $0.01/month

## Security Best Practices

1. **Use Private Container**: Never use public blob access
2. **Rotate Keys**: Periodically regenerate storage account keys
3. **Use Managed Identity** (recommended for production):

```powershell
# Enable managed identity for App Service
az webapp identity assign `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server"

# Grant access to storage
$PRINCIPAL_ID = az webapp identity show `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --query principalId `
  --output tsv

az role assignment create `
  --role "Storage Blob Data Reader" `
  --assignee $PRINCIPAL_ID `
  --scope "/subscriptions/YOUR_SUB_ID/resourceGroups/d365fo-mcp-server/providers/Microsoft.Storage/storageAccounts/d365fomcpdata"

# Update to use managed identity (no connection string needed)
az webapp config appsettings set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --settings `
    AZURE_STORAGE_ACCOUNT_NAME="d365fomcpdata" `
    BLOB_CONTAINER_NAME="xpp-databases" `
    BLOB_DATABASE_NAME="xpp-metadata.db" `
    USE_MANAGED_IDENTITY="true"
```

## Summary

✅ **Created** Azure Storage Account  
✅ **Created** Blob Container  
✅ **Uploaded** SQLite Database  
✅ **Configured** App Service Settings  
✅ **Verified** Database Downloads on Startup  

Your MCP server now has persistent, scalable database storage!
