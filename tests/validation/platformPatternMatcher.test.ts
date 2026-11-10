/**
 * The form pattern validator against the platform's own verdicts.
 *
 * tests/fixtures/formPatterns/*.xml are small forms in the shapes measured on
 * shipped forms (Task, TaskParentChild, Dialog with FillText, CustomFilters,
 * ToolbarList), half of them broken in the ways the compiler rejected while real
 * forms were being converted to standard patterns. platform-verdicts.json holds
 * what Microsoft's PatternAnalyzer — the engine the X++ compiler runs — said
 * about every patterned node of every fixture (regenerate on Windows with
 * `npx tsx scripts/oracles/patternAnalyzer.ts verdicts`).
 *
 * The bar: for every node the engine accepts we raise no error, for every node it
 * rejects we raise at least one, naming the same property where the engine
 * named one, and for a pattern the platform does not define (ok = null) we raise
 * FP001 or FP002.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validateFormPatternXml, type FormPatternViolation } from '../../src/validation/formPatternValidator';
import { findControlElementOrderViolations } from '../../src/validation/formControlElementOrder';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'formPatterns');

interface Verdict {
  form: string;
  path: string;
  pattern: string;
  version: string;
  ok: boolean | null;
  detail: string;
}

const verdicts: Verdict[] = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'platform-verdicts.json'), 'utf8')).verdicts;
const forms = [...new Set(verdicts.map((v) => v.form))].sort();

/** 'Design/Tab[Tab]/TabPage[Overview]' → 'Design/Tab/Overview' (the engine's path style). */
function namePath(p: string): string {
  return p.replace(/\/[A-Za-z]+\[([^\]]+)\]/g, '/$1');
}

/** Our error-severity findings that belong to one patterned node. */
function errorsFor(v: Verdict, violations: FormPatternViolation[]): FormPatternViolation[] {
  const kind = v.path === 'Design' ? 'pattern' : 'sub-pattern';
  const label = `${kind} ${v.pattern} ${v.version}:`;
  return violations.filter((x) => {
    if (x.severity !== 'error') return false;
    const p = namePath(x.path);
    if (p !== v.path && !p.startsWith(`${v.path}/`)) return false;
    if (x.rule === 'FP001' || x.rule === 'FP002') return p === v.path;
    return x.excerpt.startsWith(label);
  });
}

describe('form pattern fixtures are valid AOT XML', () => {
  it.each(forms)('%s has every control element in canonical order', (form) => {
    const xml = fs.readFileSync(path.join(FIXTURES, `${form}.xml`), 'utf8');
    expect(findControlElementOrderViolations(xml)).toEqual([]);
  });
});

describe('validator agrees with the platform PatternAnalyzer', () => {
  it('covers accepted, rejected and undefined patterns', () => {
    expect(verdicts.some((v) => v.ok === true)).toBe(true);
    expect(verdicts.some((v) => v.ok === false)).toBe(true);
    expect(verdicts.some((v) => v.ok === null)).toBe(true);
  });

  it.each(verdicts.map((v) => [`${v.form} ${v.path} (${v.pattern} ${v.version})`, v] as const))('%s', async (_name, v) => {
    const xml = fs.readFileSync(path.join(FIXTURES, `${v.form}.xml`), 'utf8');
    const report = await validateFormPatternXml(xml);
    const ours = errorsFor(v, report.violations);
    if (v.ok === true) {
      expect(ours, JSON.stringify(ours, null, 1)).toEqual([]);
    } else if (v.ok === null) {
      expect(ours.map((x) => x.rule)).toEqual(expect.arrayContaining([expect.stringMatching(/^FP00[12]$/)]));
    } else {
      expect(ours.length, `engine: ${v.detail}`).toBeGreaterThan(0);
      // Where a control could fill more than one part, the engine and we may
      // blame different parts, so property names are compared only when the
      // structure itself is not in question.
      if (ours.some((x) => /^FP00[3457]$/.test(x.rule))) return;
      for (const m of v.detail.matchAll(/: (\w+) (?:Equals|Not|Contains) '/g)) {
        expect(ours.some((x) => x.rule === 'FP011' && x.excerpt.includes(`${m[1]} must be`)), `engine named ${m[1]}`).toBe(true);
      }
    }
  });
});

describe('the cases that bypassed FORM_PATTERN_ENFORCE', () => {
  async function errors(form: string): Promise<FormPatternViolation[]> {
    const xml = fs.readFileSync(path.join(FIXTURES, `${form}.xml`), 'utf8');
    return (await validateFormPatternXml(xml)).violations.filter((v) => v.severity === 'error');
  }

  it('accepts Task 1.2, TaskParentChild 1.2 with its splitter, FillText "UX7 1.0" with StaticText or String, and ToolbarList 1.2', async () => {
    for (const form of ['FpTaskSingle', 'FpTaskParentChild', 'FpTaskCustomFiltersFooter', 'FpDialogFillTextStaticText', 'FpDialogFillTextString', 'FpToolbarListCustomFilters']) {
      expect(await errors(form), form).toEqual([]);
    }
  });

  it('rejects TaskSingle and points to Task', async () => {
    const found = await errors('FpTaskSingleLegacyName');
    expect(found.map((v) => v.rule)).toContain('FP001');
    expect(found.find((v) => v.rule === 'FP001')!.fix).toContain('"Task"');
  });

  it('rejects a TaskParentChild without splitter and with a Group as the child part', async () => {
    const found = await errors('FpTaskParentChildGroupChild');
    expect(found.some((v) => v.rule === 'FP003' && /ChildTab/.test(v.excerpt))).toBe(true);
  });

  it('rejects FillText 1.0 and ToolbarList 1.1 as unknown versions', async () => {
    expect((await errors('FpFillTextLegacyVersion')).some((v) => v.rule === 'FP002' && v.fix.includes('UX7 1.0'))).toBe(true);
    expect((await errors('FpToolbarListOldVersion')).some((v) => v.rule === 'FP002' && v.fix.includes('1.2'))).toBe(true);
  });

  it('rejects the property defaults the compiler rejects', async () => {
    const heights = await errors('FpFillTextDefaultHeightMode');
    expect(heights.some((v) => v.rule === 'FP011' && v.excerpt.includes('HeightMode must be "SizeToAvailable", is "SizeToContent" (default)'))).toBe(true);
    const filters = await errors('FpCustomFiltersViewEditModeAuto');
    expect(filters.some((v) => v.rule === 'FP011' && v.excerpt.includes('ViewEditMode must be "Edit", is "Auto" (default)'))).toBe(true);
  });

  it('rejects a sub-pattern the part does not accept', async () => {
    const found = await errors('FpSubPatternWrongSlot');
    expect(found.some((v) => v.rule === 'FP007' && v.excerpt.includes('FieldsFieldGroups'))).toBe(true);
  });
});
