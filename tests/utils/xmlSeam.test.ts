/**
 * xml2js is reachable from exactly one module.
 *
 * The library has had no release since 0.6.2 (2023). It works, so replacing it
 * now would be churn — but it was imported directly in 15 modules, which turns
 * "swap the XML parser" into an audit of every XML call site. src/utils/xml.ts
 * is the seam that keeps that a one-file change; this test is what stops the
 * sixteenth direct import from being added.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Builder, Parser, parseStringPromise } from '../../src/utils/xml.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = join(repoRoot, 'src');
const SEAM = 'src/utils/xml.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('xml2js seam', () => {
  it('is the only module under src/ that imports xml2js', () => {
    const offenders = walk(srcRoot)
      .filter(f => /from\s+['"]xml2js['"]/.test(readFileSync(f, 'utf8')))
      .map(f => relative(repoRoot, f).replace(/\\/g, '/'))
      .filter(f => f !== SEAM);
    expect(offenders, `import xml2js through ${SEAM} instead`).toEqual([]);
  });

  it('re-exports the parser surface the call sites use', async () => {
    expect(typeof Parser).toBe('function');
    expect(typeof Builder).toBe('function');

    // explicitArray:false is what nearly every call site passes; a replacement
    // that silently returned arrays here would break them all at once.
    const parsed = await parseStringPromise('<AxTable><Name>CustTable</Name></AxTable>', {
      explicitArray: false,
    });
    expect(parsed.AxTable.Name).toBe('CustTable');

    const built = new Builder({ headless: true }).buildObject({ AxTable: { Name: 'CustTable' } });
    expect(built).toContain('<Name>CustTable</Name>');
  });
});
