import { describe, it, expect } from 'vitest';
import { removeDataEntityField } from '../../src/tools/xml/dataEntityViewEdit';

const MAPPED = (n: string, df: string, ds: string) =>
  `\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewMappedField">\n\t\t\t<Name>${n}</Name>\n\t\t\t<DataField>${df}</DataField>\n\t\t\t<DataSource>${ds}</DataSource>\n\t\t</AxDataEntityViewField>\n`;
const UNMAPPED = (n: string) =>
  `\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedFieldString">\n\t\t\t<Name>${n}</Name>\n\t\t</AxDataEntityViewField>\n`;
const DSF = (f: string) =>
  `\t\t\t\t\t<AxQuerySimpleDataSourceField>\n\t\t\t\t\t\t<Name>${f}</Name>\n\t\t\t\t\t\t<Field>${f}</Field>\n\t\t\t\t\t</AxQuerySimpleDataSourceField>\n`;

const xml = (fields: string, rootDs: string, embDs = '') => `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoFileEntity</Name>
\t<Fields>
${fields}\t</Fields>
\t<Keys>
\t\t<AxDataEntityViewKey>
\t\t\t<Name>EntityKey</Name>
\t\t\t<Fields>
\t\t\t\t<AxDataEntityViewKeyField>
\t\t\t\t\t<DataField>FileId</DataField>
\t\t\t\t</AxDataEntityViewKeyField>
\t\t\t</Fields>
\t\t</AxDataEntityViewKey>
\t</Keys>
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>Main</Name>
\t\t\t\t<Fields>
${rootDs}\t\t\t\t</Fields>
\t\t\t\t<DataSources>
${embDs}\t\t\t\t</DataSources>
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxDataEntityView>
`;
const EMB = (f: string) =>
  `\t\t\t\t\t<AxQuerySimpleEmbeddedDataSource>\n\t\t\t\t\t\t<Name>Joined</Name>\n\t\t\t\t\t\t<Fields>\n${DSF(f)}\t\t\t\t\t\t</Fields>\n\t\t\t\t\t</AxQuerySimpleEmbeddedDataSource>\n`;

