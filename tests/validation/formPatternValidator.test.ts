/**
 * Form Pattern Validator tests.
 *
 * Golden lock: every FormPatternTemplates builder output passes the validator
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
import type { FormControlNode, FormDesignInfo } from '../../src/metadata/formPatternMiner';

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

// ── Rule unit tests on constructed trees ─────────────────────────────────────

function node(type: string, name: string, partial: Partial<FormControlNode> = {}): FormControlNode {
  return { name, type, properties: {}, children: [], ...partial };
}

function simpleListDesign(controls: FormControlNode[]): FormDesignInfo {
  return {
    pattern: 'SimpleList',
    patternVersion: '1.1',
    style: 'SimpleList',
    properties: {},
    controls,
  };
}

describe('validateFormTree rule units', () => {
  const actionPane = () => node('ActionPane', 'ActionPane');
  const grid = () => node('Grid', 'Grid');
  const filterGroup = () =>
    node('Group', 'CustomFilterGroup', {
      pattern: 'CustomAndQuickFilters',
      patternVersion: '1.1',
      properties: { Style: 'CustomFilter' },
      children: [node('QuickFilterControl', 'QuickFilterControl')],
    });

  it('clean SimpleList tree passes', () => {
    const report = validateFormTree({
      design: simpleListDesign([actionPane(), filterGroup(), grid()]),
      dataSourceCount: 1,
    });
    expect(rules(report, 'error')).toEqual([]);
  });

  it('FP003: missing required Grid', () => {
    const report = validateFormTree({
      design: simpleListDesign([actionPane(), filterGroup()]),
      dataSourceCount: 1,
    });
    expect(rules(report, 'error')).toContain('FP003');
  });

  it('FP004: disallowed extra control at SimpleList root', () => {
    const report = validateFormTree({
      design: simpleListDesign([actionPane(), grid(), node('StaticText', 'Hint')]),
      dataSourceCount: 1,
    });
    expect(rules(report, 'error')).toContain('FP004');
  });

  it('FP005: Grid before ActionPane is out of order', () => {
    const report = validateFormTree({
      design: simpleListDesign([grid(), actionPane()]),
      dataSourceCount: 1,
    });
    expect(rules(report, 'error')).toContain('FP005');
  });

  it('FP004: static text inside FieldsFieldGroups is rejected', () => {
    const tabPage = node('TabPage', 'TabPageGeneral', {
      pattern: 'FieldsFieldGroups',
      patternVersion: '1.1',
      children: [node('String', 'NameField'), node('StaticText', 'Hint')],
    });
    const design: FormDesignInfo = {
      pattern: 'DetailsMaster',
      patternVersion: '1.1',
      style: 'DetailsFormMaster',
      properties: {},
      controls: [
        actionPane(),
        node('Tab', 'Tab', {
          properties: { Style: 'FastTabs' },
          children: [tabPage],
        }),
      ],
    };
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'error')).toContain('FP004');
  });

  it('FP004: more than one level of group nesting in FieldsFieldGroups is rejected', () => {
    const tabPage = node('TabPage', 'TabPageGeneral', {
      pattern: 'FieldsFieldGroups',
      children: [
        node('Group', 'Outer', {
          children: [node('Group', 'Inner', { children: [node('String', 'F1')] })],
        }),
      ],
    });
    const design: FormDesignInfo = {
      pattern: 'DetailsMaster',
      patternVersion: '1.1',
      style: 'DetailsFormMaster',
      properties: {},
      controls: [actionPane(), node('Tab', 'Tab', { properties: { Style: 'FastTabs' }, children: [tabPage] })],
    };
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'error')).toContain('FP004');
  });

  it('opaque controls: nested Groups inside a DimensionEntryControl are NOT flagged in FieldsFieldGroups', () => {
    // A faithful clone of a real form (e.g. SalesTable) nests Groups inside the
    // financial DimensionEntryControl. The platform manages that interior, so the
    // FieldsFieldGroups "one level of group nesting" rule must not apply to it.
    const tabPage = node('TabPage', 'TabPageGeneral', {
      pattern: 'FieldsFieldGroups',
      children: [
        node('String', 'AccountNum'),
        node('DimensionEntryControl', 'LedgerDimension', {
          children: [
            node('Group', 'Segment1', { children: [node('String', 'Seg1Val')] }),
            node('Group', 'Segment2', { children: [node('String', 'Seg2Val')] }),
          ],
        }),
      ],
    });
    const design: FormDesignInfo = {
      pattern: 'DetailsMaster',
      patternVersion: '1.1',
      style: 'DetailsFormMaster',
      properties: {},
      controls: [actionPane(), node('Tab', 'Tab', { properties: { Style: 'FastTabs' }, children: [tabPage] })],
    };
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'error')).toEqual([]);
  });

  it('FP006: FastTab page without sub-pattern warns (unspecified container)', () => {
    const design: FormDesignInfo = {
      pattern: 'DetailsMaster',
      patternVersion: '1.1',
      style: 'DetailsFormMaster',
      properties: {},
      controls: [
        actionPane(),
        node('Tab', 'Tab', {
          properties: { Style: 'FastTabs' },
          children: [node('TabPage', 'TabPageGeneral')],
        }),
      ],
    };
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'warning')).toContain('FP006');
    expect(hasPatternErrors(report)).toBe(false);
  });

  it('FP007: SidePanel sub-pattern outside SimpleListDetails is rejected', () => {
    const design = simpleListDesign([
      actionPane(),
      node('Group', 'SidePanelGroup', {
        pattern: 'SidePanel',
        patternVersion: '1.0',
        children: [node('Grid', 'NavGrid', { properties: { Style: 'List' } })],
      }),
      grid(),
    ]);
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'error')).toContain('FP007');
  });

  it('FP007: sub-pattern on unsupported control type is rejected', () => {
    const design: FormDesignInfo = {
      pattern: 'DetailsMaster',
      patternVersion: '1.1',
      style: 'DetailsFormMaster',
      properties: {},
      controls: [
        actionPane(),
        node('Tab', 'Tab', {
          properties: { Style: 'FastTabs' },
          pattern: 'FieldsFieldGroups', // FieldsFieldGroups applies to Group/TabPage, not Tab
          children: [node('TabPage', 'TabPageGeneral', { pattern: 'FieldsFieldGroups' })],
        }),
      ],
    };
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'error')).toContain('FP007');
  });

  it('FP008: DetailsTransaction with a single datasource warns', () => {
    const design: FormDesignInfo = {
      pattern: 'DetailsTransaction',
      patternVersion: '1.1',
      style: 'DetailsFormTransaction',
      properties: {},
      controls: [
        actionPane(),
        node('Tab', 'Tab', {
          properties: { Style: 'FastTabs' },
          children: [node('TabPage', 'TabPageHeader', { pattern: 'FieldsFieldGroups', patternVersion: '1.1' })],
        }),
      ],
    };
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'warning')).toContain('FP008');
  });

  it('FP009: Style mismatch on Design warns', () => {
    const design = simpleListDesign([actionPane(), grid()]);
    design.style = 'Dialog';
    const report = validateFormTree({ design, dataSourceCount: 1 });
    expect(rules(report, 'warning')).toContain('FP009');
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
