<#
.SYNOPSIS
    Rebuild databases for one or all MCP server instances.
.DESCRIPTION
    Lists available instances and lets you pick which one to rebuild,
    with an "All instances" option at the end.
    You can also pass the instance name directly: .\rebuild-instance.ps1 alpha
    Or rebuild everything:                        .\rebuild-instance.ps1 --all
#>
param(
    [string]$InstanceName,
    [switch]$All
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

# ── Discover instances ──────────────────────────────────────────────────────
$instancesDir = Join-Path $repoRoot 'instances'
$instances = @(Get-ChildItem -Path $instancesDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '.env') } |
    Sort-Object Name)

if ($instances.Count -eq 0) {
    Write-Host 'No instances found. Run .\add-instance.ps1 to create one.' -ForegroundColor Yellow
    exit 1
}

# ── Helper: read PORT from an .env file ─────────────────────────────────────
function Get-EnvPort([string]$envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=' -List | Select-Object -First 1
    if ($line) { return ($line.Line -replace '^\s*PORT\s*=\s*', '').Trim() }
    return '?'
}

# ── Helper: extract variable names from a .env file ─────────────────────────
function Get-EnvVarNames([string]$envFile) {
    $names = @()
    foreach ($line in (Get-Content $envFile)) {
        # Match uncommented KEY=value lines (skip comments and blank lines)
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
            $names += $Matches[1]
        }
    }
    return $names
}

# ── Helper: check instance .env for missing settings from .env.example ──────
# Returns $true if missing settings were found.
function Show-MissingSettings([System.IO.DirectoryInfo]$inst) {
    $exampleFile = Join-Path $repoRoot '.env.example'
    if (-not (Test-Path $exampleFile)) { return $false }

    $envFile = Join-Path $inst.FullName '.env'
    $exampleVars = Get-EnvVarNames $exampleFile
    $instanceVars = Get-EnvVarNames $envFile

    $missing = @($exampleVars | Where-Object { $_ -notin $instanceVars })
    if ($missing.Count -eq 0) { return $false }

    Write-Host ''
    Write-Host "  New settings in .env.example not in $($inst.Name)/.env:" -ForegroundColor Yellow
    foreach ($var in $missing) {
        # Show the line from .env.example for context
        $line = Select-String -Path $exampleFile -Pattern "^\s*$var\s*=" -List | Select-Object -First 1
        $val = if ($line) { ($line.Line -replace "^\s*$var\s*=\s*", '').Trim() } else { '' }
        Write-Host "    $var=$val" -ForegroundColor DarkYellow
    }
    return $true
}

# ── Helper: rebuild a single instance ───────────────────────────────────────
function Rebuild-SingleInstance([System.IO.DirectoryInfo]$inst) {
    $envFile = Join-Path $inst.FullName '.env'
    $env:ENV_FILE = $envFile

    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkGray
    Write-Host "Rebuilding: $($inst.Name)" -ForegroundColor Green
    Write-Host "Config: $envFile" -ForegroundColor DarkGray
    Write-Host ('=' * 60) -ForegroundColor DarkGray

    Write-Host ''
    Write-Host '[1/2] Extracting metadata...' -ForegroundColor Cyan
    & npx tsx (Join-Path $repoRoot 'scripts\extract-metadata.ts')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Metadata extraction failed for $($inst.Name)" -ForegroundColor Red
        return $false
    }

    Write-Host ''
    Write-Host '[2/2] Building database...' -ForegroundColor Cyan
    & node --max-old-space-size=6144 --import tsx/esm (Join-Path $repoRoot 'scripts\build-database.ts')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Database build failed for $($inst.Name)" -ForegroundColor Red
        return $false
    }

    Write-Host ''
    Write-Host "Done: $($inst.Name)" -ForegroundColor Green
    return $true
}

# ── Select instance(s) ─────────────────────────────────────────────────────
$toRebuild = @()

if ($All) {
    $toRebuild = $instances
} elseif ($InstanceName) {
    $selected = $instances | Where-Object { $_.Name -eq $InstanceName }
    if (-not $selected) {
        Write-Host "Instance '$InstanceName' not found." -ForegroundColor Red
        exit 1
    }
    $toRebuild = @($selected)
} else {
    Write-Host ''
    Write-Host 'Available instances:' -ForegroundColor Cyan
    Write-Host ''
    for ($i = 0; $i -lt $instances.Count; $i++) {
        $port = Get-EnvPort (Join-Path $instances[$i].FullName '.env')
        Write-Host "  $($i + 1). $($instances[$i].Name)  " -NoNewline -ForegroundColor White
        Write-Host "(port $port)" -ForegroundColor DarkGray
    }
    $allIndex = $instances.Count + 1
    Write-Host ''
    Write-Host "  $allIndex. All instances" -ForegroundColor Yellow
    Write-Host ''
    $choice = Read-Host 'Select instance [number]'
    $index = [int]$choice - 1

    if ($index -eq ($allIndex - 1)) {
        $toRebuild = $instances
    } elseif ($index -lt 0 -or $index -ge $instances.Count) {
        Write-Host 'Invalid selection.' -ForegroundColor Red
        exit 1
    } else {
        $toRebuild = @($instances[$index])
    }
}

# ── Optionally update code first ────────────────────────────────────────────
Write-Host ''
$pullAnswer = Read-Host 'Pull latest code from Git? [Y/n]'
if ($pullAnswer -ne 'n') {
    Write-Host ''
    Write-Host '[Git] Pulling latest...' -ForegroundColor DarkGray
    & git pull
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: git pull failed' -ForegroundColor Red
        exit 1
    }

    Write-Host '[npm] Installing dependencies...' -ForegroundColor DarkGray
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: npm install failed' -ForegroundColor Red
        exit 1
    }

    Write-Host '[tsc] Building TypeScript...' -ForegroundColor DarkGray
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: TypeScript build failed' -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host 'Skipping code update.' -ForegroundColor DarkGray
}

# ── Check for new settings ──────────────────────────────────────────────────
$hasNewSettings = $false
foreach ($inst in $toRebuild) {
    if (Show-MissingSettings $inst) { $hasNewSettings = $true }
}
if ($hasNewSettings) {
    Write-Host 'Update your .env files with the new settings before continuing.' -ForegroundColor Yellow
    Write-Host 'The rebuild will wait until you are done.' -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host 'Continue with rebuild? [y/N]'
    if ($answer -ne 'y') {
        Write-Host 'Aborted.' -ForegroundColor DarkGray
        exit 0
    }
}

# ── Rebuild ─────────────────────────────────────────────────────────────────
$failed = @()
foreach ($inst in $toRebuild) {
    $ok = Rebuild-SingleInstance $inst
    if (-not $ok) { $failed += $inst.Name }
}

# ── Summary ─────────────────────────────────────────────────────────────────
if ($toRebuild.Count -gt 1) {
    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkGray
    if ($failed.Count -eq 0) {
        Write-Host "All $($toRebuild.Count) instances rebuilt successfully." -ForegroundColor Green
    } else {
        Write-Host "Completed with errors. Failed: $($failed -join ', ')" -ForegroundColor Red
    }
    Write-Host ('=' * 60) -ForegroundColor DarkGray
}
