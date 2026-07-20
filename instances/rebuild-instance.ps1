<#
.SYNOPSIS
    Rebuild (reindex) the databases for one or all MCP server instances.
.DESCRIPTION
    Runs a FULL reindex of an instance's metadata databases from the CURRENT
    source (extract + build via tsx). It does NOT update the server binaries —
    that is a repo-global step you run yourself, because it affects every
    instance at once.

    Full update flow after a git pull:
      1. git pull                     # and decide what actually changed
      2. npm install; npm run build   # ONCE — rebuilds dist/ that ALL instances run
      3. rebuild only if the pull changed the parser / DB schema:
           .\instances\rebuild-instance.ps1 <name>          # one instance
           .\instances\rebuild-instance.ps1 --all           # every instance
    Most code changes are runtime-only: after step 2 just restart the instances,
    no reindex needed. Reindex only for parser/extraction/schema changes.

    This always does a full (EXTRACT_MODE=all) rebuild. The engine also supports
    incremental 'custom'/'standard' builds, but they are not exposed here: on UDE
    the build phase cannot see the auto-detected custom models, and the per-model
    reindex path is slower than a full rebuild on single-language instances, so a
    full rebuild is both simplest and fastest for local instances.

    You can pass the instance name directly: .\instances\rebuild-instance.ps1 alpha
    Rebuild everything:                       .\instances\rebuild-instance.ps1 --all
#>
param(
    [string]$InstanceName,
    [switch]$All
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

# ── Helper: extract variable names from a .env file ─────────────────────────
# Treats commented-out lines (e.g. "# KEY=value") as present-but-disabled so
# that the missing-settings check doesn't flag vars the user has intentionally
# left commented in their instance .env.
function Get-EnvVarNames([string]$envFile) {
    $names = @()
    foreach ($line in (Get-Content $envFile)) {
        if ($line -match '^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
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

# ── Helper: normalise XPP_CONFIG_NAME to the full versioned filename ────────
# If the .env has a short name (e.g. "myenv-dev"), resolve it to the current
# versioned file (e.g. "myenv-dev___10.0.2345.153") and rewrite the .env so
# run-instance can later detect UDE upgrades with a plain file-exists check.
function Normalize-XppConfigName([string]$envFile) {
    $envType = Get-DevEnvType $envFile
    if ($envType -eq 'traditional') { return }

    $configName = Get-EnvValue $envFile 'XPP_CONFIG_NAME'
    if (-not $configName) { return }
    # Already a full versioned name
    if ($configName -match '^(.+)___(.+)$') { return }

    $configDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365\XPPConfig'
    if (-not (Test-Path $configDir)) { return }

    $match = @(Get-ChildItem -Path $configDir -Filter '*.json' -File |
        Where-Object { $_.Name -match "^$([regex]::Escape($configName))___(.+)\.json$" } |
        Sort-Object LastWriteTime -Descending)
    if ($match.Count -eq 0) {
        Write-Host ''
        Write-Host "WARNING: XPP_CONFIG_NAME '$configName' does not match any config in $configDir" -ForegroundColor Yellow
        Write-Host '  Leaving .env unchanged; rebuild will likely fail.' -ForegroundColor Yellow
        return
    }

    $full = $match[0].BaseName
    $content = Get-Content $envFile -Raw
    $content = $content -replace '(?m)^XPP_CONFIG_NAME=.*$', "XPP_CONFIG_NAME=$full"
    Set-Content -Path $envFile -Value $content -NoNewline

    Write-Host ''
    Write-Host "Expanded XPP_CONFIG_NAME: $configName -> $full" -ForegroundColor Cyan
}

# ── Helper: read a value from an .env file ─────────────────────────────────
function Get-EnvValue([string]$envFile, [string]$key) {
    $line = Select-String -Path $envFile -Pattern "^\s*$key\s*=" -List | Select-Object -First 1
    if ($line) { return ($line.Line -replace "^\s*$key\s*=\s*", '').Trim() }
    return $null
}

# ── Helper: read the dev-environment-type setting ───────────────────────────
# Canonical name is the D365FO_-prefixed form; the plain name is a legacy
# fallback so un-migrated instances keep behaving correctly during rebuild.
function Get-DevEnvType([string]$envFile) {
    $v = Get-EnvValue $envFile 'D365FO_DEV_ENVIRONMENT_TYPE'
    if (-not $v) { $v = Get-EnvValue $envFile 'DEV_ENVIRONMENT_TYPE' }
    return $v
}

# ── Helper: migrate the dev-env-type setting to its canonical prefixed name ──
# The public setting was renamed DEV_ENVIRONMENT_TYPE -> D365FO_DEV_ENVIRONMENT_TYPE
# (matching the D365FO_PACKAGE_PATH convention). If an instance .env still uses
# only the old plain name, offer to rename it in place. Fires only on a genuine
# migration case (prefixed missing AND plain present), so instances that omit
# the setting entirely are never nagged. Declining is safe — the plain name is
# still read as a legacy fallback by both these scripts and the server.
function Migrate-DevEnvTypeName([string]$envFile) {
    $prefixed = Get-EnvValue $envFile 'D365FO_DEV_ENVIRONMENT_TYPE'
    $plain    = Get-EnvValue $envFile 'DEV_ENVIRONMENT_TYPE'
    if ($prefixed -or (-not $plain)) { return }

    Write-Host ''
    Write-Host 'NOTE: the dev-environment-type setting has been renamed.' -ForegroundColor Yellow
    Write-Host '  Old: DEV_ENVIRONMENT_TYPE' -ForegroundColor Yellow
    Write-Host "  New: D365FO_DEV_ENVIRONMENT_TYPE  (current value: $plain)" -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host 'Rename it in this .env now? [Y/n]'
    if ($answer -eq 'n') {
        Write-Host '  Left unchanged (the old name still works as a legacy fallback).' -ForegroundColor DarkGray
        return
    }

    $content = Get-Content $envFile -Raw
    $content = $content -replace '(?m)^(\s*)DEV_ENVIRONMENT_TYPE(\s*=)', '${1}D365FO_DEV_ENVIRONMENT_TYPE${2}'
    Set-Content -Path $envFile -Value $content -NoNewline
    Write-Host '  Renamed DEV_ENVIRONMENT_TYPE -> D365FO_DEV_ENVIRONMENT_TYPE' -ForegroundColor Cyan
}

# ── Helper: rebuild a single instance ───────────────────────────────────────
function Rebuild-SingleInstance([System.IO.DirectoryInfo]$inst) {
    $envFile = Join-Path $inst.FullName '.env'
    $env:ENV_FILE = $envFile
    # Force a full rebuild regardless of what EXTRACT_MODE the instance .env
    # happens to have set — dotenv does not override already-set process env
    # vars, so this wins over a stray 'custom'/'standard' value in the file.
    $env:EXTRACT_MODE = 'all'

    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkGray
    Write-Host "Rebuilding: $($inst.Name)" -ForegroundColor Green
    Write-Host "Config: $envFile" -ForegroundColor DarkGray
    Write-Host ('=' * 60) -ForegroundColor DarkGray

    Migrate-DevEnvTypeName $envFile
    Normalize-XppConfigName $envFile

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

# ── Code updates are a separate, repo-global step (by design) ────────────────
# This script only reindexes databases. Updating the server binaries
# (git pull; npm install; npm run build) is a repo-wide operation that affects
# EVERY instance's shared dist/ at once — doing it here while rebuilding a single
# instance would leave the other instances running new binaries against an
# old-schema database. Run the code update yourself, once, then rebuild the
# instance(s) that need it. See the .DESCRIPTION for the full flow.

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
