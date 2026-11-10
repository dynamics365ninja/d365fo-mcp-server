/**
 * move-control and wrap-controls on an AxForm: controls keep their bytes, only their
 * indentation changes, and a new container is written in census order.
 */
import { describe, it, expect } from 'vitest';
import { moveFormControl, wrapFormControls, latestPatternVersion } from '../../src/tools/xml/formRestructure.js';

const T = '\t';
const ctl = (d: number, type: string, name: string, extra: string[] = []) => [
  `${T.repeat(d)}<AxFormControl xmlns=""`,
  `${T.repeat(d + 1)}i:type="AxForm${type}Control">`,
  `${T.repeat(d + 1)}<Name>${name}</Name>`,
  ...extra.map(e => `${T.repeat(d + 1)}${e}`),
  `${T.repeat(d + 1)}<Type>${type}</Type>`,
  `${T.repeat(d + 1)}<FormControlExtension`,
  `${T.repeat(d + 2)}i:nil="true" />`,
  `${T.repeat(d)}</AxFormControl>`,
];
const FORM = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
  '\t<Name>ShopClaim</Name>',
  '\t<SourceCode>',
  '\t\t<Methods xmlns="">',
  '\t\t\t<Method>',
  '\t\t\t\t<Name>classDeclaration</Name>',
  '\t\t\t\t<Source><![CDATA[',
  '[Form]',
  'public class ShopClaim extends FormRun',
  '{',
  '    // <Controls> in a comment must not confuse anything',
  '}',
  ']]></Source>',
  '\t\t\t</Method>',
  '\t\t</Methods>',
  '\t</SourceCode>',
  '\t<Design>',
  '\t\t<Caption xmlns="">@Shop:Claims</Caption>',
  '\t\t<Controls xmlns="">',
  ...ctl(3, 'String', 'ClaimId', ['<DataField>ClaimId</DataField>', '<DataSource>ShopClaimTable</DataSource>']),
  ...ctl(3, 'String', 'Description'),
  '\t\t\t<AxFormControl xmlns=""',
  '\t\t\t\ti:type="AxFormGroupControl">',
  '\t\t\t\t<Name>Totals</Name>',
  '\t\t\t\t<Type>Group</Type>',
  '\t\t\t\t<FormControlExtension',
  '\t\t\t\t\ti:nil="true" />',
  '\t\t\t\t<Controls />',
  '\t\t\t</AxFormControl>',
  ...ctl(3, 'Grid', 'LinesGrid'),
  '\t\t</Controls>',
  '\t</Design>',
  '</AxForm>',
  '',
].join('\r\n');

