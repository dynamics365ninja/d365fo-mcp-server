# Visual Studio 2022 MCP Setup Guide

## Prerequisites

- Visual Studio 2022 version 17.14.9 or later
- GitHub Copilot subscription and extension installed
- Node.js 22+ for running the MCP server

## Setup Steps

### 1. Configure the MCP Server

Create or edit `%USERPROFILE%\.mcp.json`:

```json
{
  "servers": {
    "xpp-completion": {
      "url": "http://localhost:3000/mcp/",
      "description": "X++ Code Completion Server for D365 F&O"
    }
  }
}
```

**Important:** The URL must end with a trailing slash (`/`)

### 2. Start the MCP Server

```powershell
cd C:\Users\your-user\source\repos\d365fo-mcp-server
npm run dev
```

Verify it's running:
- Should see: "✅ D365 F&O MCP Server listening on 0.0.0.0:3000"
- Test health: http://localhost:3000/health

### 3. Enable in Visual Studio 2022

1. **Close and reopen Visual Studio** (must restart after creating .mcp.json)
2. **Open any solution** (D365 or any other project)
3. **Open GitHub Copilot Chat**: View → GitHub Copilot Chat (or Ctrl+/)
4. **Switch to Agent Mode**: 
   - Click dropdown at bottom of chat window
   - Select "Agent" mode
5. **Access Tools**:
   - Look for tool picker/selector button
   - OR type `#` to see available resources
   - OR click the green `+` button to add tools

### 4. Verify Tool Registration

Check if tools are loaded:
- In Agent mode, the tools should appear in the tool picker
- Available tools: xpp_search, xpp_get_class, xpp_get_table, xpp_complete_method, xpp_generate_code

## Troubleshooting

### Visual Studio Output Window

1. Go to View → Output
2. Select "GitHub Copilot" from the dropdown
3. Look for MCP-related messages or errors

### Check Extensions

1. Go to Extensions → Manage Extensions
2. Ensure "GitHub Copilot" is installed and enabled
3. Version should support Agent mode (check for updates)

### Alternative Configuration Locations

If user-level config doesn't work, try solution-specific:

Create `.mcp.json` in your solution root (where .sln file is):

```
YourSolution\
├── .mcp.json          ← Create here
├── YourSolution.sln
└── ...
```

### Manual Server Registration

1. In Copilot Chat (Agent mode)
2. Click the green `+` button
3. Select "Configure MCP Server"
4. Enter:
   - Name: xpp-completion
   - URL: http://localhost:3000/mcp/

### Common Issues

#### Issue: Tools don't appear in Agent mode
- **Check**: Is the server actually running? Test with http://localhost:3000/health
- **Check**: Did you restart VS after creating .mcp.json?
- **Check**: Is CodeLens enabled? (Tools → Options → Text Editor → CodeLens)
- **Check**: Is Agent mode selected (not Chat mode)?

#### Issue: "Authentication Required" in CodeLens
- Some servers require OAuth authentication
- Your server doesn't require auth, but if you see this, click it to configure

#### Issue: Server won't start (port 3000 in use)
```powershell
# Find and kill process on port 3000
Get-Process -Name node | Where-Object { 
  (Get-NetTCPConnection -OwningProcess $_.Id -ErrorAction SilentlyContinue).LocalPort -eq 3000 
} | Stop-Process -Force
```

#### Issue: Visual Studio doesn't detect the .mcp.json file
- Ensure file is saved without BOM encoding
- Check file permissions
- Try the solution-specific location instead

### Test Without Visual Studio

Use the PowerShell test script to verify the server works:

```powershell
.\scripts\test-mcp.ps1 -Action search -Query "CustTable"
```

## Direct REST API Access (Alternative)

If Visual Studio integration doesn't work, you can still use the MCP server via REST API:

```powershell
# Search for symbols
$body = @{
    jsonrpc = "2.0"
    method = "tools/call"
    params = @{
        name = "xpp_search"
        arguments = @{ query = "CustTable"; limit = 10 }
    }
    id = 1
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3000/mcp" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

## Known Limitations

- Visual Studio 2022's MCP support is relatively new (17.14+)
- Not all MCP features may be fully implemented in VS yet
- Some MCP servers work better than others due to transport differences
- For D365 F&O X++ development, you still need Visual Studio (VS Code not supported for D365 dev)

## Additional Resources

- [Microsoft MCP Documentation](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers?view=vs-2022)
- [MCP Specification](https://modelcontextprotocol.io/)
- [GitHub Copilot Agent Mode](https://learn.microsoft.com/en-us/visualstudio/ide/copilot-agent-mode?view=vs-2022)
