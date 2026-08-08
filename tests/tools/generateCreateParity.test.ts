/**
 * Regression (audit finding 2, CRITICAL): the generate mirror threw content away.
 *
 * createD365File.ts and generateD365Xml.ts each expose an XmlTemplateGenerator
 * class that is supposed to be a mirror. Three of them had drifted:
 *
 *   • security duty/role — hard-coded `<Privileges />` / `<Duties />` regardless
 *     of what the caller passed. The create path was fixed after the "security
 *     chain silent empty write" incident; the mirror was not.
 *   • table — emitted a bare `<Fields />`, so every field was dropped.
 *   • form — its parameter was literally named `_properties`; it ignored the
 *     design pattern, data source, caption and controls entirely.
 *
 * The documented hybrid flow is generate → create(xmlContent), so that mirror
 * wrote empty, non-functional objects to disk. All of them build perfectly
 * clean, which is why this went unnoticed.
 *
 * The two halves now delegate to shared builders. These tests assert both that
 * they agree AND that the agreed-upon output actually carries the content —
 * two empty shells would agree too.
 */

import { describe, it, expect } from 'vitest';
import { XmlTemplateGenerator as CreateGen } from '../../src/tools/createD365File';
import { XmlTemplateGenerator as GenerateGen } from '../../src/tools/generateD365Xml';

describe('generate/create builder parity', () => {
  it('AxSecurityDuty — same XML, and the privileges are actually in it', () => {
    const props = { label: '@Contoso:DutyLabel', privileges: ['ContosoXyzMaintain', 'ContosoXyzView'] };

    const created = CreateGen.generateAxSecurityDutyXml('ContosoXyzDuty', props);
    const generated = GenerateGen.generateAxSecurityDutyXml('ContosoXyzDuty', props);

    expect(generated).toBe(created);
    expect(generated).toContain('<AxSecurityPrivilegeReference>');
    expect(generated).toContain('<Name>ContosoXyzMaintain</Name>');
    expect(generated).toContain('<Name>ContosoXyzView</Name>');
    expect(generated).not.toContain('<Privileges />');
  });

  it('AxSecurityRole — same XML, and the duties and privileges are actually in it', () => {
    const props = {
      label: '@Contoso:RoleLabel',
      duties: 'ContosoXyzDuty,ContosoXyzOtherDuty',
      privileges: ['ContosoXyzMaintain'],
    };

    const created = CreateGen.generateAxSecurityRoleXml('ContosoXyzRole', props);
    const generated = GenerateGen.generateAxSecurityRoleXml('ContosoXyzRole', props);

    expect(generated).toBe(created);
    expect(generated).toContain('<AxSecurityDutyReference>');
    expect(generated).toContain('<Name>ContosoXyzOtherDuty</Name>');
    expect(generated).not.toContain('<Duties />');
    expect(generated).not.toContain('<Privileges />');
  });

  it('AxSecurityDutyExtension / AxSecurityRoleExtension — same XML', () => {
    const dutyExt = { privileges: ['ContosoXyzMaintain'] };
    expect(GenerateGen.generateAxSecurityDutyExtensionXml('BatchJobMaintain.ContosoExtension', dutyExt))
      .toBe(CreateGen.generateAxSecurityDutyExtensionXml('BatchJobMaintain.ContosoExtension', dutyExt));

    const roleExt = { duties: ['ContosoXyzDuty'], privileges: ['ContosoXyzMaintain'] };
    expect(GenerateGen.generateAxSecurityRoleExtensionXml('SystemUser.ContosoExtension', roleExt))
      .toBe(CreateGen.generateAxSecurityRoleExtensionXml('SystemUser.ContosoExtension', roleExt));
  });

  it('AxTable — same XML, and the fields survive', () => {
    const props = {
      label: '@Contoso:TableLabel',
      tableGroup: 'Main',
      fields: [
        { name: 'AccountNum', edt: 'CustAccount' },
        { name: 'Amount', type: 'Real', label: 'Amount' },
        { name: 'Status', enumType: 'NoYes' },
      ],
    };

    const created = CreateGen.generateAxTableXml('ContosoXyzTable', props);
    const generated = GenerateGen.generateAxTableXml('ContosoXyzTable', props);

    expect(generated).toBe(created);
    expect(generated).toContain('<Name>AccountNum</Name>');
    expect(generated).toContain('<ExtendedDataType>CustAccount</ExtendedDataType>');
    expect(generated).toContain('i:type="AxTableFieldReal"');
    expect(generated).toContain('<EnumType>NoYes</EnumType>');
    // The whole point: the fields block is no longer self-closing.
    expect(generated).not.toContain('<Fields />\n\t<FullTextIndexes />');
  });

  it('AxTable — canonical property order reaches the generate side too', () => {
    // The generate copy hand-rolled its own property block in a different order,
    // and AxTable XML drops a misordered property without a word.
    const xml = GenerateGen.generateAxTableXml('ContosoXyzTable', {
      label: 'L', titleField1: 'AccountNum', cacheLookup: 'Found', tableGroup: 'Main',
    });
    expect(xml.indexOf('<Label>')).toBeLessThan(xml.indexOf('<TableGroup>'));
    expect(xml).toContain('<CacheLookup>Found</CacheLookup>');
  });

  it('AxForm — same XML, and the pattern/data source are honoured', () => {
    const props = {
      pattern: 'SimpleList',
      dataSource: 'ContosoXyzTable',
      caption: 'Contoso setup',
      gridFields: ['AccountNum', 'Amount'],
    };

    const created = CreateGen.generateAxFormXml('ContosoXyzForm', props);
    const generated = GenerateGen.generateAxFormXml('ContosoXyzForm', props);

    expect(generated).toBe(created);
    // The old mirror returned a fixed shell: empty DataSources, empty Controls.
    expect(generated).toContain('ContosoXyzTable');
    expect(generated).not.toContain('<DataSources />');
    expect(generated).not.toContain('<Controls xmlns="" />');
  });
});
