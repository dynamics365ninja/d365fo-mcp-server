/**
 * add-method "Control.method" on a form adds a control override (#1161).
 *
 * The bridge routes a dotted name to a data source and updates a control override
 * that exists, but a NEW one ("OkButton.clicked") became a form method literally
 * named "OkButton.clicked". The override belongs in the control's holder under
 * <SourceCode><DataControls>, the place replace-code already reads it from.
 */

import { describe, it, expect } from 'vitest';
import { addFormControlMethod } from '../../src/utils/formControlMethodXml';
import { methodSourceSpans } from '../../src/utils/methodSourceSpans';

const button = (name: string): string[] => [
  '\t\t\t\t\t<AxFormControl xmlns=""',
  '\t\t\t\t\t\ti:type="AxFormCommandButtonControl">',
  `\t\t\t\t\t\t<Name>${name}</Name>`,
  '\t\t\t\t\t\t<Type>CommandButton</Type>',
  '\t\t\t\t\t\t<FormControlExtension',
  '\t\t\t\t\t\t\ti:nil="true" />',
  '\t\t\t\t\t</AxFormControl>',
];

/** A dialog with two buttons and a data source, no control override yet. */
const FORM = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
  '\t<Name>ContosoRentDialog</Name>',
  '\t<SourceCode>',
  '\t\t<Methods xmlns="">',
  '\t\t\t<Method>',
  '\t\t\t\t<Name>classDeclaration</Name>',
  '\t\t\t\t<Source><![CDATA[',
  '[Form]',
  'public class ContosoRentDialog extends FormRun',
  '{',
  '}',
  ']]></Source>',
  '\t\t\t</Method>',
  '\t\t</Methods>',
  '\t\t<DataSources xmlns="">',
  '\t\t\t<DataSource>',
  '\t\t\t\t<Name>ContosoRentHeader</Name>',
  '\t\t\t\t<Methods>',
  '\t\t\t\t\t<Method>',
  '\t\t\t\t\t\t<Name>init</Name>',
  '\t\t\t\t\t\t<Source><![CDATA[',
  '        public void init()',
  '        {',
  '            super();',
  '        }',
  '',
  ']]></Source>',
  '\t\t\t\t\t</Method>',
  '\t\t\t\t</Methods>',
  '\t\t\t</DataSource>',
  '\t\t</DataSources>',
  '\t\t<DataControls xmlns="" />',
  '\t\t<Members xmlns="" />',
  '\t</SourceCode>',
  '\t<DataSources>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentHeader</Name>',
  '\t\t\t<Table>ContosoRentHeader</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t</DataSources>',
  '\t<Design>',
  '\t\t<Caption xmlns="">@ContosoExt:RentDialog</Caption>',
  '\t\t<Controls xmlns="">',
  '\t\t\t<AxFormControl xmlns=""',
  '\t\t\t\ti:type="AxFormButtonGroupControl">',
  '\t\t\t\t<Name>ButtonGroup</Name>',
  '\t\t\t\t<Type>ButtonGroup</Type>',
  '\t\t\t\t<FormControlExtension',
  '\t\t\t\t\ti:nil="true" />',
  '\t\t\t\t<Controls>',
  ...button('OkButton'),
  ...button('CloseButton'),
  '\t\t\t\t</Controls>',
  '\t\t\t</AxFormControl>',
  '\t\t</Controls>',
  '\t</Design>',
  '\t<Parts />',
  '</AxForm>',
].join('\n');

const CLICKED = 'public void clicked()\n{\n    super();\n    element.close();\n}';
const ENTER = 'public void enter()\n{\n    super();\n}';

const holder = (name: string, methods: Array<[string, string]>): string => [
  '\t\t\t<Control>',
  `\t\t\t\t<Name>${name}</Name>`,
  '\t\t\t\t<Type>CommandButton</Type>',
  '\t\t\t\t<Methods>',
  ...methods.flatMap(([method, source]) => [
    '\t\t\t\t\t<Method>',
    `\t\t\t\t\t\t<Name>${method}</Name>`,
    '\t\t\t\t\t\t<Source><![CDATA[',
    source,
    '',
    ']]></Source>',
    '\t\t\t\t\t</Method>',
  ]),
  '\t\t\t\t</Methods>',
  '\t\t\t</Control>',
].join('\n');

const dataControls = (...holders: string[]): string =>
  ['\t\t<DataControls xmlns="">', ...holders, '\t\t</DataControls>'].join('\n');

const added = (r: ReturnType<typeof addFormControlMethod>) => {
  if (r.kind !== 'added') throw new Error(`expected 'added', got ${JSON.stringify(r)}`);
  return r;
};

