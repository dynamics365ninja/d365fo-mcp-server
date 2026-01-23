# MCP Server Testing Script
# Usage: .\test-mcp.ps1 -Action search -Query "CustTable"

param(
    [Parameter(Mandatory=$false)]
    [ValidateSet('search', 'class', 'table', 'extensions', 'complete', 'health')]
    [string]$Action = 'search',
    
    [Parameter(Mandatory=$false)]
    [string]$Query = 'CustTable',
    
    [Parameter(Mandatory=$false)]
    [string]$ServerUrl = 'http://localhost:3000'
)

function Invoke-MCPTool {
    param(
        [string]$ToolName,
        [hashtable]$Arguments
    )
    
    $body = @{
        jsonrpc = "2.0"
        method = "tools/call"
        params = @{
            name = $ToolName
            arguments = $Arguments
        }
        id = 1
    } | ConvertTo-Json -Depth 10
    
    try {
        $response = Invoke-RestMethod -Uri "$ServerUrl/mcp" -Method POST -ContentType "application/json" -Body $body
        return $response.result
    } catch {
        Write-Error "Error calling MCP tool: $_"
        return $null
    }
}

Write-Host "X++ MCP Server Test Tool" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Test health first
try {
    $health = Invoke-RestMethod -Uri "$ServerUrl/health"
    Write-Host "[OK] Server Status: $($health.status)" -ForegroundColor Green
    Write-Host "[OK] Symbols Loaded: $($health.symbols)" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "[ERROR] Server is not running at $ServerUrl" -ForegroundColor Red
    Write-Host "        Start with: npm run dev" -ForegroundColor Yellow
    exit 1
}

# Execute requested action
switch ($Action) {
    'search' {
        Write-Host "[SEARCH] Searching for: $Query" -ForegroundColor Yellow
        $result = Invoke-MCPTool -ToolName "xpp_search" -Arguments @{ query = $Query; limit = 10 }
        if ($result.content) {
            Write-Host $result.content[0].text -ForegroundColor Green
        }
    }
    
    'class' {
        Write-Host "[CLASS] Getting class info: $Query" -ForegroundColor Yellow
        $result = Invoke-MCPTool -ToolName "xpp_get_class" -Arguments @{ className = $Query }
        if ($result.content) {
            $data = $result.content[0].text | ConvertFrom-Json
            Write-Host "Class: $($data.name)" -ForegroundColor Green
            if ($data.extends) { Write-Host "  Extends: $($data.extends)" }
            Write-Host "  Methods: $($data.methods.Count)"
            $data.methods | Select-Object -First 5 | ForEach-Object {
                Write-Host "    - $($_.name) with $($_.parameters.Count) params" -ForegroundColor Gray
            }
        }
    }
    
    'table' {
        Write-Host "[TABLE] Getting table info: $Query" -ForegroundColor Yellow
        $result = Invoke-MCPTool -ToolName "xpp_get_table" -Arguments @{ tableName = $Query }
        if ($result.content) {
            $data = $result.content[0].text | ConvertFrom-Json
            Write-Host "Table: $($data.name)" -ForegroundColor Green
            Write-Host "  Fields: $($data.fields.Count)"
            $data.fields | Select-Object -First 10 | ForEach-Object {
                Write-Host "    - $($_.name): $($_.type)" -ForegroundColor Gray
            }
        }
    }
    
    'extensions' {
        Write-Host "[EXTENSIONS] Searching extensions: $Query" -ForegroundColor Yellow
        $result = Invoke-MCPTool -ToolName "xpp_search_extensions" -Arguments @{ query = $Query; limit = 10 }
        if ($result.content) {
            $data = $result.content[0].text | ConvertFrom-Json
            Write-Host "Found $($data.totalResults) custom extension results" -ForegroundColor Green
        }
    }
    
    'complete' {
        Write-Host "[COMPLETE] Getting completions for: $Query" -ForegroundColor Yellow
        $result = Invoke-MCPTool -ToolName "xpp_complete_method" -Arguments @{ className = $Query; prefix = "" }
        if ($result.content) {
            $data = $result.content[0].text | ConvertFrom-Json
            Write-Host "Available methods:" -ForegroundColor Green
            $data.methods | Select-Object -First 10 | ForEach-Object {
                Write-Host "  - $($_.signature)" -ForegroundColor White
            }
        }
    }
    
    'health' {
        # Already displayed above
    }
}

Write-Host ""
Write-Host "Try other actions: search, class, table, extensions, complete" -ForegroundColor Cyan