describe('removeDataEntityField', () => {
  const base = xml(MAPPED('FileId', 'FileId', 'Main') + MAPPED('ArchiveRef', 'ArchiveRef', 'Main'),
    DSF('FileId') + DSF('ArchiveRef'));

  it('removes the entity field and its data-source field entry', () => {
    const r = removeDataEntityField(base, 'ArchiveRef');
    expect(r.ok).toBe(true);
    expect(r.removedEntityField).toBe(true);
    expect(r.removedDataSourceFields).toEqual(['Main.ArchiveRef']);
    expect(r.xml).not.toContain('ArchiveRef');
    expect(r.xml).toContain('<Field>FileId</Field>');
  });

  it('only removes the entry of the data source the field read', () => {
    const r = removeDataEntityField(
      xml(MAPPED('FileId', 'FileId', 'Main') + MAPPED('ArchiveRef', 'ArchiveRef', 'Joined'), DSF('ArchiveRef'), EMB('ArchiveRef')),
      'ArchiveRef');
    expect(r.removedDataSourceFields).toEqual(['Joined.ArchiveRef']);
    expect(r.xml).toContain('<Fields />');
    expect(r.xml).toContain('<Field>ArchiveRef</Field>'); // Main's entry is not this field's
  });

  it('removes leftover entries in every data source when the field is already gone', () => {
    const r = removeDataEntityField(xml(MAPPED('FileId', 'FileId', 'Main'), DSF('ArchiveRef'), EMB('ArchiveRef')), 'ArchiveRef');
    expect(r.removedDataSourceFields).toEqual(['Main.ArchiveRef', 'Joined.ArchiveRef']);
  });

  it('credits a derived data source entry to the derived source, not its parent', () => {
    const derivedXml = `\t\t\t\t<DerivedDataSources>\n\t\t\t\t\t<AxQuerySimpleDerivedDataSource>\n\t\t\t\t\t\t<Name>Person</Name>\n\t\t\t\t\t\t<Fields>\n${DSF('Initials')}\t\t\t\t\t\t</Fields>\n\t\t\t\t\t</AxQuerySimpleDerivedDataSource>\n\t\t\t\t</DerivedDataSources>\n`;
    const doc = xml(MAPPED('A', 'Initials', 'Person') + MAPPED('B', 'Initials', 'Person'), '')
      .replace('\t\t\t\t<DataSources>\n', `${derivedXml}\t\t\t\t<DataSources>\n`);
    const r = removeDataEntityField(doc, 'A');
    expect(r.removedDataSourceFields).toEqual([]);
    expect(r.xml).toContain('<Field>Initials</Field>');
  });

  it('reports a table mapping on the entity side and a query range on the column', () => {
    const mappings = `\t<Mappings>\n\t\t<AxDataEntityViewMapping>\n\t\t\t<Name>Map1</Name>\n\t\t\t<Connections>\n\t\t\t\t<AxDataEntityViewMappingConnection>\n\t\t\t\t\t<MapField>Other</MapField>\n\t\t\t\t\t<MapFieldTo>ArchiveRef</MapFieldTo>\n\t\t\t\t</AxDataEntityViewMappingConnection>\n\t\t\t</Connections>\n\t\t</AxDataEntityViewMapping>\n\t</Mappings>\n`;
    const ranges = `\t\t\t\t<Ranges>\n\t\t\t\t\t<AxQuerySimpleDataSourceRange>\n\t\t\t\t\t\t<Name>Col</Name>\n\t\t\t\t\t\t<Field>Col</Field>\n\t\t\t\t\t</AxQuerySimpleDataSourceRange>\n\t\t\t\t</Ranges>\n`;
    const doc = xml(MAPPED('ArchiveRef', 'Col', 'Main'), DSF('Col'))
      .replace('\t<ViewMetadata>', `${mappings}\t<ViewMetadata>`)
      .replace('\t\t\t\t<DataSources>\n', `${ranges}\t\t\t\t<DataSources>\n`);
    const r = removeDataEntityField(doc, 'ArchiveRef');
    expect(r.remaining?.some(x => x.includes('Mappings'))).toBe(true);
    expect(r.remaining?.some(x => x.includes('Range'))).toBe(true);
  });

  it('cleans only the leftover entry when the entity field is already gone', () => {
    const left = xml(MAPPED('FileId', 'FileId', 'Main'), DSF('FileId') + DSF('ArchiveRef'));
    const r = removeDataEntityField(left, 'ArchiveRef');
    expect(r.ok).toBe(true);
    expect(r.removedEntityField).toBe(false);
    expect(r.message).toContain('already removed');
    expect(r.xml).not.toContain('ArchiveRef');
    // and a second call has nothing left: a clear failure
    const again = removeDataEntityField(r.xml!, 'ArchiveRef');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('not found');
  });

  it('keeps the entry another entity field still reads', () => {
    const r = removeDataEntityField(
      xml(MAPPED('A', 'Col', 'Main') + MAPPED('B', 'Col', 'Main'), DSF('Col')), 'A');
    expect(r.removedDataSourceFields).toEqual([]);
    expect(r.xml).toContain('<Field>Col</Field>');
  });

  it('removes an unmapped (computed) field without touching data-source fields', () => {
    const r = removeDataEntityField(xml(MAPPED('FileId', 'FileId', 'Main') + UNMAPPED('Calc'), DSF('FileId')), 'Calc');
    expect(r.ok).toBe(true);
    expect(r.removedDataSourceFields).toEqual([]);
    expect(r.xml).not.toContain('Calc');
    expect(r.xml).toContain('<Field>FileId</Field>');
  });

  it('dataSourceName limits the cleanup and removing a key field is reported', () => {
    const r = removeDataEntityField(
      xml(MAPPED('FileId', 'FileId', 'Main'), DSF('FileId')), 'FileId', 'Main');
    expect(r.remaining?.[0]).toContain('Keys');
    const other = removeDataEntityField(base, 'ArchiveRef', 'Joined');
    expect(other.removedDataSourceFields).toEqual([]);
  });
});
