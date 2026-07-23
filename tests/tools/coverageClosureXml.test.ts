/**
 * The five create paths added to close the last T holes in the coverage
 * taxonomy: macro (AxMacroDictionary), configuration-key, security-policy
 * (XDS), aggregate-measurement and license-code.
 *
 * Every expectation below is pinned to the SHAPE OF A REAL ELEMENT read out of
 * PackagesLocalDirectory on the VM, not to what the metadata docs imply:
 *   AxMacroDictionary  ApplicationFoundation/…/ApplicationFoundationFlights.xml
 *   AxConfigurationKey ApplicationFoundation/…/DataExpansionFramework.xml
 *   AxSecurityPolicy   ApplicationFoundation/…/EventInbox.xml
 *   AxAggregateMeasurement ApplicationSuite/Foundation/…/AssetTransactionMeasure.xml
 *   AxLicenseCode      ApplicationFoundation/…/LogisticsBasic.xml
 * The root element name, the namespace (or its deliberate absence) and the
 * element order are what the D365FO deserializer is strict about, so those are
 * asserted rather than "contains a Name".
 */

import { describe, it, expect } from 'vitest';
import { XmlTemplateGenerator } from '../../src/tools/createD365File';

describe('macro library (AxMacroDictionary)', () => {
  it('emits Name + Source with the caller source verbatim', () => {
    const xml = XmlTemplateGenerator.generate(
      'macro',
      'ConDemoModuleFlights',
      "#define.DemoFastPostingFlight('DemoFastPostingFlight')",
    );
    expect(xml).toContain('<AxMacroDictionary xmlns:i="http://www.w3.org/2001/XMLSchema-instance">');
    expect(xml).toContain('<Name>ConDemoModuleFlights</Name>');
    expect(xml).toContain("<Source>#define.DemoFastPostingFlight('DemoFastPostingFlight')</Source>");
  });

  it('XML-escapes the macro body (a #if.Never guard contains angle brackets)', () => {
    const xml = XmlTemplateGenerator.generate('macro', 'ConDemoGuards', '#define.Limit(a < b && c > d)');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    expect(xml).toContain('&amp;');
  });

  it('escapes the CR of every line break as &#xD;, the way the MS serializer does', () => {
    // A literal CRLF compiles too (the parser normalises it to LF), but it does
    // not round-trip — Visual Studio rewrites the element with &#xD; and the
    // golden churns. Pinned after the L1-macro-library-flight VM run.
    const xml = XmlTemplateGenerator.generate('macro', 'ConDemoModuleFlights', "#define.A('A')\n#define.B('B')");
    expect(xml).toContain("#define.A('A')&#xD;\r\n#define.B('B')");
    expect(xml).not.toMatch(/\('A'\)\r?\n#define/);
  });
});

describe('configuration key (AxConfigurationKey)', () => {
  it('emits Name + Label and omits ParentKey/LicenseCode when not given', () => {
    const xml = XmlTemplateGenerator.generate('configuration-key', 'ConDemoModuleKey', undefined, {
      label: '@MyModule:Key',
    });
    expect(xml).toContain('<AxConfigurationKey');
    expect(xml).toContain('<Name>ConDemoModuleKey</Name>');
    expect(xml).toContain('<Label>@MyModule:Key</Label>');
    expect(xml).not.toContain('<ParentKey>');
    expect(xml).not.toContain('<LicenseCode>');
  });

  it('writes the licensing chain (LicenseCode) and the nesting (ParentKey) when given', () => {
    const xml = XmlTemplateGenerator.generate('configuration-key', 'ConDemoReportsKey', undefined, {
      label: '@MyModule:Reports',
      parentKey: 'ConDemoModuleKey',
      licenseCode: 'ConDemoIsvSuite',
    });
    expect(xml).toContain('<ParentKey>ConDemoModuleKey</ParentKey>');
    expect(xml).toContain('<LicenseCode>ConDemoIsvSuite</LicenseCode>');
  });
});

describe('XDS security policy (AxSecurityPolicy)', () => {
  const xml = XmlTemplateGenerator.generate('security-policy', 'ConDemoTerritoryPolicy', undefined, {
    label: '@MyModule:Territory',
    primaryTable: 'ConDemoTerritory',
    query: 'ConDemoTerritoryPolicyQuery',
    constrainedTables: [{ name: 'ConDemoTerritoryLine', tableRelation: 'ConDemoTerritory' }],
  });

  it('carries the policy trio: PrimaryTable, Query and ConstrainedTable=Yes', () => {
    expect(xml).toContain('<PrimaryTable>ConDemoTerritory</PrimaryTable>');
    expect(xml).toContain('<Query>ConDemoTerritoryPolicyQuery</Query>');
    expect(xml).toContain('<ConstrainedTable>Yes</ConstrainedTable>');
    expect(xml).toContain('<Enabled>Yes</Enabled>');
  });

  it('writes each constrained table as an AxSecurityPolicyConstrainedTable with its relation', () => {
    // The i:type discriminator and the xmlns="" reset are what the
    // deserializer needs — a bare <Name> entry is silently dropped.
    expect(xml).toContain('i:type="AxSecurityPolicyConstrainedTable"');
    expect(xml).toContain('<Name>ConDemoTerritoryLine</Name>');
    expect(xml).toContain('<TableRelation>ConDemoTerritory</TableRelation>');
  });

  it('self-closes ConstrainedTables when no constrained table is passed', () => {
    const empty = XmlTemplateGenerator.generate('security-policy', 'ConDemoEmptyPolicy', undefined, {
      primaryTable: 'ConDemoTerritory',
    });
    expect(empty).toContain('<ConstrainedTables></ConstrainedTables>');
  });
});

describe('aggregate measurement (AxAggregateMeasurement)', () => {
  const xml = XmlTemplateGenerator.generate('aggregate-measurement', 'ConDemoRequestMeasure', undefined, {
    measureGroups: [{
      name: 'ConDemoRequestGroup',
      table: 'ConDemoRequestFactEntity',
      attributes: [{ name: 'RequestType', nameField: 'RequestType' }],
      measures: [{ name: 'AvgDaysToClose', field: 'DaysToClose', defaultAggregate: 'Avg' }],
    }],
  });

  it('defaults Usage to StagedEntityStore and keeps the V2 namespace', () => {
    expect(xml).toContain('xmlns="Microsoft.Dynamics.AX.Metadata.V2"');
    expect(xml).toContain('<Usage>StagedEntityStore</Usage>');
  });

  it('binds the measure group to its fact table/entity', () => {
    expect(xml).toContain('<AxMeasureGroup xmlns="">');
    expect(xml).toContain('<Table>ConDemoRequestFactEntity</Table>');
  });

  it('writes the dimension attribute through a KeyFields/DimensionField reference', () => {
    expect(xml).toContain('<AxDimensionAttribute>');
    expect(xml).toContain('<DimensionField>RequestType</DimensionField>');
  });

  it('writes the measure with its aggregation, under the name the contract uses', () => {
    // Pinned after the L3-aggregate-measurement-basic VM run: <AggregateFunction>
    // exists nowhere in PackagesLocalDirectory and was dropped silently, leaving
    // the measure on the Sum default while the build stayed green. The platform's
    // 531 measures use only Sum/DistinctCount/AverageOfChildren/Max/Min.
    expect(xml).toContain('<Name>AvgDaysToClose</Name>');
    expect(xml).toContain('<DefaultAggregate>AverageOfChildren</DefaultAggregate>');
    expect(xml).not.toContain('<AggregateFunction>');
    expect(xml).toContain('<Field>DaysToClose</Field>');
    expect(xml.indexOf('<DefaultAggregate>')).toBeLessThan(xml.indexOf('<Field>DaysToClose</Field>'));
  });

  it('defaults to Sum and refuses an aggregation the enum does not have', () => {
    const summed = XmlTemplateGenerator.generate('aggregate-measurement', 'ConDemoSum', undefined, {
      measureGroups: [{ name: 'G', table: 'T', measures: [{ name: 'Total', field: 'Amount' }] }],
    });
    expect(summed).toContain('<DefaultAggregate>Sum</DefaultAggregate>');

    expect(() =>
      XmlTemplateGenerator.generate('aggregate-measurement', 'ConDemoBogus', undefined, {
        measureGroups: [{ name: 'G', table: 'T', measures: [{ name: 'Total', field: 'Amount', defaultAggregate: 'Median' }] }],
      }),
    ).toThrow(/Median/);
  });
});

describe('license code (AxLicenseCode)', () => {
  it('emits the ISV licensing quartet with the platform defaults', () => {
    const xml = XmlTemplateGenerator.generate('license-code', 'ConDemoIsvSuite', undefined, {
      label: '@MyModule:IsvSuite',
      publicKey: 700,
    });
    expect(xml).toContain('<Name>ConDemoIsvSuite</Name>');
    expect(xml).toContain('<Group>Module</Group>');
    expect(xml).toContain('<Package>BusinessEssential</Package>');
    expect(xml).toContain('<PublicKey>700</PublicKey>');
  });

  it('refuses to guess the PublicKey — the slot is globally unique', () => {
    // Pinned after the L2-license-code-configkey VM run: the former default of
    // 2 is owned by ApplicationFoundation/LogisticsBasic, so every defaulted
    // license code failed the build with "Duplicate value '2' detected".
    expect(() =>
      XmlTemplateGenerator.generate('license-code', 'ConDemoIsvSuite', undefined, { label: '@MyModule:IsvSuite' }),
    ).toThrow(/publicKey/i);
  });
});