type R = ReturnType<typeof moveFormControl>;
const ok = (r: R) => {
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('moveFormControl', () => {
  it('moves a control into an empty container, re-indented, bytes otherwise kept', () => {
    const r = ok(moveFormControl(FORM, { controlName: 'Description', parentControl: 'Totals' }));
    expect(r.detail).toBe('moved "Description" from "Design" to "Totals", last');
    expect(r.xml).toContain(
      '\t\t\t\t<Controls>\r\n' + ctl(5, 'String', 'Description').join('\r\n') + '\r\n\t\t\t\t</Controls>\r\n',
    );
    expect(r.xml.match(/<Name>Description<\/Name>/g)).toHaveLength(1);
    expect(/[^\r]\n/.test(r.xml)).toBe(false);
  });

  it('moves back to the design after a sibling and restores the file byte for byte', () => {
    const inGroup = ok(moveFormControl(FORM, { controlName: 'Description', parentControl: 'Totals' })).xml;
    const r = ok(moveFormControl(inGroup, { controlName: 'Description', parentControl: 'FormDesign', previousSibling: 'ClaimId' }));
    // Totals' <Controls> is no longer self-closing; everything else is as before.
    expect(r.xml.replace('\t\t\t\t<Controls>\r\n\t\t\t\t</Controls>', '\t\t\t\t<Controls />')).toBe(FORM);
  });

  it('reorders within the same parent and reports a no-op', () => {
    const r = ok(moveFormControl(FORM, { controlName: 'LinesGrid', positionType: 'Begin' }));
    expect(r.xml.indexOf('<Name>LinesGrid</Name>')).toBeLessThan(r.xml.indexOf('<Name>ClaimId</Name>'));
    const again = ok(moveFormControl(r.xml, { controlName: 'LinesGrid', positionType: 'Begin' }));
    expect(again.changed).toBe(false);
  });

  it('refuses a non-container target, its own subtree, an unknown sibling and an extension', () => {
    expect(moveFormControl(FORM, { controlName: 'ClaimId', parentControl: 'Description' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/not a container/) });
    expect(moveFormControl(FORM, { controlName: 'Totals', parentControl: 'Totals' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/own subtree/) });
    expect(moveFormControl(FORM, { controlName: 'ClaimId', parentControl: 'Totals', previousSibling: 'Nope' }))
      .toMatchObject({ ok: false });
    expect(moveFormControl('<AxFormExtension><Name>X</Name></AxFormExtension>', { controlName: 'A' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/form extension/) });
  });
});

describe('wrapFormControls', () => {
  it('wraps controls in a FieldsFieldGroups group in census order, where the first one was', () => {
    const r = ok(wrapFormControls(FORM, {
      controlNames: ['Description', 'ClaimId'], containerName: 'HeaderGroup',
      pattern: 'FieldsFieldGroups', caption: '@Shop:Header',
    }));
    expect(r.xml).toContain([
      '\t\t<Controls xmlns="">',
      '\t\t\t<AxFormControl xmlns=""',
      '\t\t\t\ti:type="AxFormGroupControl">',
      '\t\t\t\t<Name>HeaderGroup</Name>',
      '\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>',
      `\t\t\t\t<PatternVersion>${latestPatternVersion('FieldsFieldGroups')}</PatternVersion>`,
      '\t\t\t\t<Type>Group</Type>',
      '\t\t\t\t<FormControlExtension',
      '\t\t\t\t\ti:nil="true" />',
      '\t\t\t\t<Controls>',
      ...ctl(5, 'String', 'ClaimId', ['<DataField>ClaimId</DataField>', '<DataSource>ShopClaimTable</DataSource>']),
      ...ctl(5, 'String', 'Description'),
      '\t\t\t\t</Controls>',
      '\t\t\t\t<Caption>@Shop:Header</Caption>',
      '\t\t\t</AxFormControl>',
      '\t\t\t<AxFormControl xmlns=""',
      '\t\t\t\ti:type="AxFormGroupControl">',
      '\t\t\t\t<Name>Totals</Name>',
    ].join('\r\n'));
    expect(r.warnings).toEqual([]);
  });

  it('builds FastTabs: groups into TabPages, the pages into a Tab with Style', () => {
    let xml = ok(wrapFormControls(FORM, {
      controlNames: ['Totals'], containerName: 'TotalsPage', containerType: 'TabPage',
      caption: '@Shop:Totals', pattern: 'FieldsFieldGroups',
    })).xml;
    xml = ok(wrapFormControls(xml, { controlNames: ['LinesGrid'], containerName: 'LinesPage', containerType: 'TabPage' })).xml;
    const r = ok(wrapFormControls(xml, {
      controlNames: ['TotalsPage', 'LinesPage'], containerName: 'DetailsTab', containerType: 'Tab', style: 'FastTabs',
    }));
    expect(r.xml).toMatch(/<Name>DetailsTab<\/Name>\r\n\t{4}<Type>Tab<\/Type>[\s\S]*<\/Controls>\r\n\t{4}<Style>FastTabs<\/Style>\r\n\t{3}<\/AxFormControl>/);
    // DetailsTab at depth 3, its pages at 5, their properties at 6.
    expect(r.xml).toMatch(/<Name>TotalsPage<\/Name>\r\n\t{6}<Pattern>FieldsFieldGroups<\/Pattern>/);
    expect(r.xml).toMatch(/<\/Controls>\r\n\t{6}<Caption>@Shop:Totals<\/Caption>\r\n\t{5}<\/AxFormControl>/);
    expect(r.xml).toMatch(/\r\n\t{7}<AxFormControl xmlns=""\r\n\t{8}i:type="AxFormGroupControl">\r\n\t{8}<Name>Totals<\/Name>/);
  });

  it('refuses what shipped metadata never has, and bad input', () => {
    expect(wrapFormControls(FORM, { controlNames: ['Totals'], containerName: 'T', containerType: 'Tab' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/TabPages only/) });
    const page = ok(wrapFormControls(FORM, { controlNames: ['Totals'], containerName: 'P', containerType: 'TabPage' })).xml;
    expect(wrapFormControls(page, { controlNames: ['P'], containerName: 'T', containerType: 'Tab', caption: '@X:Y' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/carries no Caption/) });
    expect(wrapFormControls(FORM, { controlNames: ['ClaimId'], containerName: 'Totals' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/already has a control/) });
    expect(wrapFormControls(FORM, { controlNames: ['ClaimId'], containerName: 'G', pattern: 'NoSuchPattern' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/patternVersion/) });
    const nested = ok(moveFormControl(FORM, { controlName: 'Description', parentControl: 'Totals' })).xml;
    expect(wrapFormControls(nested, { controlNames: ['ClaimId', 'Description'], containerName: 'G' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/share one parent/) });
  });

  it('warns about a literal caption and a TabPage outside a Tab', () => {
    const r = ok(wrapFormControls(FORM, { controlNames: ['LinesGrid'], containerName: 'P', containerType: 'TabPage', caption: 'Lines' }));
    expect(r.warnings.join('\n')).toMatch(/literal text/);
    expect(r.warnings.join('\n')).toMatch(/not a Tab/);
  });
});
