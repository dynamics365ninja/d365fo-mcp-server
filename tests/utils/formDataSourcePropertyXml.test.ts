/**
 * modify-property on an EXISTING form data source (#1161).
 *
 * JoinSource and LinkType could be given only while a data source was added, so
 * changing the join of an existing one meant editing the form XML by hand. The
 * writer replaces the element where it stands, or inserts it in the platform's
 * element order: after ReferencedDataSources, JoinSource before LinkType, both
 * before InsertIfEmpty and the elements that follow it.
 */

import { describe, it, expect } from 'vitest';
import {
  upsertFormDataSourceProperty, formDataSourceNames, FORM_DATA_SOURCE_PROPERTIES,
} from '../../src/utils/formDataSourcePropertyXml';

const FORM = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
  '\t<Name>ContosoRentForm</Name>',
  '\t<DataSources>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentHeader</Name>',
  '\t\t\t<Table>ContosoRentHeader</Table>',
  '\t\t\t<Fields>',
  '\t\t\t\t<AxFormDataSourceField>',
  '\t\t\t\t\t<DataField>RentId</DataField>',
  '\t\t\t\t</AxFormDataSourceField>',
  '\t\t\t</Fields>',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<InsertIfEmpty>No</InsertIfEmpty>',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentLine</Name>',
  '\t\t\t<Table>ContosoRentLine</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<JoinSource>ContosoRentHeader</JoinSource>',
  '\t\t\t<LinkType>Delayed</LinkType>',
  '\t\t\t<InsertIfEmpty>No</InsertIfEmpty>',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentNote</Name>',
  '\t\t\t<Table>ContosoRentNote</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t</DataSources>',
  '\t<Design />',
  '</AxForm>',
].join('\n');

const ok = (r: ReturnType<typeof upsertFormDataSourceProperty>) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
/** The lines of one data source, for position assertions. */
const dataSource = (xml: string, name: string): string =>
  xml.split('<AxFormDataSource xmlns="">').find(b => b.includes(`<Name>${name}</Name>`))!.split('</AxFormDataSource>')[0];

