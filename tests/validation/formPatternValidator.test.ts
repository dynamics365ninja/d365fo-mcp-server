/**
 * Form Pattern Validator tests.
 *
 * Golden lock: every FormPatternTemplates builder output passes the validator
 * (which checks the platform pattern definitions the compiler uses)
 * with zero errors. Mutated/violating variants are rejected with the specific
 * FP rule.
 */

import { describe, it, expect } from 'vitest';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates';
import {
  validateFormPatternXml,
  validateFormTree,
  hasPatternErrors,
  type FormPatternReport,
} from '../../src/validation/formPatternValidator';
import { walkFormDesign, type FormControlNode, type FormDesignInfo } from '../../src/metadata/formPatternMiner';
import { Parser } from '../../src/utils/xml';

const templateOpts = {
  formName: 'FpvTestForm',
  dsName: 'TestDS',
  dsTable: 'TestTable',
  caption: 'Test',
  gridFields: ['Field1', 'Field2'],
  sections: [{ name: 'Section1', caption: 'Section 1' }],
  linesDsName: 'LinesDS',
  linesDsTable: 'LinesTable',
};

function rules(report: FormPatternReport, severity?: 'error' | 'warning'): string[] {
  return report.violations
    .filter((v) => !severity || v.severity === severity)
    .map((v) => v.rule);
}

// ── Golden lock: all templates pass with zero errors ─────────────────────────

describe('templates conform to the catalog (golden lock)', () => {
  const builders: Array<[string, () => string]> = [
    ['SimpleList', () => FormPatternTemplates.buildSimpleList(templateOpts)],
    ['SimpleListDetails', () => FormPatternTemplates.buildSimpleListDetails(templateOpts)],
    ['DetailsMaster', () => FormPatternTemplates.buildDetailsMaster(templateOpts)],
    ['DetailsTransaction', () => FormPatternTemplates.buildDetailsTransaction(templateOpts)],
    ['Dialog', () => FormPatternTemplates.buildDialog(templateOpts)],
    ['TableOfContents', () => FormPatternTemplates.buildTableOfContents(templateOpts)],
    ['Lookup', () => FormPatternTemplates.buildLookup(templateOpts)],
    ['ListPage', () => FormPatternTemplates.buildListPage(templateOpts)],
    ['Workspace', () => FormPatternTemplates.buildWorkspace(templateOpts)],
  ];

  for (const [name, build] of builders) {
    it(`${name} template has zero pattern errors`, async () => {
      const report = await validateFormPatternXml(build());
      const errors = report.violations.filter((v) => v.severity === 'error');
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      expect(report.pattern).toBeDefined();
    });
  }
});

// ── Mutation tests against template XML ──────────────────────────────────────

describe('mutated templates are rejected', () => {
  it('FP001: unknown top-level pattern', async () => {
    const xml = FormPatternTemplates.buildSimpleList(templateOpts)
      .replace('<Pattern xmlns="">SimpleList</Pattern>', '<Pattern xmlns="">SimpleListy</Pattern>');
    const report = await validateFormPatternXml(xml);
    expect(rules(report, 'error')).toContain('FP001');
  });

  it('FP001: unknown sub-pattern on a container', async () => {
    const xml = FormPatternTemplates.buildSimpleList(templateOpts)
      .replace('<Pattern>CustomAndQuickFilters</Pattern>', '<Pattern>QuickAndDirtyFilters</Pattern>');
    const report = await validateFormPatternXml(xml);
    expect(rules(report, 'error')).toContain('FP001');
  });

  it('FP002: unknown (older) pattern version is an error', async () => {
    const xml = FormPatternTemplates.buildSimpleList(templateOpts)
      .replace('<PatternVersion xmlns="">1.1</PatternVersion>', '<PatternVersion xmlns="">0.4</PatternVersion>');
    const report = await validateFormPatternXml(xml);
    expect(rules(report, 'error')).toContain('FP002');
  });

  it('FP002: newer-than-catalog version is only a warning (PU drift)', async () => {
    const xml = FormPatternTemplates.buildSimpleList(templateOpts)
      .replace('<PatternVersion xmlns="">1.1</PatternVersion>', '<PatternVersion xmlns="">9.9</PatternVersion>');
    const report = await validateFormPatternXml(xml);
    expect(rules(report, 'error')).not.toContain('FP002');
    expect(rules(report, 'warning')).toContain('FP002');
    expect(hasPatternErrors(report)).toBe(false);
  });

  it('FP010: missing pattern on Design is only a warning', async () => {
    const xml = FormPatternTemplates.buildSimpleList(templateOpts)
      .replace('<Pattern xmlns="">SimpleList</Pattern>', '')
      .replace('<PatternVersion xmlns="">1.1</PatternVersion>', '');
    const report = await validateFormPatternXml(xml);
    expect(hasPatternErrors(report)).toBe(false);
    expect(rules(report, 'warning')).toContain('FP010');
  });
});

