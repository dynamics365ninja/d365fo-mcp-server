# Test STDIO Proxy locally
Write-Host "🧪 Testing stdio proxy..." -ForegroundColor Cyan

$testRequest = @{
    jsonrpc = "2.0"
    id = 1
    method = "tools/list"
    params = @{}
} | ConvertTo-Json -Compress

Write-Host "Sending MCP request through proxy..." -ForegroundColor Gray

# Send request to proxy via stdin
$response = $testRequest | node scripts/azure-mcp-proxy.js 2>&1

Write-Host "`nProxy response:" -ForegroundColor Cyan
$response | Write-Host

if ($response -match '"tools"') {
    Write-Host "`n✅ Proxy is working!" -ForegroundColor Green
} else {
    Write-Host "`n❌ Proxy failed" -ForegroundColor Red
}
