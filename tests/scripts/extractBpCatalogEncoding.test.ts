/**
 * extract-bp-catalog.ps1 must write its JSON output without a BOM.
 *
 * `Set-Content -Encoding utf8` means BOM-less UTF-8 under PowerShell 7 and
 * BOM-prefixed UTF-8 under Windows PowerShell 5.1. The CLI prefers pwsh but
 * falls back to powershell, and 5.1 is the only PowerShell on a stock D365FO
 * dev box — so the fallback path is the normal path, and both readers of this
 * file (loadCatalog and existingVersionKey) fail on the leading \uFEFF. Neither
 * failure is visible: the catalog silently reverts to the compiled snapshot,
 * and the version comparison never matches, so a multi-minute recursive scan of
 * PackagesLocalDirectory re-runs on every instance rebuild instead of never.
 *
 * A source assertion, not an execution one, deliberately: CI runs on Linux and
 * cannot exercise Windows PowerShell's encoding behaviour at all, so the only
 * place this regression can be caught is the script text.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'extract-bp-catalog.ps1');

describe('extract-bp-catalog.ps1 JSON output encoding', () => {
  const source = readFileSync(SCRIPT, 'utf-8');

  it('writes the -OutFile JSON with an explicit BOM-less encoding', () => {
    expect(source).toMatch(/UTF8Encoding\(\$false\)/);
    expect(source).toMatch(/\[System\.IO\.File\]::WriteAllText\(/);
  });

  it('is pure ASCII, so Windows PowerShell 5.1 can parse it at all', () => {
    // The script is BOM-less UTF-8, like every other .ps1 here. PowerShell 5.1
    // reads a BOM-less file as the ANSI codepage, so a U+2014 em dash arrives as
    // the three CP1252 characters â € ” — and that last one is a smart quote,
    // which PowerShell accepts as a string DELIMITER. An em dash inside a
    // double-quoted string therefore terminates it early and the rest of the
    // line becomes bare tokens: `throw "... $dynamicsDir — pass -PackagesPath"`
    // failed to parse with "Unexpected token 'pass'", taking the whole file
    // down before a single statement ran. The CLI spawns this script with
    // `powershell` whenever pwsh is absent, which on a stock D365FO dev box is
    // always — so the fallback path could never have worked.
    //
    // Sibling scripts (_cli.ps1, add-instance.ps1, …) are all ASCII already;
    // this asserts the rule rather than the symptom, because the next em dash
    // someone types in a string would break it again in the same silent way.
    const nonAscii = [...source].filter(c => c.charCodeAt(0) > 127);
    expect(nonAscii).toEqual([]);
  });

  it('never pipes the JSON payload through Set-Content', () => {
    // Scoped to the JSON branch on purpose. The script's other output mode
    // writes the committed catalog.generated.ts TypeScript module, and tsc
    // tolerates a BOM there — that branch predates this one and is not what
    // breaks.
    expect(source).not.toMatch(/ConvertTo-Json[^\r\n]*\|[^\r\n]*Set-Content/i);
  });
});
