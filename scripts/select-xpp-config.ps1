<#
.SYNOPSIS
    Lists available XPP config files and writes the selected one to .env

.DESCRIPTION
    Scans %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\ for config files,
    displays them with their paths, and updates XPP_CONFIG_NAME in .env.

.EXAMPLE
    .\scripts\select-xpp-config.ps1
#>

$configDir = Join-Path $env:LOCALAPPDATA "Microsoft\Dynamics365\XPPConfig"

if (-not (Test-Path $configDir)) {
    Write-Host "No XPP config directory found at: $configDir" -ForegroundColor Yellow
    Write-Host "This directory is created by Power Platform Tools in VS2022." -ForegroundColor Gray
    exit 1
}

$configs = Get-ChildItem -Path $configDir -Filter "*.json" -File |
    Where-Object { $_.Name -match '^(.+)___(.+)\.json$' } |
    Sort-Object LastWriteTime -Descending

if ($configs.Count -eq 0) {
    Write-Host "No XPP config files found in: $configDir" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Available XPP Configs" -ForegroundColor Cyan
Write-Host "=====================" -ForegroundColor Cyan
Write-Host ""

for ($i = 0; $i -lt $configs.Count; $i++) {
    $file = $configs[$i]
    $match = [regex]::Match($file.Name, '^(.+)___(.+)\.json$')
    $name = $match.Groups[1].Value
    $version = $match.Groups[2].Value

    $json = Get-Content $file.FullName -Raw | ConvertFrom-Json
    $customPath = $json.ModelStoreFolder
    $msPath = $json.FrameworkDirectory

    $newest = if ($i -eq 0) { " (newest)" } else { "" }

    Write-Host "  [$($i + 1)] " -NoNewline -ForegroundColor White
    Write-Host "$name" -NoNewline -ForegroundColor Green
    Write-Host "  v$version$newest" -ForegroundColor Gray
    Write-Host "      Custom:    $customPath" -ForegroundColor DarkGray
    Write-Host "      Microsoft: $msPath" -ForegroundColor DarkGray
    Write-Host ""
}

$selection = Read-Host "Select config (1-$($configs.Count)), or Enter for newest"

if ([string]::IsNullOrWhiteSpace($selection)) {
    $selected = $configs[0]
} else {
    $idx = [int]$selection - 1
    if ($idx -lt 0 -or $idx -ge $configs.Count) {
        Write-Host "Invalid selection." -ForegroundColor Red
        exit 1
    }
    $selected = $configs[$idx]
}

$configName = $selected.BaseName  # filename without .json

Write-Host ""
Write-Host "Selected: $configName" -ForegroundColor Green

# Update .env file
$envFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    if ($content -match '(?m)^XPP_CONFIG_NAME=.*$') {
        $content = $content -replace '(?m)^XPP_CONFIG_NAME=.*$', "XPP_CONFIG_NAME=$configName"
    } elseif ($content -match '(?m)^#\s*XPP_CONFIG_NAME=') {
        $content = $content -replace '(?m)^#\s*XPP_CONFIG_NAME=.*$', "XPP_CONFIG_NAME=$configName"
    } else {
        $content = $content.TrimEnd() + "`nXPP_CONFIG_NAME=$configName`n"
    }
    Set-Content $envFile -Value $content -NoNewline
    Write-Host "Updated .env: XPP_CONFIG_NAME=$configName" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "No .env file found. Add this to your .env:" -ForegroundColor Yellow
    Write-Host "  XPP_CONFIG_NAME=$configName" -ForegroundColor White
}
