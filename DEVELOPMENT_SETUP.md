# Development Setup Guide

This guide helps you set up the X++ MCP Server for local development.

## Prerequisites

- **Node.js 22+** installed
- **D365 Finance & Operations** environment access
- **Visual Studio with D365 development tools** (for metadata extraction)
- **Git** installed
- **(Optional)** Redis for caching

## Step-by-Step Setup

### 1. Clone and Install

```powershell
# Clone the repository
git clone https://github.com/yourusername/d365fo-mcp-server.git
cd d365fo-mcp-server

# Install dependencies
npm install

# Build TypeScript
npm run build
```

### 2. Configure Environment Variables

```powershell
# Copy example environment file
Copy-Item .env.example .env

# Edit .env with your settings
notepad .env
```

### 3. Get D365 Azure AD Credentials

#### Create App Registration in Azure Portal

1. **Go to Azure Portal** → [portal.azure.com](https://portal.azure.com)
2. **Azure Active Directory** → **App registrations** → **New registration**
3. **Name**: `D365FO-MCP-Server-Dev`
4. **Supported account types**: Accounts in this organizational directory only
5. **Click Register**

#### Get Tenant ID
- **Location**: Azure AD → Overview
- **Copy**: Directory (tenant) ID
- **Add to `.env`**: `D365_TENANT_ID=your-tenant-id`

#### Get Client ID
- **Location**: Your app registration → Overview
- **Copy**: Application (client) ID
- **Add to `.env`**: `D365_CLIENT_ID=your-client-id`

#### Create Client Secret
- **Location**: Your app registration → Certificates & secrets
- **Click**: New client secret
- **Description**: `MCP-Server-Dev`
- **Expires**: 12 months (or as per policy)
- **Copy the Value** (only shown once!)
- **Add to `.env`**: `D365_CLIENT_SECRET=your-client-secret`

#### Grant API Permissions
1. Your app registration → **API permissions**
2. **Add a permission** → **Dynamics ERP**
3. Select **Delegated permissions** or **Application permissions**
4. Add: `AX.FullAccess`, `Odata.FullAccess`, `mcp.tools`
5. **Grant admin consent** (requires admin rights)

### 4. Configure D365 Environment URLs

Find your D365 environment URL:
- **D365 Portal**: https://lcs.dynamics.com
- **Environment details** → Copy base URL
- Example: `https://mycompany.operations.dynamics.com`

Update `.env`:
```env
D365_RESOURCE_URL=https://your-environment.operations.dynamics.com
ODATA_ENDPOINT=https://your-environment.operations.dynamics.com/data
```

### 5. Extract X++ Metadata

#### Option A: From D365 Development VM

If you have access to a D365 development VM:

```powershell
# Set packages path (where D365 models are installed)
# Update in .env:
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory
METADATA_PATH=./metadata
MODEL_NAMES=YourCustomModel1,YourCustomModel2,ApplicationSuite

# Run extraction script
npm run extract-metadata
```

This will:
- Read XML files from `PackagesLocalDirectory`
- Extract class definitions, methods, tables, enums
- Save to `./metadata` directory

#### Option B: From Production/Sandbox Environment

If you don't have VM access, you can query metadata via OData:

```powershell
# This feature is under development
# For now, use VM-based extraction or request metadata export
```

### 6. Build SQLite Database

After extracting metadata:

```powershell
# Index metadata into SQLite
npm run build-database

# This creates: ./data/xpp-metadata.db
```

Verify database was created:
```powershell
# Check file exists
Test-Path ./data/xpp-metadata.db

# View database stats (requires sqlite3)
sqlite3 ./data/xpp-metadata.db "SELECT COUNT(*) FROM symbols;"
```

### 7. Start Development Server

```powershell
# Start in watch mode (auto-reloads on changes)
npm run dev

# Or start normally
npm start
```

You should see:
```
🚀 Starting X++ MCP Code Completion Server...
💾 Initializing cache service...
⚠️  Redis cache disabled - running without cache
📚 Loading metadata from: ./data/xpp-metadata.db
✅ Loaded 1,234 symbols from database
🌐 Server started on http://localhost:3000
📡 MCP endpoint available at: http://localhost:3000/mcp
```

### 8. Test the Server

#### Health Check
```powershell
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-22T10:30:00.000Z",
  "uptime": 123.45,
  "version": "1.0.0"
}
```

#### Test MCP Endpoint
```powershell
# List available tools
curl http://localhost:3000/mcp -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 9. Optional: Set Up Redis Cache

For better performance in development:

#### Install Redis locally
```powershell
# Using Chocolatey
choco install redis-64

# Or download from: https://github.com/microsoftarchive/redis/releases

# Start Redis
redis-server
```

#### Update .env
```env
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
CACHE_TTL=3600
```

Restart the server - you should see:
```
✅ Redis cache enabled (0 keys, 1.2MB memory)
```

## Development Workflow

### Making Code Changes

1. **Edit TypeScript files** in `src/`
2. **Watch mode** (`npm run dev`) auto-rebuilds
3. **Test changes** via curl or Postman
4. **Check logs** in terminal

### Adding New Tools

1. Create tool file in `src/tools/yourTool.ts`
2. Export tool definition
3. Register in `src/tools/index.ts`
4. Rebuild and test

### Updating Metadata

```powershell
# Re-extract from D365
npm run extract-metadata

# Rebuild database
npm run build-database

# Restart server
npm run dev
```

## Troubleshooting

### "No symbols found in database"
- Run `npm run extract-metadata` first
- Check `PACKAGES_PATH` points to correct directory
- Verify `MODEL_NAMES` includes all your D365 models (comma-separated)
- Example: `MODEL_NAMES=CustomModel1,CustomModel2,ApplicationSuite`

### "Failed to connect to Redis"
- Check Redis is running: `redis-cli ping` (should return PONG)
- Verify `REDIS_URL` is correct
- Set `REDIS_ENABLED=false` to disable caching

### "Azure AD authentication failed"
- Verify Tenant ID, Client ID, Client Secret are correct
- Check app registration has API permissions granted
- Ensure admin consent was given

### "Cannot find module"
- Run `npm install` again
- Delete `node_modules` and reinstall
- Run `npm run build`

### Port already in use
- Change `PORT` in `.env` to 3001, 3002, etc.
- Or kill the process using the port:
  ```powershell
  netstat -ano | findstr :3000
  taskkill /PID <process-id> /F
  ```

## VS Code Integration

Add to your workspace settings (`.vscode/settings.json`):

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "editor.formatOnSave": true,
  "files.exclude": {
    "**/node_modules": true,
    "**/dist": true
  }
}
```

## Next Steps

- **Test MCP tools**: Use Postman or curl to test each tool
- **Add custom models**: Update `CUSTOM_MODELS` for ISV extensions
- **Enable monitoring**: Set up Application Insights (optional)
- **Deploy to Azure**: Follow deployment guide when ready

## Additional Resources

- **D365 F&O Documentation**: https://learn.microsoft.com/dynamics365/fin-ops-core/
- **Azure AD App Registration**: https://learn.microsoft.com/azure/active-directory/develop/quickstart-register-app
- **MCP Protocol**: https://modelcontextprotocol.io/
- **Project README**: [README.md](README.md)

## Getting Help

- **Issues**: https://github.com/yourusername/d365fo-mcp-server/issues
- **Discussions**: https://github.com/yourusername/d365fo-mcp-server/discussions
