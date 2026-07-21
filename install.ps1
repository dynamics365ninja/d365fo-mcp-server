# D365 F&O MCP Server - one-line installer (Windows PowerShell 5.1+ / PowerShell 7+)
#
#   irm https://raw.githubusercontent.com/dynamics365ninja/d365fo-mcp-server/main/install.ps1 | iex
#
# Bootstraps a full installation and hands off to the interactive setup wizard,
# which asks where the configuration and the metadata index should live and
# builds the C# bridge. Safe to re-run.
#
# There are two paths, because the package on npm became a full installation
# (it carries the C# bridge sources and the index scripts) while every
# installation made before that is a git checkout:
#
#   fresh machine      npm install -g d365fo-mcp  ->  d365fo-mcp setup
#   existing checkout  git pull + npm install     ->  npm run setup
#
# The checkout path is kept because those installations already hold a
# configuration and a multi-gigabyte index in the checkout itself. Switching
# them to a global install would leave two copies of everything and rebuild an
# index that takes hours, so a checkout is detected and updated in place. Only
# that path needs Git at all.
#
# The script is piped through Invoke-Expression, so configuration is taken from
# environment variables instead of parameters:
#
#   $env:D365FO_MCP_DIR = 'D:\tools\d365fo-mcp-server'   # where to look for an existing checkout
#   $env:D365FO_MCP_YES = '1'                            # non-interactive: accept all defaults
#   $env:D365FO_MCP_NO_WIZARD = '1'                      # install only, skip the wizard
#
# D365FO VMs are Windows Server, where winget is usually unavailable - Node.js
# falls back to the official MSI (nodejs.org) and Git to portable MinGit.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$MinNodeMajor = 24
# Pinned MinGit fallback for machines without winget (Windows Server). Portable,
# extracted under %LOCALAPPDATA% - used only when git is not already installed.
$MinGitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'

function Write-Step([string]$msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Note([string]$msg)  { Write-Host "  * $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "  x $msg" -ForegroundColor Red; exit 1 }

$NonInteractive = $env:D365FO_MCP_YES -and $env:D365FO_MCP_YES -ne '0' -and $env:D365FO_MCP_YES -ne 'false'

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
    if (-not $version) { Fail "No Node.js v$MinNodeMajor release found on nodejs.org - install manually from https://nodejs.org" }
    $msi = Join-Path $env:TEMP "node-$version-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$version/node-$version-x64.msi" -OutFile $msi
    if (Test-Admin) {
        Write-Step "Installing Node.js $version (silent)"
        $proc = Start-Process msiexec -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Fail "Node.js MSI install failed (exit $($proc.ExitCode))" }
    } elseif ($NonInteractive) {
        Fail "Installing Node.js needs an elevated shell in non-interactive mode. Run PowerShell as Administrator, or install Node.js $MinNodeMajor LTS from https://nodejs.org and re-run."
    } else {
        Write-Step "Installing Node.js $version - the installer window will ask for elevation"
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
    if (-not (Test-Cmd node)) { Fail 'Node.js still not on PATH - open a new PowerShell window and re-run this script.' }
    $major = [int]((node -v) -replace '^v(\d+)\..*', '$1')
    if ($major -lt $MinNodeMajor) { Fail "Node.js $(node -v) is still below $MinNodeMajor - install Node $MinNodeMajor LTS from https://nodejs.org and re-run." }
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
    # Portable MinGit fallback - no installer, no elevation needed.
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
    if (-not (Test-Cmd git)) { Fail 'Git installation failed - install Git from https://git-scm.com and re-run.' }
    Write-Ok "$(git --version) (portable)"
}

# Locate an installation made before the npm package became self-contained.
#
# Probed rather than asked: a fresh install has no directory to name any more
# (the wizard asks where the data should live, and the code goes to the global
# node_modules), so prompting everyone for a path only to ignore it would be
# worse than silent detection. The candidates are exactly the defaults previous
# versions of this script used.
function Find-Checkout {
    $candidates = @()
    if ($env:D365FO_MCP_DIR) { $candidates += $env:D365FO_MCP_DIR }
    $candidates += 'K:\d365fo-mcp-server'
    $candidates += (Join-Path $env:USERPROFILE 'd365fo-mcp-server')

    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir '.git')) { return $dir }
    }
    # An explicitly named directory that holds something else is a mistake worth
    # stopping on: installing beside it would leave two installations.
    if ($env:D365FO_MCP_DIR -and (Test-Path $env:D365FO_MCP_DIR) -and (Get-ChildItem $env:D365FO_MCP_DIR -Force | Select-Object -First 1)) {
        Fail "$($env:D365FO_MCP_DIR) exists, is not empty, and is not a git checkout. Empty it or point `$env:D365FO_MCP_DIR elsewhere."
    }
    return $null
}

