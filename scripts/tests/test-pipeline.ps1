# Quick Test Script for Azure Pipeline Automation
# This script simulates the pipeline workflow locally for testing

Write-Host "🔧 D365FO MCP Server - Pipeline Test Script" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "❌ Error: .env file not found" -ForegroundColor Red
    Write-Host "Please create .env file with required configuration" -ForegroundColor Yellow
    exit 1
}

# Load environment variables
Write-Host "📋 Loading configuration..." -ForegroundColor Green
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $key = $matches[1].Trim()
        $value = $matches[2].Trim()
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

Write-Host "✅ Configuration loaded" -ForegroundColor Green
Write-Host ""

# Menu
Write-Host "Select operation:" -ForegroundColor Cyan
Write-Host "1. Test Custom Metadata Workflow (Quick Daily Update)" -ForegroundColor White
Write-Host "2. Test Full Metadata Extraction (All Models)" -ForegroundColor White
Write-Host "3. Upload Standard Metadata to Blob" -ForegroundColor White
Write-Host "4. Upload Custom Metadata to Blob" -ForegroundColor White
Write-Host "5. Download All Metadata from Blob" -ForegroundColor White
Write-Host "6. Delete and Re-extract Custom Metadata" -ForegroundColor White
Write-Host "7. Build Database Only" -ForegroundColor White
Write-Host "8. Full Pipeline Simulation (Standard + Custom)" -ForegroundColor White
Write-Host "9. Exit" -ForegroundColor White
Write-Host ""

$choice = Read-Host "Enter your choice (1-9)"

