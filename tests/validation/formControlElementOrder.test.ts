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
 * The canonical order is not written here — it is mined from 309,668 shipped
 * control elements by scripts/capture-form-element-order.ts. These tests keep
 * every pattern template inside it, and #989 added the write gate that refuses
 * the shape outright.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  findControlElementOrderViolations,
  formatElementOrderViolations,
  gateOnControlElementOrder,
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
    // The DIRECTION is the whole point of the message: the misplaced element must
    // come BEFORE the one it was written after. The first version said the
    // opposite and shipped, because this assertion pinned the wrong string.
    expect(formatElementOrderViolations(v)).toContain('must come BEFORE it');
    expect(formatElementOrderViolations(v)).not.toContain('must come AFTER');
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

// ─── The write gate (issue #989) ─────────────────────────────────────────────

describe('gateOnControlElementOrder', () => {
  const brokenGroup =
    `<AxForm><Design><Controls>\n<AxFormControl i:type="AxFormGroupControl">\n` +
    `<Name>Overview</Name>\n<Type>Group</Type>\n<DataGroup>Overview</DataGroup>\n` +
    `<DataSource>T</DataSource>\n<Controls>\n` +
    `<AxFormControl i:type="AxFormStringControl"><Name>Overview_Foo</Name><Type>String</Type></AxFormControl>\n` +
    `</Controls>\n</AxFormControl>\n</Controls></Design></AxForm>`;

  const goodGroup =
    `<AxForm><Design><Controls>\n<AxFormControl i:type="AxFormGroupControl">\n` +
    `<Name>Overview</Name>\n<Type>Group</Type>\n<Controls>\n` +
    `<AxFormControl i:type="AxFormStringControl"><Name>Overview_Foo</Name><Type>String</Type></AxFormControl>\n` +
    `</Controls>\n<DataGroup>Overview</DataGroup>\n<DataSource>T</DataSource>\n</AxFormControl>\n` +
    `</Controls></Design></AxForm>`;

  it('blocks a write that would produce a file the compiler reads differently', () => {
    const gate = gateOnControlElementOrder(brokenGroup, 'create form X', true);
    expect(gate.blocked).not.toBeNull();
    expect(gate.blocked!.isError).toBe(true);
    const text = gate.blocked!.content[0].text;
    expect(text).toMatch(/blocked/);
    expect(text).toMatch(/DROPS those silently/);
    expect(text).toMatch(/<Controls> is written after <DataSource>, but must come BEFORE it/);
    // It must say how to bypass, like the pattern gate does.
    expect(text).toMatch(/FORM_PATTERN_ENFORCE=false/);
  });

  it('lets a well-ordered document through', () => {
    const gate = gateOnControlElementOrder(goodGroup, 'create form X', true);
    expect(gate.blocked).toBeNull();
    expect(gate.warningsText).toBeNull();
  });

  it('downgrades to a warning when enforcement is off — never silently', () => {
    const gate = gateOnControlElementOrder(brokenGroup, 'create form X', false);
    expect(gate.blocked).toBeNull();
    expect(gate.warningsText).toMatch(/FORM_PATTERN_ENFORCE is disabled/);
    expect(gate.warningsText).toMatch(/will be DROPPED/);
  });

  it('never blocks on the weaker `unknown` kind', () => {
    // AxFormTabPageControl declares no FrameType at all — worth saying, not worth refusing.
    const xml =
      `<AxForm><Design><Controls><AxFormControl i:type="AxFormTabPageControl">` +
      `<Name>P</Name><Type>TabPage</Type><FrameType>None</FrameType>` +
      `</AxFormControl></Controls></Design></AxForm>`;
    const gate = gateOnControlElementOrder(xml, 'create form X', true);
    expect(gate.blocked).toBeNull();
    expect(gate.warningsText).toMatch(/no shipped control of that type carries/);
  });

  it('sees a FORM EXTENSION control, which spells the element differently', () => {
    // <FormControl i:type=…> inside <AxFormExtensionControl>, not <AxFormControl>.
    // A checker that knew only the AxForm spelling was inert on every extension.
    const ext =
      `<AxFormExtension><Controls><AxFormExtensionControl>\n<Name>W</Name>\n` +
      `<FormControl i:type="AxFormGroupControl">\n<Name>G</Name>\n<Type>Group</Type>\n` +
      `<DataSource>T</DataSource>\n<Controls />\n</FormControl>\n<Parent>P</Parent>\n` +
      `</AxFormExtensionControl></Controls></AxFormExtension>`;
    const v = findControlElementOrderViolations(ext).filter(x => x.kind === 'order');
    expect(v).toHaveLength(1);
    expect(v[0].controlName).toBe('G');
  });
});

// ─── The false-positive rate, measured (issue #989) ──────────────────────────

/**
 * A rule that BLOCKS a write has to be right about the corpus it claims to
 * describe. Over the whole shipped AOT — 10,676 AxForm/AxFormExtension files,
 * 309,668 controls — this rule fires exactly three times, and each of those
 * three is a file where Microsoft itself put an element where the deserializer
 * drops it (SystemParameters.xml, SysSecRoleAssignOM.xml,
 * RetailPricingSimulatorV2.GlobalUnifiedPricing.xml — the minority side of the
 * three contradictory pairs the capture script resolves by weight, at 261:1,
 * 453:1 and 35:1).
 *
 * This test re-measures a bounded slice of that, so a future capture that
 * widened the rule beyond the evidence fails here rather than in a user's write.
 * VM-only: skipped where PackagesLocalDirectory is not mounted.
 */
describe('shipped metadata under the blocking rule', () => {
  const PACKAGES = process.env.PACKAGES_ROOT ?? 'K:/AosService/PackagesLocalDirectory';
  const DIRS = [
    path.join(PACKAGES, 'ApplicationSuite', 'Foundation', 'AxForm'),
    path.join(PACKAGES, 'ApplicationSuite', 'Foundation', 'AxFormExtension'),
  ].filter(d => fs.existsSync(d));

  it.skipIf(DIRS.length === 0)('fires on at most a handful of files in a 1,000-file slice', () => {
    let files = 0;
    let order = 0;
    let unknown = 0;
    for (const dir of DIRS) {
      for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.xml')).sort().slice(0, 700)) {
        const xml = fs.readFileSync(path.join(dir, f), 'utf-8');
        files++;
        for (const v of findControlElementOrderViolations(xml)) {
          if (v.kind === 'order') order++;
          else unknown++;
        }
      }
    }
    expect(files).toBeGreaterThan(500);
    // The blocking kind must be vanishingly rare on metadata the platform wrote.
    expect(order, `${order} order violations over ${files} shipped files`).toBeLessThanOrEqual(3);
    // The warning kind used to fire 41 times here, before the census was widened
    // from 949 forms to every package and every form extension.
    expect(unknown, `${unknown} unknown-element findings over ${files} shipped files`).toBe(0);
  }, 60_000);
});
