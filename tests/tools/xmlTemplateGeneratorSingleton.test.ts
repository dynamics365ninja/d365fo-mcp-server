/**
 * There must be exactly ONE XML template generator.
 *
 * `XmlTemplateGenerator` used to be declared twice — in
 * `src/tools/write/createD365File.ts` and in `src/tools/xml/generateD365Xml.ts`
 * — with a comment on each half asserting they were mirrors of one another.
 * The 2026-08-25 audit compared them method by method: **26 of the 27 shared
 * methods had diverged**, and every divergence went the same way, a fix made on
 * the create side that never reached the generate mirror. The user-visible
 * consequence: `d365fo_file(action="generate")` dropped `#Library`/`#define`
 * macro directives out of a class declaration, so the XML it handed back
 * referenced an undefined macro and could not compile.
 *
 * Output-comparison tests cannot prevent that — `generateCreateParity.test.ts`
 * existed the whole time and passed, because it only covered the three methods
 * a previous incident had already exposed. A fork drifts in the methods nobody
 * thought to compare. So this test guards the STRUCTURE instead: one
 * declaration, one implementation of each builder, and every caller reaching
 * the same object.
 *
 * Same shape as the "no file re-declares a private base-type dictionary" guard
 * in axFieldTypes.test.ts, and for the same reason.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'tinyglobby';

const repoRoot = path.resolve(__dirname, '..', '..');
const CANONICAL = 'src/tools/xml/xmlTemplateGenerator.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('XmlTemplateGenerator is declared once', () => {
  const sources = globSync('src/**/*.ts', { cwd: repoRoot });

  it('only one file declares the class', () => {
    // Normalised to forward slashes: the glob's separator differs by platform,
    // and CI runs on Linux while this repo is developed on Windows.
    const declaring = sources
      .filter(rel => /\bclass XmlTemplateGenerator\b/.test(read(rel)))
      .map(rel => rel.replace(/\\/g, '/'));
    expect(
      declaring,
      `XmlTemplateGenerator must be declared only in ${CANONICAL}. A second declaration is how ` +
        'the last fork started: two copies, a fix applied to one of them, and a year of silent drift.',
    ).toEqual([CANONICAL]);
  });

  it('only that file implements the generateAx*Xml builders', () => {
    // A re-export (`export { XmlTemplateGenerator }`) is fine — that is how the
    // two former homes keep their published surface. An IMPLEMENTATION is not.
    const offenders: string[] = [];
    for (const rel of sources) {
      if (rel.replace(/\\/g, '/') === CANONICAL) continue;
      const text = read(rel);
      for (const m of text.matchAll(/^\s*static\s+(generateAx\w*Xml)\s*\(/gm)) {
        offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(
      offenders,
      'These files implement an AOT XML builder of their own. Import the canonical one instead — ' +
        'a second implementation is a fork whose two halves will diverge without anyone noticing.',
    ).toEqual([]);
  });

  it('the two former homes resolve to the same class object', async () => {
    const [canonical, fromCreate, fromGenerate] = await Promise.all([
      import('../../src/tools/xml/xmlTemplateGenerator'),
      import('../../src/tools/write/createD365File'),
      import('../../src/tools/xml/generateD365Xml'),
    ]);
    // Identity, not equality: this is what makes drift structurally impossible,
    // and it is stronger than any number of output comparisons.
    expect(fromCreate.XmlTemplateGenerator).toBe(canonical.XmlTemplateGenerator);
    expect(fromGenerate.XmlTemplateGenerator).toBe(canonical.XmlTemplateGenerator);
  });

  it('carries the macro-directive fix the generate fork was missing', async () => {
    // The concrete defect that the fork cost us, pinned so a future "simplify
    // this" cannot quietly drop it again: a class declaration holding a
    // #Library include must keep it, and it must come out ahead of the member
    // variables that may use it.
    const { XmlTemplateGenerator } = await import('../../src/tools/xml/xmlTemplateGenerator');
    const source = [
      'class ContosoProbe',
      '{',
      '    #Library',
      '    #define.MaxRows(100)',
      '    int rowCount;',
      '',
      '    public void run()',
      '    {',
      '        rowCount = #MaxRows;',
      '    }',
      '}',
    ].join('\n');

    const { declaration } = XmlTemplateGenerator.splitXppClassSource(source);
    expect(declaration).toContain('#Library');
    expect(declaration).toContain('#define.MaxRows(100)');
    expect(declaration.indexOf('#Library')).toBeLessThan(declaration.indexOf('int rowCount;'));
  });
});