describe('upsertFormDataSourceProperty', () => {
  it('lists the data sources of the form', () => {
    expect(formDataSourceNames(FORM)).toEqual(['ContosoRentHeader', 'ContosoRentLine', 'ContosoRentNote']);
  });

  it('replaces an existing LinkType where it stands', () => {
    const r = ok(upsertFormDataSourceProperty(FORM, 'ContosoRentLine', 'LinkType', 'Passive'));
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(FORM.replace('<LinkType>Delayed</LinkType>', '<LinkType>Passive</LinkType>'));
    expect(r.detail).toContain("(was 'Delayed')");
  });

  it('replaces an existing JoinSource and takes the spelling the form declares', () => {
    const r = ok(upsertFormDataSourceProperty(FORM, 'contosorentline', 'joinsource', 'contosorentnote'));
    expect(r.xml).toBe(
      FORM.replace('<JoinSource>ContosoRentHeader</JoinSource>', '<JoinSource>ContosoRentNote</JoinSource>'));
  });

  it('inserts JoinSource right after ReferencedDataSources, then LinkType after it', () => {
    const joined = ok(upsertFormDataSourceProperty(FORM, 'ContosoRentNote', 'JoinSource', 'ContosoRentHeader'));
    expect(dataSource(joined.xml, 'ContosoRentNote')).toContain(
      '\t\t\t<ReferencedDataSources />\n\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\n\t\t\t<DataSourceLinks />');

    const linked = ok(upsertFormDataSourceProperty(joined.xml, 'ContosoRentNote', 'LinkType', 'outerjoin'));
    expect(dataSource(linked.xml, 'ContosoRentNote')).toContain(
      '\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\n\t\t\t<LinkType>OuterJoin</LinkType>\n\t\t\t<DataSourceLinks />');
    // Only that data source changed.
    expect(dataSource(linked.xml, 'ContosoRentLine')).toBe(dataSource(FORM, 'ContosoRentLine'));
  });

  it('inserts LinkType before JoinSource-less InsertIfEmpty, and JoinSource then lands before it', () => {
    const linked = ok(upsertFormDataSourceProperty(FORM, 'ContosoRentHeader', 'LinkType', 'Active'));
    expect(dataSource(linked.xml, 'ContosoRentHeader')).toContain(
      '\t\t\t<ReferencedDataSources />\n\t\t\t<LinkType>Active</LinkType>\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>');
    const joined = ok(upsertFormDataSourceProperty(linked.xml, 'ContosoRentHeader', 'JoinSource', 'ContosoRentNote'));
    expect(dataSource(joined.xml, 'ContosoRentHeader')).toContain(
      '\t\t\t<JoinSource>ContosoRentNote</JoinSource>\n\t\t\t<LinkType>Active</LinkType>\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>');
  });

  it('appends as the last child when nothing that follows it is present', () => {
    const bare = FORM.replace(
      '\t\t\t<Table>ContosoRentNote</Table>\n\t\t\t<Fields />\n\t\t\t<ReferencedDataSources />\n\t\t\t<DataSourceLinks />\n\t\t\t<DerivedDataSources />\n',
      '\t\t\t<Table>ContosoRentNote</Table>\n');
    const r = ok(upsertFormDataSourceProperty(bare, 'ContosoRentNote', 'JoinSource', 'ContosoRentHeader'));
    expect(dataSource(r.xml, 'ContosoRentNote')).toContain(
      '\t\t\t<Table>ContosoRentNote</Table>\n\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\n\t\t');
  });

  it('an empty value removes the element, and is a no-op when it is not there', () => {
    const r = ok(upsertFormDataSourceProperty(FORM, 'ContosoRentLine', 'LinkType', ''));
    expect(r.xml).toBe(FORM.replace('\t\t\t<LinkType>Delayed</LinkType>\n', ''));
    const again = ok(upsertFormDataSourceProperty(r.xml, 'ContosoRentLine', 'LinkType', ''));
    expect(again.changed).toBe(false);
    expect(again.xml).toBe(r.xml);
  });

  it('is idempotent: the value already there is not written again', () => {
    const r = ok(upsertFormDataSourceProperty(FORM, 'ContosoRentLine', 'LinkType', 'Delayed'));
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(FORM);
  });

  it('InsertIfEmpty: No is written before DataSourceLinks, Yes removes it (Yes is never serialized)', () => {
    const no = ok(upsertFormDataSourceProperty(FORM, 'ContosoRentNote', 'InsertIfEmpty', 'false'));
    expect(dataSource(no.xml, 'ContosoRentNote')).toContain(
      '\t\t\t<ReferencedDataSources />\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\n\t\t\t<DataSourceLinks />');
    const yes = ok(upsertFormDataSourceProperty(no.xml, 'ContosoRentNote', 'InsertIfEmpty', 'Yes'));
    expect(yes.xml).toBe(FORM);
    expect(upsertFormDataSourceProperty(FORM, 'ContosoRentNote', 'InsertIfEmpty', 'Maybe').ok).toBe(false);
  });

  it('keeps CRLF line endings and touches no other byte', () => {
    const crlf = FORM.replace(/\n/g, '\r\n');
    const r = ok(upsertFormDataSourceProperty(crlf, 'ContosoRentNote', 'JoinSource', 'ContosoRentHeader'));
    expect(r.xml).not.toMatch(/[^\r]\n/);
    expect(r.xml).toBe(crlf.replace(
      '<Name>ContosoRentNote</Name>\r\n\t\t\t<Table>ContosoRentNote</Table>\r\n\t\t\t<Fields />\r\n\t\t\t<ReferencedDataSources />\r\n',
      '<Name>ContosoRentNote</Name>\r\n\t\t\t<Table>ContosoRentNote</Table>\r\n\t\t\t<Fields />\r\n\t\t\t<ReferencedDataSources />\r\n' +
        '\t\t\t<JoinSource>ContosoRentHeader</JoinSource>\r\n'));
  });

  it('refuses an unknown data source and names the ones the form has', () => {
    const r = upsertFormDataSourceProperty(FORM, 'ContosoRentLines', 'LinkType', 'Active');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("'ContosoRentLines' was not found");
    expect(!r.ok && r.reason).toContain('ContosoRentHeader, ContosoRentLine, ContosoRentNote');
  });

  it.each([
    'CounterField', 'ValidTimeStateAutoQuery', 'ValidTimeStateUpdate', 'OptionalRecordMode', 'MaxRecordsToLoad',
    'Name', 'Table', 'NoSuchProperty',
  ])(
    'refuses %s, a property it cannot place with certainty, with the supported list',
    (property) => {
      const r = upsertFormDataSourceProperty(FORM, 'ContosoRentLine', property, 'No');
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toContain(`Supported: ${FORM_DATA_SOURCE_PROPERTIES.join(', ')}`);
    },
  );

  it('refuses a LinkType the platform enum does not have, with the valid names', () => {
    const r = upsertFormDataSourceProperty(FORM, 'ContosoRentLine', 'LinkType', 'LeftJoin');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(
      'Valid values: InnerJoin, OuterJoin, ExistJoin, NotExistJoin, Delayed, Active, Passive');
  });

  it('refuses a JoinSource that is not a data source of the form, or the data source itself', () => {
    const missing = upsertFormDataSourceProperty(FORM, 'ContosoRentLine', 'JoinSource', 'ContosoRentTable');
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toContain("'ContosoRentTable' is not a data source of this form");
    expect(!missing.ok && missing.reason).toContain('ContosoRentHeader, ContosoRentNote');

    const self = upsertFormDataSourceProperty(FORM, 'ContosoRentLine', 'JoinSource', 'ContosoRentLine');
    expect(self.ok).toBe(false);
  });

  // The order measured on Microsoft standard forms. It is not alphabetical.
  const set = (xml: string, property: string, value: string): string =>
    ok(upsertFormDataSourceProperty(xml, 'ContosoRentNote', property, value)).xml;
  const scalars = (xml: string): string[] =>
    [...dataSource(xml, 'ContosoRentNote').matchAll(/^\t\t\t<(\w+)>[^<]*<\/\1>$/gm)].map(m => m[1]).slice(2);

  it('AllowDelete lands between AllowCreate and AllowEdit', () => {
    let xml = set(FORM, 'AllowEdit', 'No');
    xml = set(xml, 'AllowCreate', 'No');
    xml = set(xml, 'AllowDelete', 'No');
    expect(dataSource(xml, 'ContosoRentNote')).toContain(
      '\t\t\t<ReferencedDataSources />\n\t\t\t<AllowCreate>No</AllowCreate>\n\t\t\t<AllowDelete>No</AllowDelete>\n' +
        '\t\t\t<AllowEdit>No</AllowEdit>\n\t\t\t<DataSourceLinks />');
  });

  it('DelayActive goes before JoinSource, Index after AllowEdit, the join before the Allow properties', () => {
    let xml = set(FORM, 'AllowEdit', 'No');
    xml = set(xml, 'JoinSource', 'ContosoRentHeader');
    xml = set(xml, 'Index', 'RentIdx');
    xml = set(xml, 'DelayActive', 'No');
    xml = set(xml, 'LinkType', 'Passive');
    expect(scalars(xml)).toEqual(['DelayActive', 'JoinSource', 'LinkType', 'AllowEdit', 'Index']);
    expect(dataSource(xml, 'ContosoRentNote')).toContain('\t\t\t<Index>RentIdx</Index>\n\t\t\t<DataSourceLinks />');
  });

  it('places every supported property in the measured order, whatever order they are set in', () => {
    let xml = FORM;
    for (const property of [...FORM_DATA_SOURCE_PROPERTIES].reverse()) {
      const value = property === 'JoinSource' ? 'ContosoRentHeader'
        : property === 'LinkType' ? 'InnerJoin'
        : property === 'Index' ? 'RentIdx'
        : property === 'MaxAccessRight' ? 'View'
        : property === 'StartPosition' ? 'Last'
        : 'No';
      xml = set(xml, property, value);
    }
    expect(scalars(xml)).toEqual([
      'AutoNotify', 'AutoQuery', 'AutoSearch', 'CrossCompanyAutoQuery', 'DelayActive', 'JoinSource', 'LinkType',
      'OnlyFetchActive', 'AllowCheck', 'AllowCreate', 'AllowDelete', 'AllowEdit', 'Index', 'InsertAtEnd',
      'InsertIfEmpty', 'MaxAccessRight', 'StartPosition',
    ]);
    expect(dataSource(xml, 'ContosoRentNote')).toContain(
      '\t\t\t<StartPosition>Last</StartPosition>\n\t\t\t<DataSourceLinks />\n\t\t\t<DerivedDataSources />');
  });

  it('Yes/No properties take Yes or No, and only InsertIfEmpty=Yes removes the element', () => {
    expect(set(FORM, 'AllowEdit', 'true')).toContain('<AllowEdit>Yes</AllowEdit>');
    expect(set(FORM, 'AutoQuery', 'no')).toContain('<AutoQuery>No</AutoQuery>');
    expect(upsertFormDataSourceProperty(FORM, 'ContosoRentNote', 'AllowEdit', 'Never').ok).toBe(false);
    expect(set(set(FORM, 'AllowEdit', 'No'), 'AllowEdit', '')).toBe(FORM);
  });

  it('a rare element outside the chain: properties up to InsertIfEmpty go before it, later ones are refused', () => {
    const rare = FORM.replace(
      '\t\t\t<ReferencedDataSources />\n\t\t\t<DataSourceLinks />',
      '\t\t\t<ReferencedDataSources />\n\t\t\t<OptionalRecordMode>ImplicitCreate</OptionalRecordMode>\n\t\t\t<DataSourceLinks />');
    expect(set(rare, 'AllowEdit', 'No')).toContain(
      '<AllowEdit>No</AllowEdit>\n\t\t\t<OptionalRecordMode>ImplicitCreate</OptionalRecordMode>');
    const late = upsertFormDataSourceProperty(rare, 'ContosoRentNote', 'StartPosition', 'Last');
    expect(late.ok).toBe(false);
    expect(!late.ok && late.reason).toContain('<OptionalRecordMode>');

    const counter = FORM.replace(
      '\t\t\t<ReferencedDataSources />\n\t\t\t<DataSourceLinks />',
      '\t\t\t<ReferencedDataSources />\n\t\t\t<CounterField>LineNum</CounterField>\n\t\t\t<DataSourceLinks />');
    expect(upsertFormDataSourceProperty(counter, 'ContosoRentNote', 'JoinSource', 'ContosoRentHeader').ok).toBe(false);
    // A replacement does not move anything.
    const joined = counter.replace(
      '<CounterField>LineNum</CounterField>', '<JoinSource>ContosoRentHeader</JoinSource>\n\t\t\t<CounterField>LineNum</CounterField>');
    expect(ok(upsertFormDataSourceProperty(joined, 'ContosoRentNote', 'JoinSource', 'ContosoRentLine')).xml)
      .toBe(joined.replace(
        '<JoinSource>ContosoRentHeader</JoinSource>\n\t\t\t<CounterField>',
        '<JoinSource>ContosoRentLine</JoinSource>\n\t\t\t<CounterField>'));
  });

  it('form extension: a JoinSource outside the file is accepted with a note, the shape is the same', () => {
    const extension = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
      '\t<Name>CustTable.ContosoExt</Name>',
      '\t<DataSources>',
      '\t\t<AxFormDataSource xmlns="">',
      '\t\t\t<Name>ContosoRentNote</Name>',
      '\t\t\t<Table>ContosoRentNote</Table>',
      '\t\t\t<Fields />',
      '\t\t\t<ReferencedDataSources />',
      '\t\t\t<DataSourceLinks />',
      '\t\t\t<DerivedDataSources />',
      '\t\t</AxFormDataSource>',
      '\t</DataSources>',
      '</AxFormExtension>',
    ].join('\n');
    expect(upsertFormDataSourceProperty(extension, 'ContosoRentNote', 'JoinSource', 'CustTable').ok).toBe(false);
    const r = ok(upsertFormDataSourceProperty(
      extension, 'ContosoRentNote', 'JoinSource', 'CustTable', { joinSourceCheck: 'skip-when-absent' }));
    expect(r.xml).toContain('\t\t\t<ReferencedDataSources />\n\t\t\t<JoinSource>CustTable</JoinSource>\n\t\t\t<DataSourceLinks />');
    expect(r.detail).toContain('base form');
  });
});
