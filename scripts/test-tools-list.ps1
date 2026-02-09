# Test if MCP server returns all 10 tools
$endpoint = "http://localhost:8080/mcp"

$body = @{
    jsonrpc = "2.0"
    id = 1
    method = "tools/list"
    params = @{}
} | ConvertTo-Json

Write-Host "🧪 Testing MCP server tools list..." -ForegroundColor Cyan
Write-Host "Endpoint: $endpoint" -ForegroundColor Gray

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Body $body -ContentType "application/json"
    
    $tools = $response.result.tools
    Write-Host "`n✅ Server returned $($tools.Count) tools:" -ForegroundColor Green
    
    $tools | ForEach-Object {
        Write-Host "   - $($_.name)" -ForegroundColor White
    }
    
    # Check for new intelligent tools
    $intelligentTools = @(
        "analyze_code_patterns",
        "suggest_method_implementation",
        "analyze_class_completeness",
        "get_api_usage_patterns"
    )
    
    Write-Host "`n🧠 Intelligent tools status:" -ForegroundColor Cyan
    foreach ($tool in $intelligentTools) {
        $found = $tools | Where-Object { $_.name -eq $tool }
        if ($found) {
            Write-Host "   ✅ $tool" -ForegroundColor Green
        } else {
            Write-Host "   ❌ $tool (MISSING!)" -ForegroundColor Red
        }
    }
    
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Make sure the MCP server is running on port 8080" -ForegroundColor Yellow
}