// ── Rule unit tests on template trees ────────────────────────────────────────
//
// Each test starts from a template the platform accepts (the golden lock above),
// walks it into a design tree, breaks one thing and checks the rule that fires.

async function templateTree(build: () => string): Promise<{ design: FormDesignInfo; dataSourceCount: number }> {
  const parsed = await new Parser({ explicitArray: false, mergeAttrs: true, trim: true }).parseStringPromise(build());
  return { design: walkFormDesign(parsed.AxForm.Design), dataSourceCount: 1 };
}

function find(nodes: FormControlNode[], pred: (n: FormControlNode) => boolean): FormControlNode | undefined {
  for (const n of nodes) {
    if (pred(n)) return n;
    const hit = find(n.children, pred);
    if (hit) return hit;
  }
  return undefined;
}

function node(type: string, name: string, partial: Partial<FormControlNode> = {}): FormControlNode {
  return { name, type, properties: {}, children: [], ...partial };
}

const simpleList = () => templateTree(() => FormPatternTemplates.buildSimpleList(templateOpts));
const detailsMaster = () => templateTree(() => FormPatternTemplates.buildDetailsMaster(templateOpts));

describe('validateFormTree rule units', () => {
  it('clean SimpleList tree passes', async () => {
    expect(rules(validateFormTree(await simpleList()), 'error')).toEqual([]);
  });

  it('FP003: missing required Grid', async () => {
    const facts = await simpleList();
    facts.design.controls = facts.design.controls.filter((c) => c.type !== 'Grid');
    expect(rules(validateFormTree(facts), 'error')).toContain('FP003');
  });

  it('FP004: disallowed extra control at SimpleList root', async () => {
    const facts = await simpleList();
    facts.design.controls.push(node('StaticText', 'Hint'));
    expect(rules(validateFormTree(facts), 'error')).toContain('FP004');
  });

  it('FP005: Grid before ActionPane is out of order', async () => {
    const facts = await simpleList();
    facts.design.controls.reverse();
    expect(rules(validateFormTree(facts), 'error')).toContain('FP005');
  });

  it('FP004: static text inside FieldsFieldGroups is rejected', async () => {
    const facts = await detailsMaster();
    const page = find(facts.design.controls, (n) => n.pattern === 'FieldsFieldGroups')!;
    page.children.push(node('StaticText', 'Hint'));
    expect(rules(validateFormTree(facts), 'error')).toContain('FP004');
  });

  it('a group inside a field group of FieldsFieldGroups must be an actionable field (field + button)', async () => {
    const facts = await detailsMaster();
    const page = find(facts.design.controls, (n) => n.pattern === 'FieldsFieldGroups')!;
    page.children.push(node('Group', 'Outer', {
      children: [node('Group', 'Inner', { children: [node('String', 'F1')] })],
    }));
    expect(hasPatternErrors(validateFormTree(facts))).toBe(true);
  });

  it('opaque controls: the interior of a DimensionEntryControl is never validated', async () => {
    const facts = await detailsMaster();
    const page = find(facts.design.controls, (n) => n.pattern === 'FieldsFieldGroups')!;
    page.children.push(node('DimensionEntryControl', 'LedgerDimension', {
      pattern: 'NotAPattern',
      children: [node('Group', 'Segment1', { pattern: 'AlsoNotAPattern', children: [node('String', 'Seg1Val')] })],
    }));
    const below = validateFormTree(facts).violations.filter((v) => v.path.includes('LedgerDimension]/'));
    expect(below).toEqual([]);
  });

  it('FP006: FastTab page without sub-pattern warns (unspecified container)', async () => {
    const facts = await detailsMaster();
    const page = find(facts.design.controls, (n) => n.pattern === 'FieldsFieldGroups')!;
    delete page.pattern;
    delete page.patternVersion;
    const report = validateFormTree(facts);
    expect(rules(report, 'warning')).toContain('FP006');
    expect(hasPatternErrors(report)).toBe(false);
  });

  it('FP007: a sub-pattern the part does not accept is rejected', async () => {
    const facts = await simpleList();
    const filters = find(facts.design.controls, (n) => n.pattern === 'CustomAndQuickFilters')!;
    filters.pattern = 'FieldsFieldGroups';
    expect(rules(validateFormTree(facts), 'error')).toContain('FP007');
  });

  it('FP007: sub-pattern on unsupported control type is rejected', async () => {
    const facts = await detailsMaster();
    const tab = find(facts.design.controls, (n) => n.type === 'Tab')!;
    tab.pattern = 'FieldsFieldGroups'; // FieldsFieldGroups applies to Group/TabPage, not Tab
    tab.patternVersion = '1.1';
    expect(rules(validateFormTree(facts), 'error')).toContain('FP007');
  });

  it('FP008: DetailsTransaction with a single datasource warns', async () => {
    const facts = await templateTree(() => FormPatternTemplates.buildDetailsTransaction(templateOpts));
    expect(rules(validateFormTree(facts), 'warning')).toContain('FP008');
  });

  it('FP011: a Design Style the pattern does not allow is an error', async () => {
    const facts = await simpleList();
    facts.design.style = 'Dialog';
    delete facts.design.properties.Style;
    const report = validateFormTree(facts);
    expect(report.violations.find((v) => v.rule === 'FP011')?.excerpt).toContain('Style must be "SimpleList"');
  });

  it('FP011: an omitted property is checked at its metamodel default', async () => {
    const facts = await simpleList();
    const grid = find(facts.design.controls, (n) => n.type === 'Grid')!;
    delete grid.properties.Style; // SimpleList requires Style Tabular, a Grid defaults to Auto
    const report = validateFormTree(facts);
    expect(report.violations.find((v) => v.rule === 'FP011')?.excerpt).toContain('Style must be "Tabular", is "Auto" (default)');
  });
});

