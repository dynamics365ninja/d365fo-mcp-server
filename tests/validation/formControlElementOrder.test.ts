/**
 * AxForm element-order guard (issue #979).
 *
 * The metadata deserializer DROPS an element written out of sequence and says
 * nothing. The SimpleListDetails scaffold wrote `<DataGroup>`/`<DataSource>`
 * before `<Controls>` on its `Overview` group, and the C# bridge — reading
 * through the same IMetadataProvider the compiler uses — reported that group
 * with no children and the form with 14 controls where the file held 16.
 * Verified live on the VM: moving those two lines below `</Controls>` made all
 * 16 appear, with no other change to the file.
 *
 * The canonical order is not written here — it is mined from 25k shipped control
 * elements by scripts/capture-form-element-order.ts. These tests keep every
 * pattern template inside it.
 */
import { describe, it, expect } from 'vitest';
import {
  findControlElementOrderViolations,
  formatElementOrderViolations,
} from '../../src/validation/formControlElementOrder';
import {
  FORM_CONTROL_ELEMENT_ORDER,
  FORM_ELEMENT_ORDER_CONTROLS_SAMPLED,
} from '../../src/validation/formControlElementOrder.generated';
import { FormPatternTemplates, type FormPattern } from '../../src/utils/formPatternTemplates';

const OPTS = {
  formName: 'TestForm',
  dsName: 'TestDS',
  dsTable: 'TestTable',
  caption: '@SYS1',
  gridFields: ['Field1', 'Field2', 'Field3'],
  linesDsName: 'TestLinesDS',
  linesDsTable: 'TestLinesTable',
  linesFields: ['LineField1', 'LineField2'],
  titleField: 'Field1',
};

const ALL_PATTERNS: FormPattern[] = [
  'SimpleList',
  'SimpleListDetails',
  'DetailsMaster',
  'DetailsTransaction',
  'Dialog',
  'TableOfContents',
  'Lookup',
  'ListPage',
  'Workspace',
];

describe('mined canonical order', () => {
  it('covers the control types the templates emit, from a real census', () => {
    expect(FORM_ELEMENT_ORDER_CONTROLS_SAMPLED).toBeGreaterThan(10_000);
    for (const t of ['AxFormGroupControl', 'AxFormGridControl', 'AxFormTabPageControl', 'AxFormStringControl']) {
      expect(FORM_CONTROL_ELEMENT_ORDER[t], t).toBeDefined();
    }
  });

  it('puts <Controls> before <DataGroup> and <DataSource> on a group — the #979 constraint', () => {
    const order = FORM_CONTROL_ELEMENT_ORDER['AxFormGroupControl'];
    expect(order.indexOf('Controls')).toBeLessThan(order.indexOf('DataGroup'));
    expect(order.indexOf('Controls')).toBeLessThan(order.indexOf('DataSource'));
  });
});