switch ($choice) {
    "1" {
        Write-Host "`n🚀 Testing Custom Metadata Workflow..." -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        
        # Step 1: Download standard metadata
        Write-Host "`n📥 Step 1: Download standard metadata from blob..." -ForegroundColor Yellow
        npm run blob-manager download-standard
        if ($LASTEXITCODE -ne 0) { 
            Write-Host "❌ Failed to download standard metadata" -ForegroundColor Red
            exit 1 
        }
        
        # Step 2: Delete local custom metadata
        Write-Host "`n🗑️  Step 2: Delete local custom metadata..." -ForegroundColor Yellow
        npm run blob-manager delete-local-custom
        
        # Step 3: Extract custom metadata
        Write-Host "`n📦 Step 3: Extract custom metadata..." -ForegroundColor Yellow
        $env:EXTRACT_MODE = "custom"
        npm run extract-metadata
        if ($LASTEXITCODE -ne 0) { 
            Write-Host "❌ Failed to extract custom metadata" -ForegroundColor Red
            exit 1 
        }
        
        # Step 4: Build database
        Write-Host "`n🔨 Step 4: Build database..." -ForegroundColor Yellow
        npm run build-database
        if ($LASTEXITCODE -ne 0) { 
            Write-Host "❌ Failed to build database" -ForegroundColor Red
            exit 1 
        }
        
        # Step 5: Upload custom metadata
        Write-Host "`n📤 Step 5: Upload custom metadata to blob..." -ForegroundColor Yellow
        npm run blob-manager delete-custom
        npm run blob-manager upload-custom
        
        # Step 6: Upload database
        Write-Host "`n📤 Step 6: Upload database to blob..." -ForegroundColor Yellow
        npm run blob-manager upload-database
        
        Write-Host "`n✅ Custom metadata workflow completed!" -ForegroundColor Green
    }
    
    "2" {
        Write-Host "`n🚀 Testing Full Metadata Extraction..." -ForegroundColor Cyan
        Write-Host "=======================================" -ForegroundColor Cyan
        
        # Extract all
        Write-Host "`n📦 Extracting all metadata..." -ForegroundColor Yellow
        $env:EXTRACT_MODE = "all"
        npm run extract-metadata
        
        # Build database
        Write-Host "`n🔨 Building database..." -ForegroundColor Yellow
        npm run build-database
        
        Write-Host "`n✅ Full extraction completed!" -ForegroundColor Green
    }
    
    "3" {
        Write-Host "`n📤 Uploading standard metadata to blob..." -ForegroundColor Cyan
        npm run blob-manager upload-standard
        Write-Host "`n✅ Upload completed!" -ForegroundColor Green
    }
    
    "4" {
        Write-Host "`n📤 Uploading custom metadata to blob..." -ForegroundColor Cyan
        npm run blob-manager upload-custom
        Write-Host "`n✅ Upload completed!" -ForegroundColor Green
    }
    
    "5" {
        Write-Host "`n📥 Downloading all metadata from blob..." -ForegroundColor Cyan
        npm run blob-manager download-all
        Write-Host "`n✅ Download completed!" -ForegroundColor Green
    }
    
    "6" {
        Write-Host "`n🔄 Delete and re-extract custom metadata..." -ForegroundColor Cyan
        Write-Host "===========================================" -ForegroundColor Cyan
        
        # Delete from blob
        Write-Host "`n🗑️  Step 1: Delete from blob..." -ForegroundColor Yellow
        npm run blob-manager delete-custom
        
        # Delete local
        Write-Host "`n🗑️  Step 2: Delete local..." -ForegroundColor Yellow
        npm run blob-manager delete-local-custom
        
        # Extract
        Write-Host "`n📦 Step 3: Extract..." -ForegroundColor Yellow
        $env:EXTRACT_MODE = "custom"
        npm run extract-metadata
        
        # Upload
        Write-Host "`n📤 Step 4: Upload..." -ForegroundColor Yellow
        npm run blob-manager upload-custom
        
        Write-Host "`n✅ Re-extraction completed!" -ForegroundColor Green
    }
    
    "7" {
        Write-Host "`n🔨 Building database..." -ForegroundColor Cyan
        npm run build-database
        Write-Host "`n✅ Build completed!" -ForegroundColor Green
    }
    
    "8" {
        Write-Host "`n🚀 Full Pipeline Simulation..." -ForegroundColor Cyan
        Write-Host "==============================" -ForegroundColor Cyan
        
        Write-Host "`n⚠️  This will:" -ForegroundColor Yellow
        Write-Host "   1. Extract ALL metadata (standard + custom)" -ForegroundColor White
        Write-Host "   2. Build database" -ForegroundColor White
        Write-Host "   3. Upload everything to blob" -ForegroundColor White
        Write-Host "   This can take 1-3 hours!" -ForegroundColor White
        Write-Host ""
        
        $confirm = Read-Host "Continue? (yes/no)"
        if ($confirm -ne "yes") {
            Write-Host "❌ Cancelled" -ForegroundColor Red
            exit 0
        }
        
        # Clean
        Write-Host "`n🧹 Step 1: Clean metadata directory..." -ForegroundColor Yellow
        if (Test-Path "extracted-metadata") {
            Remove-Item -Recurse -Force "extracted-metadata"
        }
        New-Item -ItemType Directory -Force -Path "extracted-metadata" | Out-Null
        
        # Extract all
        Write-Host "`n📦 Step 2: Extract all metadata..." -ForegroundColor Yellow
        $env:EXTRACT_MODE = "all"
        npm run extract-metadata
        
        # Build database
        Write-Host "`n🔨 Step 3: Build database..." -ForegroundColor Yellow
        npm run build-database
        
        # Upload all
        Write-Host "`n📤 Step 4: Upload all metadata..." -ForegroundColor Yellow
        npm run blob-manager upload-all
        
        # Upload database
        Write-Host "`n📤 Step 5: Upload database..." -ForegroundColor Yellow
        npm run blob-manager upload-database
        
        Write-Host "`n✅ Full pipeline simulation completed!" -ForegroundColor Green
    }
    
    "9" {
        Write-Host "`n👋 Goodbye!" -ForegroundColor Cyan
        exit 0
    }
    
    default {
        Write-Host "`n❌ Invalid choice" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "📊 Summary:" -ForegroundColor Cyan
Write-Host "  - Check logs above for any errors" -ForegroundColor White
Write-Host "  - Database location: $env:DB_PATH" -ForegroundColor White
Write-Host "  - Metadata location: $env:METADATA_PATH" -ForegroundColor White
Write-Host ""
