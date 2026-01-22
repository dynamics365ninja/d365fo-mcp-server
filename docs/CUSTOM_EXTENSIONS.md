# Custom X++ Extensions Guide

This guide explains how to extract and index custom X++ extensions/ISV models.

## Configuration

Add to your `.env` file:

```env
# Standard D365 packages path
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory

# Custom models to extract (comma-separated)
CUSTOM_MODELS=ISV_CustomModule1,ISV_CustomModule2,CompanyExtensions

# Optional: Extension prefix for filtering
EXTENSION_PREFIX=ISV_

# Extraction mode: 'all' (standard + custom), 'standard', or 'custom'
EXTRACT_MODE=all
```

**Note**: The extraction process filters out Microsoft standard models using the list in `config/standard-models.json` (36 standard models).

## Extract Custom Extensions Only

To extract only your custom extension models:

```bash
# Set environment variables
$env:EXTRACT_MODE="custom"
$env:CUSTOM_MODELS="ISV_Module1,ISV_Module2"
$env:EXTENSION_PREFIX="ISV_"

# Run extraction
npm run extract-metadata

# Build database
npm run build-database
```

## Extract Everything

To extract both standard models and custom extensions:

```bash
$env:EXTRACT_MODE="all"
$env:CUSTOM_MODELS="ISV_Module1,ISV_Module2"

npm run extract-metadata
npm run build-database
```

## Search Custom Extensions

The server provides a dedicated tool for searching only in custom extensions:

### Tool: `xpp_search_extensions`

**Arguments:**
- `query` (required): Search term
- `prefix` (optional): Filter by extension prefix (e.g., "ISV_")
- `limit` (optional): Maximum results (default: 20)

**Example:**
```json
{
  "name": "xpp_search_extensions",
  "arguments": {
    "query": "CustomClass",
    "prefix": "ISV_",
    "limit": 10
  }
}
```

**Response:**
Results are grouped by custom model for easy identification.

## Benefits

1. **Separate Indexing**: Index custom extensions separately from standard models
2. **Faster Search**: Search only in your custom code
3. **Model Grouping**: Results grouped by custom model
4. **Prefix Filtering**: Filter by ISV/partner prefix
5. **Version Control**: Track only your custom models in source control

## Deployment

When deploying to Azure:

1. Extract custom models separately
2. Upload to Azure Blob Storage:
   ```bash
   az storage blob upload \
     --account-name <storage> \
     --container xpp-metadata \
     --name databases/custom-extensions.db \
     --file xpp-metadata.db
   ```

3. Update App Service configuration:
   ```bash
   az webapp config appsettings set \
     --resource-group <rg> \
     --name <app-name> \
     --settings BLOB_DATABASE_NAME=databases/custom-extensions.db
   ```

## Example Workflow

```bash
# 1. Extract standard models once
$env:EXTRACT_MODE="standard"
npm run extract-metadata
npm run build-database
mv xpp-metadata.db xpp-standard.db

# 2. Extract custom extensions regularly
$env:EXTRACT_MODE="custom"
$env:CUSTOM_MODELS="ISV_Sales,ISV_Inventory"
npm run extract-metadata
npm run build-database
mv xpp-metadata.db xpp-custom.db

# 3. Merge databases (or keep separate)
# Use xpp-custom.db for development, deploy both to Azure
```
