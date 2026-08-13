<#
.SYNOPSIS
    Regenerate the Best-Practice-rule moniker catalog from a local D365FO install.
.DESCRIPTION
    Ground truth for bp_moniker (src/knowledge/bpMonikers/) instead of a
    hand-typed list — every moniker has been guessed wrong at least once
    (issue: assistant proposed a moniker it could not verify, corrected only
    by reading the xppc log by hand).

    Two real sources on any D365FO dev box, both under PackagesLocalDirectory:

    1. Canonical names — every model ships
       <Model>/<Model>/AxRuleSet/BPRules.xml, a flat list of the monikers that
       model's BP rules can raise. The union across all models is the full
       canonical name set. This is what a *validate* lookup checks against.

    2. Real message/description text — the .NET-authored rule assemblies under
       bin/BPExtensions/*.dll (and a couple of core bin/*.dll) each carry a
       generated resx-backed `...Messages` (or `...DiagnosticItems` /
       `...Properties.Resources`) class: one string keyed by the moniker itself
       (the message template, with `{0}`-style placeholders) and, where the
       rule author wrote one, a second string keyed `<Moniker>Description`.
       This is what a *search* lookup matches against — real rule text, not a
       guess from the PascalCase name.

    Coverage of source 2 is high but not total — at the last extraction 545 of
    577 entries carried a real message and 221 also carried a description, so
    only 32 are name-only. The catalog marks a gap explicitly (`message` and
    `description` are null) rather than leaving it ambiguous, and a consumer
    must not treat "no description" as "not a real moniker".

    The reverse matters more: source 2 is a resource dump, so it also yields
    strings that are NOT BP rules — messages belonging to the upgrade and
    form-conversion tooling (DEC*, ActionPane*, ...). Those come out with
    `canonical: false` because no AxRuleSet lists them. `canonical` is the only
    field that answers "is this a BP rule"; presence in the catalog is not
    enough on its own.

    Output is a generated TypeScript module, not JSON — this project embeds
    knowledge data directly (see src/tools/knowledge/xppKnowledge.ts) so it
    ships in dist/ via the normal tsc build with no separate copy step.
.PARAMETER PackagesPath
    Root PackagesLocalDirectory to scan. Defaults to the newest
    %LOCALAPPDATA%\Microsoft\Dynamics365\<version>\PackagesLocalDirectory found.
.PARAMETER OutFile
    When given, write a JSON file at this path instead of the default
    src\knowledge\bpMonikers\catalog.generated.ts TypeScript module. Used by
    the instance CLI (`d365fo-mcp instance rebuild/upgrade`) to give each
    instance its own catalog, matching that instance's actual D365FO version,
    instead of everyone sharing the one committed snapshot.
.PARAMETER Version
    Stamped into the JSON output's `version` field alongside PackagesPath, so
    the caller's staleness check has something to compare against on the next
    run. Only meaningful with -OutFile; ignored otherwise. Purely a passthrough
    — this script does not attempt to discover the version itself, since a UDE
    config filename and a traditional-environment mtime hash are discovered
    differently and that logic belongs with the caller.
.EXAMPLE
    .\scripts\extract-bp-catalog.ps1
.EXAMPLE
    .\scripts\extract-bp-catalog.ps1 -PackagesPath "K:\AosService\PackagesLocalDirectory"
.EXAMPLE
    .\scripts\extract-bp-catalog.ps1 -PackagesPath "K:\AosService\PackagesLocalDirectory" -OutFile "instances\clientA\data\bp-moniker-catalog.json" -Version "10.0.2527.174"
#>
param(
    [string]$PackagesPath,
    [string]$OutFile,
    [string]$Version
)

$ErrorActionPreference = 'Stop'

if (-not $PackagesPath) {
    $dynamicsDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Dynamics365'
    $candidate = Get-ChildItem $dynamicsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'PackagesLocalDirectory\bin') } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        throw "No PackagesLocalDirectory found under $dynamicsDir — pass -PackagesPath explicitly."
    }
    $PackagesPath = Join-Path $candidate.FullName 'PackagesLocalDirectory'
}
if (-not (Test-Path $PackagesPath)) {
    throw "PackagesPath does not exist: $PackagesPath"
}
$binDir = Join-Path $PackagesPath 'bin'
Write-Host "Scanning: $PackagesPath"

# ── 1. Canonical names: union of every AxRuleSet/BPRules.xml ────────────────
$canonical = [System.Collections.Generic.SortedSet[string]]::new()
$ruleSetFiles = Get-ChildItem $PackagesPath -Recurse -Filter 'BPRules.xml' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\AxRuleSet\\' }
Write-Host "AxRuleSet/BPRules.xml files found: $($ruleSetFiles.Count)"
foreach ($f in $ruleSetFiles) {
    try {
        [xml]$xml = Get-Content $f.FullName -Raw
        foreach ($node in $xml.RuleSet.Rules.Rule) {
            $m = $node.Moniker
            if ($m) { [void]$canonical.Add($m.Trim()) }
        }
    } catch {
        Write-Warning "Skipped $($f.FullName): $_"
    }
}
Write-Host "Canonical monikers: $($canonical.Count)"

# ── 2. Real message/description text from the .NET-authored rule DLLs ──────
# AssemblyResolve against bin/ and bin/BPExtensions/ so cross-referenced
# assemblies (the framework, MEF contracts, etc.) load without a manual list.
$searchDirs = @($binDir, (Join-Path $binDir 'BPExtensions'))
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
    param($assemblySender, $resolveArgs)
    $name = ([System.Reflection.AssemblyName]$resolveArgs.Name).Name
    foreach ($dir in $searchDirs) {
        $candidate = Join-Path $dir "$name.dll"
        if (Test-Path $candidate) {
            try { return [System.Reflection.Assembly]::LoadFrom($candidate) } catch { return $null }
        }
    }
    return $null
})

# messages[moniker] = @{ message = ...; description = ... }
$messages = @{}
$dllTargets = @(Get-ChildItem $binDir -Filter '*.dll' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'BestPractice' })
$dllTargets += Get-ChildItem (Join-Path $binDir 'BPExtensions') -Filter '*.dll' -ErrorAction SilentlyContinue
Write-Host "Rule DLLs to reflect over: $($dllTargets.Count)"

foreach ($dll in $dllTargets) {
    try {
        $asm = [System.Reflection.Assembly]::LoadFrom($dll.FullName)
    } catch {
        Write-Warning "Load failed, skipped: $($dll.Name) — $($_.Exception.Message)"
        continue
    }
    $types = $null
    try { $types = $asm.GetTypes() } catch { $types = $_.Exception.Types | Where-Object { $_ } }
    if (-not $types) { continue }

    foreach ($t in $types) {
        $rmProp = $t.GetProperty('ResourceManager')
        if (-not $rmProp -or $rmProp.PropertyType.Name -ne 'ResourceManager') { continue }
        try {
            $rm = $rmProp.GetValue($null)
            $set = $rm.GetResourceSet([System.Globalization.CultureInfo]::CurrentCulture, $true, $true)
        } catch { continue }

        $raw = @{}
        foreach ($entry in $set.GetEnumerator()) {
            if ($entry.Value -is [string]) { $raw[[string]$entry.Key] = [string]$entry.Value }
        }
        foreach ($key in $raw.Keys) {
            if ($key.EndsWith('Description')) { continue }
            $moniker = $key
            $descKey = "${key}Description"
            $entryData = @{ message = $raw[$key]; description = $(if ($raw.ContainsKey($descKey)) { $raw[$descKey] } else { $null }) }
            # First writer wins — DLLs are processed in a stable order and a
            # duplicate key across assemblies has always meant the same rule.
            if (-not $messages.ContainsKey($moniker)) { $messages[$moniker] = $entryData }
        }
    }
}
Write-Host "Monikers with real message/description text: $($messages.Count)"

# ── 3. Merge ──────────────────────────────────────────────────────────────
# Union of both sources — a resource-only key not in any AxRuleSet.xml (e.g. a
# retired or reassigned rule) is still a real moniker worth keeping resolvable.
$allMonikers = [System.Collections.Generic.SortedSet[string]]::new()
foreach ($m in $canonical) { [void]$allMonikers.Add($m) }
foreach ($m in $messages.Keys) { [void]$allMonikers.Add($m) }

if ($OutFile) {
    # ── JSON mode: one instance's own catalog, matching its own version ────
    $entries = foreach ($m in $allMonikers) {
        $hasResource = $messages.ContainsKey($m)
        [PSCustomObject]@{
            moniker     = $m
            message     = if ($hasResource) { $messages[$m].message } else { $null }
            description = if ($hasResource) { $messages[$m].description } else { $null }
            canonical   = $canonical.Contains($m)
        }
    }
    $payload = [PSCustomObject]@{
        generatedAt  = (Get-Date).ToString('o')
        packagesPath = $PackagesPath
        version      = $Version
        entries      = @($entries)
    }
    $outDir = Split-Path $OutFile -Parent
    if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    $payload | ConvertTo-Json -Depth 5 | Set-Content -Path $OutFile -Encoding utf8
    Write-Host "Wrote $($allMonikers.Count) entries to $OutFile"
    Write-Host "  canonical (in an AxRuleSet):        $($canonical.Count)"
    Write-Host "  with real message/description text: $($messages.Count)"
    return
}

function ToJsStringLiteral($s) {
    # No [string] type constraint on the parameter — PowerShell coerces a
    # bound $null argument to '' before the body ever runs, which silently
    # turned "no resource entry at all" into the same '' as "resource entry
    # present but blank". Checking $null here, before any cast, is the point.
    if ($null -eq $s) { return 'null' }
    $s = [string]$s
    $escaped = $s.Replace('\', '\\').Replace("'", "\'").Replace("`n", '\n').Replace("`r", '')
    return "'$escaped'"
}

$lines = New-Object System.Collections.Generic.List[string]
foreach ($m in $allMonikers) {
    $hasResource = $messages.ContainsKey($m)
    $msg = if ($hasResource) { $messages[$m].message } else { $null }
    $desc = if ($hasResource) { $messages[$m].description } else { $null }
    $inCanonical = $canonical.Contains($m)
    $lines.Add("  { moniker: $(ToJsStringLiteral $m), message: $(ToJsStringLiteral $msg), description: $(ToJsStringLiteral $desc), canonical: $($inCanonical.ToString().ToLower()) },")
}

$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\knowledge\bpMonikers'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir 'catalog.generated.ts'

# A literal (single-quoted) here-string: no PowerShell escape processing, so
# the backticks in the prose below (Markdown code-spans) stay literal instead
# of being read as `n / `d / `m escape sequences — which is what corrupted an
# earlier version of this file (backtick-n silently became a real newline
# and ate the following character).
$header = @'
/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   pwsh scripts/extract-bp-catalog.ps1
 *
 * BP-rule moniker catalog, extracted from a local D365FO install:
 *   - `canonical: true` monikers come from the union of every model's
 *     <Model>/<Model>/AxRuleSet/BPRules.xml — the authoritative name list.
 *   - `message`/`description` come from the .NET-authored rule DLLs'
 *     resx-backed resource classes (bin/BPExtensions/*.dll and a couple of
 *     core bin/*.dll) where the rule author provided one. A `null` there
 *     means "not found in a resource class", NOT "not a real rule".
 *   - Presence in this file does NOT by itself mean "BP rule". The resource
 *     dump also yields upgrade- and form-conversion-tool messages, which come
 *     out with `canonical: false`. `canonical` is the field that answers
 *     "is this a BP rule".
 *
 * Extracted from: __PACKAGES_PATH__
 * Generated at:   (stamp with the actual date when regenerating — omitted
 *                  here so re-running with no real change produces no diff)
 */

export interface BpMonikerEntry {
  moniker: string;
  /** Message template (often with '{0}'-style placeholders), or null if not found in a resource class. */
  message: string | null;
  /** What the rule checks, or null if not found in a resource class. */
  description: string | null;
  /** True if this moniker appears in at least one model's AxRuleSet/BPRules.xml. */
  canonical: boolean;
}

export const BP_MONIKER_CATALOG: BpMonikerEntry[] = [
'@
# Literal here-strings can't interpolate — splice the real path in afterward.
$header = $header.Replace('__PACKAGES_PATH__', $PackagesPath)

$footer = "];`n"

Set-Content -Path $outFile -Value $header -Encoding utf8
Add-Content -Path $outFile -Value $lines -Encoding utf8
Add-Content -Path $outFile -Value $footer -Encoding utf8

Write-Host "Wrote $($allMonikers.Count) entries to $outFile"
Write-Host "  canonical (in an AxRuleSet):        $($canonical.Count)"
Write-Host "  with real message/description text: $($messages.Count)"