# The pre-npm layout: sources, dependencies, configuration and index all in one
# checkout. Updated in place, exactly as earlier versions of this script did.
function Update-Checkout([string]$dir) {
    Write-Note "Existing checkout found at $dir - updating it in place."
    Write-Note 'Installations made this way keep their configuration and index in the checkout, so they are left as they are.'
    Ensure-Git

    Write-Step "Updating $dir"
    git -C $dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail 'git pull failed - resolve the conflict in the install directory and re-run.' }

    Push-Location $dir
    try {
        Write-Step 'Installing dependencies (npm install)'
        npm install
        if ($LASTEXITCODE -ne 0) { Fail 'npm install failed - see the error above (better-sqlite3 needs a prebuilt binary or Python + build tools).' }

        if ($env:D365FO_MCP_NO_WIZARD) {
            Write-Note 'Skipping the setup wizard (D365FO_MCP_NO_WIZARD set).'
            Write-Host ''
            Write-Host "Next: cd $dir; npm run setup" -ForegroundColor Magenta
            return
        }
        Write-Step 'Starting the setup wizard'
        npm run setup
        Write-Host ''
        Write-Host 'Useful commands (run from the install directory):' -ForegroundColor Magenta
        Write-Host '  npm run doctor        health check'
        Write-Host '  npm run cli -- start  run the server'
        Write-Host '  npm run cli -- update update to the latest version'
    } finally {
        Pop-Location
    }
}

# The npm path: no clone, no build, no Git. The package carries the compiled
# server, the index scripts and the C# bridge sources; the wizard asks where the
# configuration and the index should live and builds the bridge from there.
function Install-FromNpm {
    Write-Step 'Installing d365fo-mcp from npm'
    npm install -g d365fo-mcp@latest
    if ($LASTEXITCODE -ne 0) { Fail 'npm install -g failed - see the error above.' }
    # The npm global bin directory may have been added to PATH by an installer
    # that ran moments ago in this same session.
    Refresh-Path

    if (-not (Test-Cmd 'd365fo-mcp')) {
        Fail 'd365fo-mcp installed but is not on PATH - open a new PowerShell window and run: d365fo-mcp setup'
    }
    Write-Ok 'd365fo-mcp installed'

    if ($env:D365FO_MCP_NO_WIZARD) {
        Write-Note 'Skipping the setup wizard (D365FO_MCP_NO_WIZARD set).'
        Write-Host ''
        Write-Host 'Next: d365fo-mcp setup' -ForegroundColor Magenta
        return
    }

    Write-Step 'Starting the setup wizard'
    d365fo-mcp setup
    Write-Host ''
    Write-Host 'Useful commands (from anywhere):' -ForegroundColor Magenta
    Write-Host '  d365fo-mcp doctor     health check'
    Write-Host '  d365fo-mcp start      run the server'
    Write-Host '  d365fo-mcp update     update to the latest release'
}

# --- main -------------------------------------------------------------------

if ($env:OS -ne 'Windows_NT') {
    Fail 'This installer targets Windows (D365FO development VMs). On other platforms clone the repo and run: npm install && npm run setup'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

Write-Host ''
Write-Host 'D365 F&O MCP Server - installer' -ForegroundColor Magenta
Write-Host ''

Write-Step 'Checking prerequisites'
Ensure-Node

$checkout = Find-Checkout
if ($checkout) {
    Update-Checkout $checkout
} else {
    Install-FromNpm
}
