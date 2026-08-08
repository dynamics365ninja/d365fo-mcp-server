/**
 * buildAxDataEntityViewExtensionXml (src/tools/dataEntityViewExtensionXml.ts).
 *
 * Regression: eval/corpus/runs/2026-07-27T15__L3-data-entity-extension-field__b28515f.json —
 * `data-entity-extension` went through generateAxSimpleExtensionXml(), whose
 * signature takes only (rootElement, name). Every field / field group / property
 * modification the caller passed was silently dropped and the element came out as
 *     <AxDataEntityViewExtension><Name>…</Name><PropertyModifications /></…>
 * The build was GREEN — the deserializer defaults the missing containers — so the
 * gap only showed up as "the field never appears over OData". Same class of bug
 * as the edt-extension one (tests/tools/edtExtensionXml.test.ts), same root cause.
 *
 * Shape is pinned against the shipped elements in PackagesLocalDirectory, e.g.
 * ApplicationSuite\Foundation\AxDataEntityViewExtension\CurrencyEntity.Extension.xml
 * and CaseCategoryHierarchyDetailEntity.AppSuiteExtension.xml. Element ORDER
 * matters: the metadata deserializer silently drops children it meets out of order.
 */

import { describe, it, expect } from 'vitest';
import { buildAxDataEntityViewExtensionXml } from '../../src/tools/xml/dataEntityViewExtensionXml';

const NAME = 'CustCustomerV3Entity.ConExtension';

describe('buildAxDataEntityViewExtensionXml — mapped fields', () => {
  it('emits a mapped field instead of dropping it — regression', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'CustTable',
      fields: [{ name: 'DemoLoyaltyCode' }],
    });
    expect(xml).toContain('i:type="AxDataEntityViewMappedField"');
    expect(xml).toContain('<Name>DemoLoyaltyCode</Name>');
    expect(xml).toContain('<DataField>DemoLoyaltyCode</DataField>');
    expect(xml).toContain('<DataSource>CustTable</DataSource>');
  });

  it('lets a field name a data source that differs from the default', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'CustTable',
      fields: [{ name: 'City', dataField: 'City', dataSource: 'DirPartyPostalAddress' }],
    });
    expect(xml).toContain('<DataSource>DirPartyPostalAddress</DataSource>');
    expect(xml).not.toContain('<DataSource>CustTable</DataSource>');
  });

  it('binds DataField separately from the entity-side Name', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'BankAccountTable',
      fields: [{ name: 'QRIBAN', dataField: 'QRIBAN_CH' }],
    });
    expect(xml).toContain('<Name>QRIBAN</Name>');
    expect(xml).toContain('<DataField>QRIBAN_CH</DataField>');
  });

  it('skips a field with no data source rather than emitting it half-bound', () => {
    // A wrong/absent DataSource is a hard compile error, so an unbindable field
    // must not reach the file at all.
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      fields: [{ name: 'Orphan' }],
    });
    expect(xml).not.toContain('Orphan');
    expect(xml).toContain('<Fields />');
  });

  it('emits presentation properties before the DataField/DataSource binding pair', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'Currency',
      fields: [
        {
          name: 'DecimalsCount',
          label: '@MexicoCFDI:DecimalsNumber',
          countryRegionCodes: 'MX',
          mandatory: 'No',
        },
      ],
    });
    expect(xml.indexOf('<CountryRegionCodes>')).toBeLessThan(xml.indexOf('<Label>'));
    expect(xml.indexOf('<Label>')).toBeLessThan(xml.indexOf('<Mandatory>'));
    expect(xml.indexOf('<Mandatory>')).toBeLessThan(xml.indexOf('<DataField>'));
    expect(xml.indexOf('<DataField>')).toBeLessThan(xml.indexOf('<DataSource>'));
  });
});

describe('buildAxDataEntityViewExtensionXml — field group extensions', () => {
  it('appends the new field to an existing field group', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'CustTable',
      fields: [{ name: 'DemoLoyaltyCode' }],
      fieldGroupExtensions: [{ name: 'AutoReport', fields: ['DemoLoyaltyCode'] }],
    });
    expect(xml).toContain('<AxTableFieldGroupExtension>');
    expect(xml).toContain('<Name>AutoReport</Name>');
    expect(xml).toContain('<AxTableFieldGroupField>');
    expect(xml).toContain('<DataField>DemoLoyaltyCode</DataField>');
  });

  it('ignores a group entry with no fields', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      fieldGroupExtensions: [{ name: 'AutoReport', fields: [] }],
    });
    expect(xml).toContain('<FieldGroupExtensions />');
  });
});

describe('buildAxDataEntityViewExtensionXml — element shape', () => {
  it('matches the shipped root element and declaration verbatim', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME);
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<AxDataEntityViewExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">')).toBe(true);
    expect(xml.endsWith('</AxDataEntityViewExtension>')).toBe(true);
  });

  it('emits all nine shipped containers, in shipped order', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'CustTable',
      fields: [{ name: 'DemoLoyaltyCode' }],
      fieldGroupExtensions: [{ name: 'AutoReport', fields: ['DemoLoyaltyCode'] }],
      propertyModifications: [{ name: 'Label', value: '@SYS1' }],
    });
    // Anchored on the single-tab indent so the nested <Fields> inside
    // FieldGroupExtensions is not mistaken for the top-level container.
    const order = [
      '\n\t<Name>',
      '\n\t<DataSources />',
      '\n\t<FieldGroupExtensions>',
      '\n\t<FieldGroups />',
      '\n\t<FieldModifications />',
      '\n\t<Fields>',
      '\n\t<Mappings />',
      '\n\t<PropertyModifications>',
      '\n\t<Relations />',
    ];
    let cursor = -1;
    for (const element of order) {
      const at = xml.indexOf(element);
      expect(at, `${element} missing`).toBeGreaterThan(-1);
      expect(at, `${element} out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('self-closes every container when nothing is supplied', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME);
    for (const element of [
      'DataSources', 'FieldGroupExtensions', 'FieldGroups', 'FieldModifications',
      'Fields', 'Mappings', 'PropertyModifications', 'Relations',
    ]) {
      expect(xml).toContain(`<${element} />`);
    }
  });

  it('carries xmlns="" on the nested field, as 100% of shipped files do', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'CustTable',
      fields: [{ name: 'DemoLoyaltyCode' }],
    });
    expect(xml).toContain('<AxDataEntityViewField xmlns=""');
  });

  it('escapes XML metacharacters in values', () => {
    const xml = buildAxDataEntityViewExtensionXml(NAME, {
      dataSource: 'CustTable',
      fields: [{ name: 'Field', label: 'a & b < c' }],
    });
    expect(xml).toContain('<Label>a &amp; b &lt; c</Label>');
  });
});