// ── Document-level errors ────────────────────────────────────────────────────

describe('document handling', () => {
  it('rejects non-AxForm XML', async () => {
    const report = await validateFormPatternXml('<AxTable><Name>Foo</Name></AxTable>');
    expect(hasPatternErrors(report)).toBe(true);
    expect(rules(report, 'error')).toContain('FP000');
  });

  it('rejects malformed XML', async () => {
    const report = await validateFormPatternXml('<AxForm><Design>');
    expect(hasPatternErrors(report)).toBe(true);
  });
});

/**
 * The `Custom` sentinels carry `versions: []` on purpose — they exist to say "no
 * Microsoft-defined pattern applies here" and suppress FP001. FP002 read that
 * empty list as version zero, and all three of its branches misbehaved:
 *
 *   - undeclared  → advised `Add <PatternVersion>undefined</PatternVersion>`
 *                   (observed live, eval case L2-form-control-removal-lifecycle)
 *   - unknown     → printed an empty `known: ` list
 *   - DECLARED    → compareVersions(declared, undefined) threw TypeError on
 *                   `b.split`, taking the whole validator down
 *
 * The last one is a crash, not a cosmetic defect, and neither was covered.
 */
describe('FP002 does not apply to a pattern the catalog gives no versions for', () => {
  const customForm = (patternVersion?: string): string =>
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
      '  <Name>FpvCustomForm</Name>',
      '  <Design>',
      '    <Pattern xmlns="">Custom</Pattern>',
      patternVersion ? `    <PatternVersion xmlns="">${patternVersion}</PatternVersion>` : '',
      '    <Controls />',
      '  </Design>',
      '</AxForm>',
    ].filter(Boolean).join('\n');

  it('raises no FP002 when no version is declared', async () => {
    const report = await validateFormPatternXml(customForm());
    expect(rules(report)).not.toContain('FP002');
    // The specific symptom that was user-visible.
    expect(JSON.stringify(report.violations)).not.toContain('undefined</PatternVersion>');
  });

  it('does not throw when a version IS declared', async () => {
    // Before the guard this was a TypeError out of compareVersions, not a violation.
    const report = await validateFormPatternXml(customForm('1.0'));
    expect(rules(report)).not.toContain('FP002');
  });
});
