# D365 F&O MCP Server — one-line installer (Windows PowerShell 5.1+ / PowerShell 7+)
#
#   irm https://raw.githubusercontent.com/dynamics365ninja/d365fo-mcp-server/main/install.ps1 | iex
#
# Bootstraps a full installation: verifies (and installs, if missing) Node.js 24+
# and Git, clones the repository, runs npm install, and hands off to the
# interactive setup wizard (npm run setup). Safe to re-run — an existing
# installation is updated (git pull) instead of re-cloned.
#
# The script is piped through Invoke-Expression, so configuration is taken from
# environment variables instead of parameters:
#
#   $env:D365FO_MCP_DIR = 'D:\tools\d365fo-mcp-server'   # install directory
#   $env:D365FO_MCP_YES = '1'                            # non-interactive: accept all defaults
#   $env:D365FO_MCP_NO_WIZARD = '1'                      # clone + npm install only, skip the wizard
#
# D365FO VMs are Windows Server, where winget is usually unavailable — Node.js
# falls back to the official MSI (nodejs.org) and Git to portable MinGit.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoUrl = 'https://github.com/dynamics365ninja/d365fo-mcp-server.git'
$MinNodeMajor = 24
# Pinned MinGit fallback for machines without winget (Windows Server). Portable,
# extracted under %LOCALAPPDATA% — used only when git is not already installed.
$MinGitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'

function Write-Step([string]$msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Note([string]$msg)  { Write-Host "  * $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "  x $msg" -ForegroundColor Red; exit 1 }

$NonInteractive = $env:D365FO_MCP_YES -and $env:D365FO_MCP_YES -ne '0' -and $env:D365FO_MCP_YES -ne 'false'

function Ask-Default([string]$question, [string]$default) {
    if ($NonInteractive) { return $default }
    $answer = Read-Host "$question [$default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim().Trim('"')
}

# Re-read PATH from the registry so tools installed a moment ago resolve
# without opening a new shell.
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-Cmd([string]$name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-NodeMsi {
    Write-Step "Downloading Node.js $MinNodeMajor LTS from nodejs.org"
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $version = ($index | Where-Object { $_.version -match "^v$MinNodeMajor\." } | Select-Object -First 1).version
    if (-not $version) { Fail "No Node.js v$MinNodeMajor release found on nodejs.org — install manually from https://nodejs.org" }
    $msi = Join-Path $env:TEMP "node-$version-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$version/node-$version-x64.msi" -OutFile $msi
    if (Test-Admin) {
        Write-Step "Installing Node.js $version (silent)"
        $proc = Start-Process msiexec -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Fail "Node.js MSI install failed (exit $($proc.ExitCode))" }
    } elseif ($NonInteractive) {
        Fail "Installing Node.js needs an elevated shell in non-interactive mode. Run PowerShell as Administrator, or install Node.js $MinNodeMajor LTS from https://nodejs.org and re-run."
    } else {
        Write-Step "Installing Node.js $version — the installer window will ask for elevation"
        $proc = Start-Process msiexec -ArgumentList "/i `"$msi`"" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Fail "Node.js install did not complete (exit $($proc.ExitCode))" }
    }
    Refresh-Path
}

function Ensure-Node {
    if (Test-Cmd node) {
        $major = [int]((node -v) -replace '^v(\d+)\..*', '$1')
        if ($major -ge $MinNodeMajor) { Write-Ok "Node.js $(node -v)"; return }
        Write-Note "Node.js $(node -v) found, but $MinNodeMajor+ is required"
    }
    if (Test-Cmd winget) {
        Write-Step 'Installing Node.js LTS via winget'
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        Refresh-Path
    } else {
        Install-NodeMsi
    }
    if (-not (Test-Cmd node)) { Fail 'Node.js still not on PATH — open a new PowerShell window and re-run this script.' }
    $major = [int]((node -v) -replace '^v(\d+)\..*', '$1')
    if ($major -lt $MinNodeMajor) { Fail "Node.js $(node -v) is still below $MinNodeMajor — install Node $MinNodeMajor LTS from https://nodejs.org and re-run." }
    Write-Ok "Node.js $(node -v)"
}

function Ensure-Git {
    if (Test-Cmd git) { Write-Ok "$(git --version)"; return }
    if (Test-Cmd winget) {
        Write-Step 'Installing Git via winget'
        winget install --id Git.Git --accept-source-agreements --accept-package-agreements
        Refresh-Path
        if (Test-Cmd git) { Write-Ok "$(git --version)"; return }
    }
    # Portable MinGit fallback — no installer, no elevation needed.
    Write-Step 'Installing portable MinGit (no winget on this machine)'
    $minGitDir = Join-Path $env:LOCALAPPDATA 'd365fo-mcp\MinGit'
    $zip = Join-Path $env:TEMP 'MinGit.zip'
    Invoke-WebRequest $MinGitUrl -OutFile $zip
    Expand-Archive $zip -DestinationPath $minGitDir -Force
    $gitCmd = Join-Path $minGitDir 'cmd'
    $env:Path = "$gitCmd;$env:Path"
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$gitCmd*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$gitCmd", 'User')
    }
    if (-not (Test-Cmd git)) { Fail 'Git installation failed — install Git from https://git-scm.com and re-run.' }
    Write-Ok "$(git --version) (portable)"
}

# --- main -------------------------------------------------------------------

if ($env:OS -ne 'Windows_NT') {
    Fail 'This installer targets Windows (D365FO development VMs). On other platforms clone the repo and run: npm install && npm run setup'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

Write-Host ''
Write-Host 'D365 F&O MCP Server — installer' -ForegroundColor Magenta
Write-Host ''

Write-Step 'Checking prerequisites'
Ensure-Node
Ensure-Git

# Default next to the D365FO service volume when it exists (traditional VMs),
# otherwise the user profile (UDE / client machines).
if ($env:D365FO_MCP_DIR) {
    $installDir = $env:D365FO_MCP_DIR
} else {
    if (Test-Path 'K:\AosService') { $default = 'K:\d365fo-mcp-server' } else { $default = Join-Path $env:USERPROFILE 'd365fo-mcp-server' }
    $installDir = Ask-Default 'Install directory' $default
}

if (Test-Path (Join-Path $installDir '.git')) {
    Write-Step "Existing installation found — updating ($installDir)"
    git -C $installDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail 'git pull failed — resolve the conflict in the install directory and re-run.' }
} elseif ((Test-Path $installDir) -and (Get-ChildItem $installDir -Force | Select-Object -First 1)) {
    Fail "$installDir exists and is not empty (and is not a git checkout). Set `$env:D365FO_MCP_DIR to a different directory and re-run."
} else {
    Write-Step "Cloning into $installDir"
    git clone $RepoUrl $installDir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed — check network access to github.com.' }
}

Push-Location $installDir
try {
    Write-Step 'Installing dependencies (npm install)'
    npm install
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed — see the error above (better-sqlite3 needs a prebuilt binary or Python + build tools).' }

    if ($env:D365FO_MCP_NO_WIZARD) {
        Write-Note 'Skipping the setup wizard (D365FO_MCP_NO_WIZARD set).'
        Write-Host ''
        Write-Host "Next: cd $installDir; npm run setup" -ForegroundColor Magenta
    } else {
        Write-Step 'Starting the setup wizard'
        npm run setup
        Write-Host ''
        Write-Host 'Useful commands (run from the install directory):' -ForegroundColor Magenta
        Write-Host '  npm run doctor        health check'
        Write-Host '  npm run cli -- start  run the server'
        Write-Host '  npm run cli -- update update to the latest version'
    }
} finally {
    Pop-Location
}
