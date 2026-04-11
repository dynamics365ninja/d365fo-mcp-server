<#
.SYNOPSIS
    Start an MCP server instance.
.DESCRIPTION
    Lists available instances and lets you pick which one to run.
    You can also pass the instance name directly: .\instances\run-instance.ps1 alpha
#>
param(
    [string]$InstanceName
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

# ── Discover instances ──────────────────────────────────────────────────────
$instancesDir = Join-Path $repoRoot 'instances'
$instances = @(Get-ChildItem -Path $instancesDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '.env') } |
    Sort-Object Name)

if ($instances.Count -eq 0) {
    Write-Host 'No instances found. Run .\instances\add-instance.ps1 to create one.' -ForegroundColor Yellow
    exit 1
}

# ── Helper: read PORT from an .env file ─────────────────────────────────────
function Get-EnvPort([string]$envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=' -List | Select-Object -First 1
    if ($line) { return ($line.Line -replace '^\s*PORT\s*=\s*', '').Trim() }
    return '?'
}

# ── Select instance ─────────────────────────────────────────────────────────
if ($InstanceName) {
    $selected = $instances | Where-Object { $_.Name -eq $InstanceName }
    if (-not $selected) {
        Write-Host "Instance '$InstanceName' not found." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host ''
    Write-Host 'Available instances:' -ForegroundColor Cyan
    Write-Host ''
    for ($i = 0; $i -lt $instances.Count; $i++) {
        $port = Get-EnvPort (Join-Path $instances[$i].FullName '.env')
        Write-Host "  $($i + 1). $($instances[$i].Name)  " -NoNewline -ForegroundColor White
        Write-Host "(port $port)" -ForegroundColor DarkGray
    }
    Write-Host ''
    $choice = Read-Host 'Select instance [number]'
    $index = [int]$choice - 1
    if ($index -lt 0 -or $index -ge $instances.Count) {
        Write-Host 'Invalid selection.' -ForegroundColor Red
        exit 1
    }
    $selected = $instances[$index]
}

# ── Run ─────────────────────────────────────────────────────────────────────
$envFile = Join-Path $selected.FullName '.env'
$env:ENV_FILE = $envFile

Write-Host ''
Write-Host "Starting instance: $($selected.Name)" -ForegroundColor Green
Write-Host "Config: $envFile" -ForegroundColor DarkGray
Write-Host ''

node (Join-Path $repoRoot 'dist\index.js')  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Server exited with code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
  }