describe('findControlElementOrderViolations', () => {
  const group = (inner: string) =>
    `<AxForm><Design><Controls>\n<AxFormControl i:type="AxFormGroupControl">\n${inner}\n</AxFormControl>\n</Controls></Design></AxForm>`;

  it('catches the exact shape the scaffold used to write', () => {
    const xml = group(
      `<Name>Overview</Name>\n<Type>Group</Type>\n<DataGroup>Overview</DataGroup>\n` +
        `<DataSource>MyTable</DataSource>\n<Controls>\n` +
        `<AxFormControl i:type="AxFormStringControl"><Name>Overview_Foo</Name><Type>String</Type></AxFormControl>\n` +
        `</Controls>`,
    );
    const v = findControlElementOrderViolations(xml);
    expect(v.length).toBeGreaterThan(0);
    const controlsFinding = v.find((x) => x.element === 'Controls');
    expect(controlsFinding).toBeDefined();
    expect(controlsFinding!.controlName).toBe('Overview');
    expect(controlsFinding!.controlType).toBe('AxFormGroupControl');
    expect(formatElementOrderViolations(v)).toContain('must come AFTER');
  });

  it('accepts the same control once the two lines move below </Controls>', () => {
    const xml = group(
      `<Name>Overview</Name>\n<Type>Group</Type>\n<Controls>\n` +
        `<AxFormControl i:type="AxFormStringControl"><Name>Overview_Foo</Name><Type>String</Type></AxFormControl>\n` +
        `</Controls>\n<DataGroup>Overview</DataGroup>\n<DataSource>MyTable</DataSource>`,
    );
    expect(findControlElementOrderViolations(xml)).toEqual([]);
  });

  it('reports an element no shipped control of that type carries, as its own kind', () => {
    // AxFormTabPageControl declares no FrameType property at all (checked by
    // reflection against Microsoft.Dynamics.AX.Metadata.dll) — the Workspace
    // template wrote one anyway and the platform simply ignored it.
    const xml =
      `<AxForm><Design><Controls><AxFormControl i:type="AxFormTabPageControl">` +
      `<Name>SummarySection</Name><Type>TabPage</Type><FrameType>None</FrameType>` +
      `</AxFormControl></Controls></Design></AxForm>`;
    const v = findControlElementOrderViolations(xml);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('unknown');
    expect(v[0].element).toBe('FrameType');
    expect(formatElementOrderViolations(v)).toContain('appears on no AxFormTabPageControl');
  });

  it('does not read markup out of an XML comment', () => {
    // The Workspace template ships a commented-out control example; a scanner
    // that matched inside comments opened a frame that never closed and blamed
    // the wrong control.
    const xml = group(
      `<Name>G</Name>\n<Type>Group</Type>\n<Controls>\n` +
        `<!-- <AxFormControl i:type="AxFormButtonControl"><Name>Tile1</Name> -->\n` +
        `</Controls>\n<DataGroup>Overview</DataGroup>\n<DataSource>T</DataSource>`,
    );
    expect(findControlElementOrderViolations(xml)).toEqual([]);
  });

  it('ignores an unknown control type', () => {
    const xml = `<AxForm><Design><Controls><AxFormControl i:type="AxFormMadeUpControl">` +
      `<DataSource>X</DataSource><Name>N</Name></AxFormControl></Controls></Design></AxForm>`;
    expect(findControlElementOrderViolations(xml)).toEqual([]);
  });
});

describe('every pattern template writes elements in canonical order', () => {
  for (const pattern of ALL_PATTERNS) {
    it(`${pattern} is clean`, () => {
      const xml = FormPatternTemplates.build(pattern, OPTS);
      const violations = findControlElementOrderViolations(xml);
      expect(formatElementOrderViolations(violations)).toBe('');
    });
  }

  it('SimpleListDetails keeps the Overview group children reachable', () => {
    const xml = FormPatternTemplates.build('SimpleListDetails', OPTS);
    // The regression: <DataGroup>/<DataSource> above <Controls> made the two
    // child controls invisible to the metadata provider.
    const groupBlock = xml.slice(xml.indexOf('<Name>Overview</Name>'));
    const controlsAt = groupBlock.indexOf('<Controls>');
    const dataGroupAt = groupBlock.indexOf('<DataGroup>');
    expect(controlsAt).toBeGreaterThan(-1);
    expect(dataGroupAt).toBeGreaterThan(controlsAt);
  });
});

describe('shipped metadata is itself clean under this check', () => {
  // The census is the oracle; a rule that flags the corpus it was mined from
  // would be a rule about nothing.
  it('a hand-copied shipped group control passes', () => {
    const shipped =
      `<AxForm><Design><Controls>\n` +
      `<AxFormControl xmlns="" i:type="AxFormGroupControl">\n` +
      `\t<Name>Overview</Name>\n\t<ElementPosition>1431655764</ElementPosition>\n` +
      `\t<FilterExpression>%1</FilterExpression>\n\t<Type>Group</Type>\n` +
      `\t<VerticalSpacing>-1</VerticalSpacing>\n\t<FormControlExtension i:nil="true" />\n` +
      `\t<Controls>\n\t\t<AxFormControl xmlns="" i:type="AxFormStringControl">\n` +
      `\t\t\t<Name>Overview_Description</Name>\n\t\t\t<Type>String</Type>\n` +
      `\t\t\t<FormControlExtension i:nil="true" />\n\t\t\t<DataField>Description</DataField>\n` +
      `\t\t\t<DataSource>Payment</DataSource>\n\t\t</AxFormControl>\n\t</Controls>\n` +
      `\t<BackgroundColor>WindowBackground</BackgroundColor>\n\t<DataGroup>Overview</DataGroup>\n` +
      `\t<DataSource>Payment</DataSource>\n\t<FrameType>None</FrameType>\n` +
      `</AxFormControl>\n</Controls></Design></AxForm>`;
    expect(findControlElementOrderViolations(shipped)).toEqual([]);
  });
});