describe('addFormControlMethod', () => {
  it('gives a control without overrides its first one, in a new <Control> holder', () => {
    const r = added(addFormControlMethod(FORM, 'OkButton.clicked', CLICKED));
    expect(r.firstOverride).toBe(true);
    expect(r.xml).toBe(FORM.replace(
      '\t\t<DataControls xmlns="" />', dataControls(holder('OkButton', [['clicked', CLICKED]]))));
  });

  it('writes the source as given: only trailing whitespace is trimmed', () => {
    const source = '    public void clicked()\n    {\n\tsuper();   // keep <this> & that\n    }\n\n\n';
    const r = added(addFormControlMethod(FORM, 'OkButton.clicked', source));
    expect(r.xml).toContain(`<Source><![CDATA[\n${source.trimEnd()}\n\n]]></Source>`);
  });

  it('appends the holder of a second control after the first', () => {
    const one = added(addFormControlMethod(FORM, 'OkButton.clicked', CLICKED));
    const two = added(addFormControlMethod(one.xml, 'CloseButton.clicked', CLICKED));
    expect(two.xml).toBe(FORM.replace(
      '\t\t<DataControls xmlns="" />',
      dataControls(holder('OkButton', [['clicked', CLICKED]]), holder('CloseButton', [['clicked', CLICKED]]))));
  });

  it('gives a control that has one override a second, in the same holder', () => {
    const one = added(addFormControlMethod(FORM, 'OkButton.clicked', CLICKED));
    const two = added(addFormControlMethod(one.xml, 'OkButton.enter', ENTER));
    expect(two.firstOverride).toBe(false);
    expect(two.xml).toBe(FORM.replace(
      '\t\t<DataControls xmlns="" />',
      dataControls(holder('OkButton', [['clicked', CLICKED], ['enter', ENTER]]))));
  });

  it('creates <DataControls> directly after </DataSources> when the form has none', () => {
    const expected = FORM.replace(
      '\t\t<DataControls xmlns="" />', dataControls(holder('OkButton', [['clicked', CLICKED]])));
    const bare = FORM.replace('\t\t<DataControls xmlns="" />\n', '');
    expect(added(addFormControlMethod(bare, 'OkButton.clicked', CLICKED)).xml).toBe(expected);
    // Also without <Members>, and with a self-closed <DataSources xmlns="" />.
    const noMembers = bare.replace('\t\t<Members xmlns="" />\n', '');
    expect(added(addFormControlMethod(noMembers, 'OkButton.clicked', CLICKED)).xml)
      .toBe(expected.replace('\t\t<Members xmlns="" />\n', ''));
    const emptySources = bare.replace(/\t\t<DataSources xmlns="">[\s\S]*?\t\t<\/DataSources>\n/, '\t\t<DataSources xmlns="" />\n');
    expect(added(addFormControlMethod(emptySources, 'OkButton.clicked', CLICKED)).xml).toContain(
      '\t\t<DataSources xmlns="" />\n\t\t<DataControls xmlns="">\n\t\t\t<Control>');
  });

  it('takes the spelling the design declares for the control', () => {
    const r = added(addFormControlMethod(FORM, 'okbutton.clicked', CLICKED));
    expect(r.controlName).toBe('OkButton');
    expect(r.xml).toContain('\t\t\t\t<Name>OkButton</Name>\n\t\t\t\t<Type>CommandButton</Type>\n\t\t\t\t<Methods>');
  });

  it('is found afterwards by the locator replace-code uses', () => {
    expect(methodSourceSpans(FORM, 'OkButton.clicked')).toEqual([]);
    const r = added(addFormControlMethod(FORM, 'OkButton.clicked', CLICKED));
    const spans = methodSourceSpans(r.xml, 'OkButton.clicked')!;
    expect(spans).toHaveLength(1);
    expect(r.xml.slice(spans[0].start, spans[0].end)).toContain('element.close();');
  });

  it('refuses a first segment that is neither a data source nor a control, with close names', () => {
    const r = addFormControlMethod(FORM, 'OkButon.clicked', CLICKED);
    expect(r).toEqual({ kind: 'no-such-owner', owner: 'OkButon', close: ['OkButton'], controlCount: 3 });
    const far = addFormControlMethod(FORM, 'PostingGrid.clicked', CLICKED);
    expect(far.kind).toBe('no-such-owner');
    expect(far.kind === 'no-such-owner' && far.close).toEqual([]);
  });

  it('leaves an override that already exists to the in-place update', () => {
    const one = added(addFormControlMethod(FORM, 'OkButton.clicked', CLICKED));
    expect(addFormControlMethod(one.xml, 'OkButton.clicked', ENTER)).toEqual({ kind: 'exists' });
    expect(addFormControlMethod(one.xml, 'okbutton.CLICKED', ENTER)).toEqual({ kind: 'exists' });
  });

  it('leaves data source names to the data source path', () => {
    expect(addFormControlMethod(FORM, 'ContosoRentHeader.active', CLICKED)).toEqual({ kind: 'data-source' });
    expect(addFormControlMethod(FORM, 'contosorentheader.RentId.modified', CLICKED)).toEqual({ kind: 'data-source' });
  });

  it('refuses a path below a control, and source that cannot be stored in CDATA', () => {
    const deep = addFormControlMethod(FORM, 'OkButton.Inner.clicked', CLICKED);
    expect(deep.kind).toBe('refused');
    const cdata = addFormControlMethod(FORM, 'OkButton.clicked', 'public void clicked()\n{\n    str s = "]]>";\n}');
    expect(cdata.kind).toBe('refused');
  });

  it('answers not-a-form for anything else', () => {
    expect(addFormControlMethod('<AxClass><Name>ContosoRentHelper</Name></AxClass>', 'OkButton.clicked', CLICKED))
      .toEqual({ kind: 'not-a-form' });
  });
});
