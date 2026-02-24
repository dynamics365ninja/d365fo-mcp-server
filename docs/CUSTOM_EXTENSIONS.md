# Custom X++ Extensions Guide

This guide explains how to extract and index custom X++ extensions/ISV models.

## Configuration

### Traditional

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

**Note**: Custom models are defined in `CUSTOM_MODELS` environment variable. All other models are automatically considered Microsoft standard models. This approach automatically adapts to new D365 versions without maintaining a static list.

### UDE (Unified Developer Experience)

In UDE environments, custom models are **auto-detected** from the custom packages path (`ModelStoreFolder` in your XPP config). You do not need to set `CUSTOM_MODELS` — everything under the custom root is treated as custom, everything under the Microsoft root is standard.

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

## Benefits

1. **Separate Indexing**: Index custom extensions separately from standard models
2. **Faster Search**: Search only in your custom code
3. **Model Grouping**: Results grouped by custom model
4. **Prefix Filtering**: Filter by ISV/partner prefix
5. **Version Control**: Track only your custom models in source control