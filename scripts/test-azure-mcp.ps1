# Test Azure MCP Server
$endpoint = "https://d365fo-mcp-server.azurewebsites.net/mcp"

$body = @{
    jsonrpc = "2.0"
    id = 1
    method = "tools/list"
    params = @{}
} | ConvertTo-Json

Write-Host "🧪 Testing Azure MCP server..." -ForegroundColor Cyan
Write-Host "Endpoint: $endpoint" -ForegroundColor Gray

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Body $body -ContentType "application/json"
    
    $tools = $response.result.tools
    Write-Host "`n✅ Server returned $($tools.Count) tools:" -ForegroundColor Green
    
    $tools | ForEach-Object {
        $emoji = if ($_.name -match "analyze|suggest|api_usage") { "🧠" } else { "📦" }
        Write-Host "   $emoji $($_.name)" -ForegroundColor White
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
    
    if ($tools.Count -eq 10) {
        Write-Host "`n🎉 SUCCESS: All 10 tools are registered!" -ForegroundColor Green
    } else {
        Write-Host "`n⚠️ WARNING: Expected 10 tools, got $($tools.Count)" -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Make sure the Azure MCP server is deployed and running" -ForegroundColor Yellow
}
