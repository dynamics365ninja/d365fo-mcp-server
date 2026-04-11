<#
.SYNOPSIS
    Create a new MCP server instance.
.DESCRIPTION
    Prompts for instance name and port, creates the folder structure,
    and copies the .env template. Opens the .env for editing when done.
#>
param(
    [string]$InstanceName,
    [int]$Port
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$instancesDir = Join-Path $repoRoot 'instances'
$templateFile = Join-Path $instancesDir '.env.template'

if (-not (Test-Path $templateFile)) {
    Write-Host "Template not found: $templateFile" -ForegroundColor Red
    exit 1
}

# ── Discover existing instances ─────────────────────────────────────────────
$existing = @(Get-ChildItem -Path $instancesDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '.env') } |
    Sort-Object Name)

# ── Helper: read PORT from an .env file ─────────────────────────────────────
function Get-EnvPort([string]$envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=' -List | Select-Object -First 1
    if ($line) { return ($line.Line -replace '^\s*PORT\s*=\s*', '').Trim() }
    return $null
}

# ── Show existing instances ─────────────────────────────────────────────────
if ($existing.Count -gt 0) {
    Write-Host ''
    Write-Host 'Existing instances:' -ForegroundColor Cyan
    Write-Host ''
    foreach ($inst in $existing) {
        $p = Get-EnvPort (Join-Path $inst.FullName '.env')
        Write-Host "  - $($inst.Name)  " -NoNewline -ForegroundColor White
        Write-Host "(port $p)" -ForegroundColor DarkGray
    }
    Write-Host ''
}

# ── Prompt for name ─────────────────────────────────────────────────────────
if (-not $InstanceName) {
    $InstanceName = Read-Host 'Instance name (e.g. alpha, projectX, client-prod)'
    $InstanceName = $InstanceName.Trim()
}
if (-not $InstanceName) {
    Write-Host 'No name provided.' -ForegroundColor Red
    exit 1
}

$instanceDir = Join-Path $instancesDir $InstanceName
if (Test-Path (Join-Path $instanceDir '.env')) {
    Write-Host "Instance '$InstanceName' already exists." -ForegroundColor Red
    exit 1
}

# ── Prompt for port ─────────────────────────────────────────────────────────
# Suggest next available port based on existing instances
$usedPorts = @($existing | ForEach-Object {
    $p = Get-EnvPort (Join-Path $_.FullName '.env')
    if ($p -and $p -ne '?') { [int]$p }
})
$suggestedPort = 3001
if ($usedPorts.Count -gt 0) {
    $suggestedPort = ($usedPorts | Measure-Object -Maximum).Maximum + 1
}

if (-not $Port) {
    $input = Read-Host "Port [$suggestedPort]"
    $input = $input.Trim()
    if ($input) { $Port = [int]$input } else { $Port = $suggestedPort }
}

if ($usedPorts -contains $Port) {
    Write-Host "WARNING: Port $Port is already used by another instance." -ForegroundColor Yellow
    $confirm = Read-Host 'Continue anyway? [y/N]'
    if ($confirm -ne 'y') { exit 0 }
}

# ── Create instance ─────────────────────────────────────────────────────────
Write-Host ''
Write-Host "Creating instance: $InstanceName" -ForegroundColor Green
Write-Host "  Directory: $instanceDir" -ForegroundColor DarkGray
Write-Host "  Port:      $Port" -ForegroundColor DarkGray

New-Item -Path (Join-Path $instanceDir 'data') -ItemType Directory -Force | Out-Null
New-Item -Path (Join-Path $instanceDir 'metadata') -ItemType Directory -Force | Out-Null

# Copy template with placeholders replaced
$content = Get-Content $templateFile -Raw
$content = $content -replace '__PORT__', $Port
Set-Content -Path (Join-Path $instanceDir '.env') -Value $content -NoNewline

Write-Host ''
Write-Host 'Instance created.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Edit the .env file - set XPP_CONFIG_NAME, EXTENSION_PREFIX, D365FO_MODEL_NAME'
Write-Host ('  2. Rebuild:  .\instances\rebuild-instance.ps1 ' + $InstanceName)
Write-Host ('  3. Run:      .\instances\run-instance.ps1 ' + $InstanceName)
Write-Host ''

# Offer to open .env for editing
$open = Read-Host 'Open .env for editing now? [Y/n]'
if ($open -ne 'n') {
    $envPath = Join-Path $instanceDir '.env'
    # Try VS Code first, fall back to notepad
    $vscode = Get-Command code -ErrorAction SilentlyContinue
    if ($vscode) {
        & code $envPath
    } else {
        Start-Process notepad $envPath
    }
}
