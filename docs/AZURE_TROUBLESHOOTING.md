# Azure App Service Troubleshooting Guide

## Fix "Container did not start within expected time limit" Error

### 1. Verify App Service Settings

```powershell
# Check current configuration
az webapp config show `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133"

# Check app settings
az webapp config appsettings list `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --output table
```

### 2. Update Critical Settings

```powershell
# Ensure correct startup file
az webapp config set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --startup-file "startup.sh"

# Set correct PORT (Azure uses 8080 by default)
az webapp config appsettings set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --settings `
    PORT="8080" `
    NODE_ENV="production" `
    WEBSITES_PORT="8080"

# Increase startup timeout
az webapp config set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --linux-fx-version "NODE|22-lts"
```

### 3. Check Deployment Package

Ensure your deployment includes:
- ✅ `dist/` folder (compiled TypeScript)
- ✅ `node_modules/` or `package.json` + `package-lock.json`
- ✅ `startup.sh` (executable)

```powershell
# Rebuild locally to verify
npm run build

# Check dist exists
Test-Path dist/index.js

# Make startup.sh executable (if on Linux/WSL)
# chmod +x startup.sh
```

### 4. View Live Logs

```powershell
# Stream application logs
az webapp log tail `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133"

# Or view in Azure Portal
# Portal -> App Service -> Monitoring -> Log stream
```

### 5. Manual Deployment Test

```powershell
# Rebuild and create clean deployment package
npm ci
npm run build

# Create deployment zip
Compress-Archive -Path dist, package.json, package-lock.json, startup.sh -DestinationPath deploy.zip -Force

# Deploy manually
az webapp deploy `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --src-path deploy.zip `
  --type zip

# Wait a moment, then check health
Start-Sleep -Seconds 30
curl https://d365fo-mcp-server.azurewebsites.net/health
```

### 6. Common Issues & Solutions

#### Issue: "node: not found"
**Solution:** Ensure Node.js runtime is set correctly
```powershell
az webapp config set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --linux-fx-version "NODE|22-lts"
```

#### Issue: "Cannot find module 'express'"
**Solution:** Include node_modules in deployment or use `npm ci` during build
```powershell
# In GitHub Actions, ensure this runs:
npm ci
npm run build
```

#### Issue: "EADDRINUSE: address already in use"
**Solution:** Check if PORT environment variable is set
```powershell
az webapp config appsettings set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --settings PORT="8080"
```

#### Issue: "Database not found"
**Solution:** Either:
1. Upload database to Azure Blob Storage, or
2. Set DB_PATH to a temporary location and seed empty database
```powershell
az webapp config appsettings set `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --settings DB_PATH="/tmp/xpp-metadata.db"
```

### 7. Enable Better Logging

```powershell
# Enable application logging
az webapp log config `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --application-logging filesystem `
  --level verbose `
  --web-server-logging filesystem

# Download logs
az webapp log download `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133" `
  --log-file app-logs.zip
```

### 8. Restart the App Service

```powershell
# Restart the app
az webapp restart `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133"

# Wait and test
Start-Sleep -Seconds 30
curl https://d365fo-mcp-server.azurewebsites.net/health
```

### 9. Expected Successful Output

When working correctly, logs should show:
```
🚀 Starting D365 F&O MCP Server...
   PORT: 8080
   NODE_ENV: production
🎯 Starting server...
🚀 Starting X++ MCP Code Completion Server...
💾 Initializing cache service...
⚠️  Redis cache disabled - running without cache
📚 Loading metadata from: /tmp/xpp-metadata.db
⚠️  No symbols found in database. Run indexing first:
✅ D365 F&O MCP Server listening on 0.0.0.0:8080
📡 MCP endpoint: http://localhost:8080/mcp
🏥 Health check: http://localhost:8080/health
```

### 10. Advanced: SSH into Container (if needed)

```powershell
# Enable SSH
az webapp create-remote-connection `
  --name "d365fo-mcp-server" `
  --resource-group "d365fo-mcp-server" `
  --subscription "f63e3637-d0eb-444d-9999-66cc3d0ce133"

# Then connect via Portal -> SSH
# Or use: az webapp ssh
```

## Quick Fix Checklist

- [ ] Run `npm run build` locally to verify it works
- [ ] Ensure `startup.sh` is included in deployment
- [ ] Set `PORT=8080` in App Service settings
- [ ] Set `WEBSITES_PORT=8080` in App Service settings
- [ ] Verify `NODE|22-lts` runtime is configured
- [ ] Check deployment package includes `dist/` folder
- [ ] Review application logs for errors
- [ ] Restart the App Service
- [ ] Test health endpoint after 30 seconds

## Still Not Working?

1. Check GitHub Actions workflow logs
2. Verify deployment artifact was created
3. Download and inspect deployment.zip contents
4. Check Azure Portal -> Deployment Center for deployment status
5. Review Diagnose and solve problems in Azure Portal
