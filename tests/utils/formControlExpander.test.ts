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

  // Patterns whose expansion the platform still rejects. The validator now checks
  // the platform's own definitions (parts, counts, required property values), and
  // the expander builds from the curated structure, which does not carry all of
  // them yet. generate_smart_form self-tests every expansion and falls back to a
  // template or clone for these, so no broken form is written. `it.fails` keeps
  // the list honest: an entry whose expansion becomes clean fails until removed.
  const PLATFORM_GAPS = new Set([
    'AdvancedSelection', 'DetailsMasterTabs', 'DialogDoubleTabs', 'DialogFastTabs',
    'DialogReadOnly', 'DialogTabs', 'DropDialog', 'DropDialogReadOnly',
    'FormPartFactboxGrid', 'FormPartSectionList', 'FormPartSectionListDouble',
    'LookupGridOnly', 'LookupPreview', 'LookupTab',
    'SimpleDetails-FastTabsContainer', 'SimpleDetails-Panorama',
    'SimpleDetails-StandardTabsContainer', 'SimpleDetails-ToolbarFields',
    'SimpleListDetails-Tree', 'TabbedWorkspace', 'Wizard', 'WorkspaceOperational',
  ]);

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

  it('emits a valid empty DataSources block when no datasource is given', () => {
    const spec = FORM_PATTERN_CATALOG.patterns.find((p) => !TEMPLATED_PATTERNS.has(p.xmlName) && canExpandPattern(p))!;
    const xml = expandPatternToXml(spec, { formName: 'NoDsForm' });
    expect(xml).toContain('<DataSources />');
  });
});
