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

# ── Helper: read a value from an .env file ─────────────────────────────────
function Get-EnvValue([string]$envFile, [string]$key) {
    $line = Select-String -Path $envFile -Pattern "^\s*$key\s*=" -List | Select-Object -First 1
    if ($line) { return ($line.Line -replace "^\s*$key\s*=\s*", '').Trim() }
    return $null
}

# ── Helper: read the dev-environment-type setting ───────────────────────────
# Canonical name is the D365FO_-prefixed form; the plain name is a legacy
# fallback (see rebuild-instance.ps1 for the one-time rename nudge).
function Get-DevEnvType([string]$envFile) {
    $v = Get-EnvValue $envFile 'D365FO_DEV_ENVIRONMENT_TYPE'
    if (-not $v) { $v = Get-EnvValue $envFile 'DEV_ENVIRONMENT_TYPE' }
    return $v
}

# ── Run ─────────────────────────────────────────────────────────────────────
$envFile = Join-Path $selected.FullName '.env'
$env:ENV_FILE = $envFile

# ── Warn if XPP_CONFIG_NAME no longer resolves ──────────────────────────────
$envType = Get-DevEnvType $envFile
$configName = Get-EnvValue $envFile 'XPP_CONFIG_NAME'
if ($configName -and ($envType -ne 'traditional')) {
    # Rebuild normalises XPP_CONFIG_NAME to the full versioned filename, so a
    # plain file-exists check is enough: if the pinned file is gone, the UDE
    # was upgraded and the DB is stale.
    $configDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365\XPPConfig'
    $configPath = Join-Path $configDir "$configName.json"
    if (-not (Test-Path $configPath)) {
        Write-Host ''
        Write-Host 'WARNING: XPP_CONFIG_NAME does not match any file in' -ForegroundColor Yellow
        Write-Host "  $configDir" -ForegroundColor Yellow
        Write-Host "  Current value: $configName" -ForegroundColor Yellow
        Write-Host '  The UDE may have been upgraded since this instance was configured.' -ForegroundColor Yellow
        Write-Host "  Fix with:  .\instances\upgrade-instance.ps1 $($selected.Name)" -ForegroundColor Yellow
        Write-Host ''
        $answer = Read-Host 'Continue anyway? [y/N]'
        if ($answer -ne 'y') {
            Write-Host 'Aborted.' -ForegroundColor DarkGray
            exit 0
        }
    }
}

Write-Host ''
Write-Host "Starting instance: $($selected.Name)" -ForegroundColor Green
Write-Host "Config: $envFile" -ForegroundColor DarkGray
Write-Host ''

node (Join-Path $repoRoot 'dist\index.js')
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Server exited with code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}