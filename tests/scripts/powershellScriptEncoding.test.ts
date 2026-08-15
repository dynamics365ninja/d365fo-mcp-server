/**
 * Encoding rules for the .ps1 scripts the CLI spawns.
 *
 * Windows PowerShell 5.1 is the only PowerShell on a stock D365FO dev box, so
 * every `pwsh ?? powershell` fallback in the CLI is the normal path rather than
 * the exotic one. Two of its behaviours are silent enough to have shipped
 * unnoticed, and CI runs on Linux where neither can be reproduced — so both are
 * asserted against the script text instead.
 *
 * 1. A BOM-less .ps1 is read as the ANSI codepage. Every script here is
 *    BOM-less UTF-8 (see .gitattributes: everything is text, LF, no exceptions),
 *    so a U+2014 em dash arrives as three CP1252 characters ending in U+201D —
 *    a smart quote, which PowerShell accepts as a string DELIMITER. An em dash
 *    inside a double-quoted string therefore closes it early and the rest of the
 *    line becomes bare tokens. extract-bp-catalog.ps1 died on
 *    `throw "... $dynamicsDir — pass -PackagesPath explicitly."` with
 *    "Unexpected token 'pass'", before a single statement ran.
 *
 * 2. `Set-Content -Encoding utf8` writes a BOM under 5.1 (but not under pwsh 7),
 *    and JSON.parse rejects the leading \uFEFF (EF BB BF).
 *
 * Both are asserted as rules rather than as the specific symptoms that were
 * fixed, because the next em dash someone types in a string, or the next
 * Set-Content, would fail the same silent way.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SCRIPT_DIRS = ['scripts', 'instances'];

/** Every .ps1 in the repo, as [relative path, source]. */
function powershellScripts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const dir of SCRIPT_DIRS) {
    const abs = join(process.cwd(), dir);
    for (const name of readdirSync(abs)) {
      if (name.endsWith('.ps1')) out.push([`${dir}/${name}`, readFileSync(join(abs, name), 'utf-8')]);
    }
  }
  return out;
}

const SCRIPTS = powershellScripts();

describe('PowerShell script encoding', () => {
  it('finds the scripts it is meant to be guarding', () => {
    // A readdir that silently returned nothing would make every assertion below
    // pass without checking anything.
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(7);
    expect(SCRIPTS.map(([p]) => p)).toContain('scripts/extract-bp-catalog.ps1');
  });

  it.each(SCRIPTS)('%s is pure ASCII', (_path, source) => {
    const nonAscii = [...source]
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.charCodeAt(0) > 127)
      .map(([c, i]) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} at offset ${i}`);

    expect(nonAscii).toEqual([]);
  });

  it.each(SCRIPTS)('%s carries no UTF-8 BOM', (_path, source) => {
    // Adding a BOM would also fix rule 1, but it is not the repo's answer: the
    // other six scripts are BOM-less, and .gitattributes normalises everything
    // here as plain LF text.
    expect(source.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('extract-bp-catalog.ps1 JSON output', () => {
  const source = SCRIPTS.find(([p]) => p === 'scripts/extract-bp-catalog.ps1')![1];

  it('is written with an explicit BOM-less encoding', () => {
    expect(source).toMatch(/\[System\.IO\.File\]::WriteAllText\(/);
    expect(source).toMatch(/UTF8Encoding\(\$false\)/);
  });

  it('never pipes the JSON payload through Set-Content', () => {
    // Scoped to the JSON branch on purpose. The script's other output mode
    // writes the committed catalog.generated.ts TypeScript module, and tsc
    // tolerates a BOM there — that branch predates this one and is not what
    // breaks.
    expect(source).not.toMatch(/ConvertTo-Json[^\r\n]*\|[^\r\n]*Set-Content/i);
  });
});
