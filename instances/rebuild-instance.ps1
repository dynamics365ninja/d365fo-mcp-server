<#
.SYNOPSIS
    Rebuild (reindex) the databases of one or all MCP server instances.
.DESCRIPTION
    Wrapper around: d365fo-mcp index [name] [--all]

    Runs a full reindex (extract + build database) from the CURRENT source. It
    does NOT update the server binaries: dist\ is repo-global, so after a
    git pull run `npm install; npm run build` once and restart the instances.
    Reindex only when the pull changed the parser, the extraction or the DB
    schema - most changes are runtime-only.
.EXAMPLE
    .\instances\rebuild-instance.ps1 clientA
.EXAMPLE
    .\instances\rebuild-instance.ps1 -All
#>
param(
    [string]$InstanceName,
    [switch]$All
)

. (Join-Path $PSScriptRoot '_cli.ps1')

$cliArgs = @('index')
if ($InstanceName) { $cliArgs += $InstanceName }
if ($All) { $cliArgs += '--all' }

Invoke-D365foMcp @cliArgs
