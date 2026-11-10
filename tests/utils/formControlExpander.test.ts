import { describe, it, expect } from 'vitest';
import { expandPatternToXml, canExpandPattern } from '../../src/utils/formControlExpander';
import { FORM_PATTERN_CATALOG } from '../../src/knowledge/formPatterns/index';
import { validateFormPatternXml } from '../../src/validation/formPatternValidator';

const TEMPLATED_PATTERNS = new Set([
  'SimpleList', 'SimpleListDetails', 'DetailsMaster', 'DetailsTransaction',
  'Dialog', 'TableOfContents', 'Lookup', 'ListPage', 'Workspace',
]);

const baseOpts = {
  formName: 'MyExpandedForm',
  dsName: 'MyTable',
  dsTable: 'MyTable',
  caption: 'My Form',
  gridFields: ['Name', 'Description'],
};

describe('expandPatternToXml — structural validity', () => {
  // The whole point of the expander is single-source-of-truth: generation reads
  // the same catalog the validator enforces, so output must be error-free.
  // Patterns the expander claims it can build (excludes wildcard-required and
  // version-less escape-hatch patterns, which fall back to templates/clone).
  const expandable = FORM_PATTERN_CATALOG.patterns.filter(
    (p) => !TEMPLATED_PATTERNS.has(p.xmlName) && canExpandPattern(p),
  );

  it('covers a non-trivial set of long-tail patterns', () => {
    expect(expandable.length).toBeGreaterThan(3);
  });

  // Patterns whose expansion the platform still rejects, each with the reason.
  // The expander builds from the same platform definitions the validator checks,
  // so this is empty. generate_smart_form self-tests every expansion and falls
  // back to a template or clone for an entry, so no broken form is written.
  // `it.fails` keeps the list honest: an entry whose expansion becomes clean
  // fails until removed.
  const PLATFORM_GAPS = new Set<string>([]);

  for (const spec of expandable) {
    const test = PLATFORM_GAPS.has(spec.xmlName) ? it.fails : it;
    test(`produces validator-clean XML for pattern "${spec.xmlName}" (id=${spec.id})`, async () => {
      const xml = expandPatternToXml(spec, baseOpts);
      const report = await validateFormPatternXml(xml);
      const errors = report.violations.filter((v) => v.severity === 'error');
      expect(
        errors,
        `Pattern ${spec.xmlName} produced errors:\n${errors.map((e) => `[${e.rule}] ${e.path}: ${e.excerpt}`).join('\n')}`,
      ).toEqual([]);
    });
  }
});

describe('expandPatternToXml — emitted shape', () => {
  it('declares the requested pattern and a known version on Design', async () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => !TEMPLATED_PATTERNS.has(p.xmlName) && canExpandPattern(p))!;
    const xml = expandPatternToXml(spec, baseOpts);
    expect(xml).toContain(`<Pattern xmlns="">${spec.xmlName}</Pattern>`);
    expect(xml).toContain(`<PatternVersion xmlns="">${spec.versions[0]}</PatternVersion>`);
    const report = await validateFormPatternXml(xml);
    expect(report.pattern).toBe(spec.xmlName);
  });

  it('binds a Grid to the primary datasource and renders field columns', () => {
    // pick a pattern whose root requires a Grid, if any
    const gridSpec = FORM_PATTERN_CATALOG.patterns.find(
      (p) => !TEMPLATED_PATTERNS.has(p.xmlName) && canExpandPattern(p) && JSON.stringify(p.root).includes('Grid'),
    );
    if (!gridSpec) return; // none in catalog → nothing to assert
    const xml = expandPatternToXml(gridSpec, baseOpts);
    expect(xml).toContain('<DataSource>MyTable</DataSource>');
    expect(xml).toContain('Grid_Name');
  });

  it('declares the first named sub-pattern on a sub-pattern part and expands it', async () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => p.xmlName === 'DetailsMasterTabs')!;
    const xml = expandPatternToXml(spec, baseOpts);
    expect(xml).toContain('<Pattern>CustomAndQuickFilters</Pattern>');
    expect(xml).toContain('<Name>QuickFilterControl</Name>');
    // The grid's DefaultAction names the sibling button the definition provides.
    expect(xml).toContain('<DefaultAction>MainGridDefaultAction</DefaultAction>');
    const report = await validateFormPatternXml(xml);
    expect(report.violations.filter((v) => v.rule === 'FP006')).toEqual([]);
  });

  // Found by running the expansions through the platform's PatternAnalyzer
  // (npm run oracle:form-expansions), which our validator alone did not catch.
  it('gives every control a unique name when a pattern has two grids', () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => p.xmlName === 'AdvancedSelection')!;
    const xml = expandPatternToXml(spec, baseOpts);
    const names = [...xml.matchAll(/<AxFormControl[^>]*>\s*<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(4);
    expect(new Set(names).size).toBe(names.length);
    expect(xml).toContain('Grid_Name');
    expect(xml).toContain('SelectedGrid_Name');
  });

  it('points each QuickFilter at the grid it filters, not the first grid of the form', () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => p.xmlName === 'DetailsMasterTabs')!;
    const xml = expandPatternToXml(spec, baseOpts);
    const targets = [...xml.matchAll(/<Name>targetControlName<\/Name>\s*<Type>String<\/Type>\s*<Value>([^<]+)<\/Value>/g)].map((m) => m[1]);
    expect(targets).toEqual(['ListStyleGrid', 'MainGrid']);
  });

  it('writes no Controls element on buttons, fields or plain extension controls', () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => p.xmlName === 'DetailsMasterTabs')!;
    const xml = expandPatternToXml(spec, baseOpts);
    const leaf = /<AxFormControl xmlns=""(?: i:type="AxForm(?:CommandButton|String)Control")?>\s*<Name>(MainGridDefaultAction|HeaderTitle|QuickFilter)<\/Name>[\s\S]*?<\/AxFormControl>/g;
    const leaves = [...xml.matchAll(leaf)];
    expect(leaves.length).toBe(3);
    for (const m of leaves) expect(m[0]).not.toContain('<Controls');
  });

  it("writes a plain extension control's WidthMode before its FormControlExtension", () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => p.xmlName === 'DetailsMasterTabs')!;
    const xml = expandPatternToXml(spec, baseOpts);
    const quickFilter = /<AxFormControl xmlns="">\s*<Name>QuickFilter<\/Name>[\s\S]*?<\/AxFormControl>/.exec(xml)![0];
    expect(quickFilter.indexOf('<WidthMode>')).toBeGreaterThan(0);
    expect(quickFilter.indexOf('<WidthMode>')).toBeLessThan(quickFilter.indexOf('<FormControlExtension>'));
  });

  it('expands every catalog pattern the platform defines', () => {
    const notExpandable = FORM_PATTERN_CATALOG.patterns
      .filter((p) => p.versions.length > 0 && !canExpandPattern(p))
      .map((p) => p.xmlName);
    expect(notExpandable).toEqual([]);
  });

  it('emits a valid empty DataSources block when no datasource is given', () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => !TEMPLATED_PATTERNS.has(p.xmlName) && canExpandPattern(p))!;
    const xml = expandPatternToXml(spec, { formName: 'NoDsForm' });
    expect(xml).toContain('<DataSources />');
  });
});
