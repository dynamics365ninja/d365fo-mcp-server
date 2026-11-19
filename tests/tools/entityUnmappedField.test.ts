/**
 * Unmapped fields of a data entity: add-field (entity and extension) and create fields[].
 * Shape and member order are those of the shipped CustCreditCardEntity (Street/City/…):
 *   Name, ExtendedDataType, IsComputedField(No)
 * and of the computed ones: Name, Label, ComputedFieldMethod, ExtendedDataType.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEntityUnmappedFieldXml, addEntityUnmappedField, isUnmappedEntityFieldSpec,
} from '../../src/tools/xml/entityUnmappedField';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';
import { addDataEntityMappedField } from '../../src/tools/xml/dataEntityViewEdit';
import { isUnmappedEntityField } from '../../src/tools/write/dataEntityOps';

const entity = () => buildAxDataEntityXml('ContosoThingEntity', {
  label: '@X:Y', primaryTable: 'AssetTrans', fields: [{ name: 'AssetId' }, { name: 'Amount' }],
});
const tags = (xml: string) => [...xml.matchAll(/^\t\t\t<(\w+)>/gm)].map(m => m[1]);

describe('buildEntityUnmappedFieldXml', () => {
  it('writes the shipped shape for an EDT string field', () => {
    const r = buildEntityUnmappedFieldXml({ name: 'Street', edt: 'LogisticsAddressStreet', baseType: 'String' });
    expect(r.ok).toBe(true);
    expect((r as any).xml).toBe(
      '\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedFieldString">\n' +
      '\t\t\t<Name>Street</Name>\n\t\t\t<ExtendedDataType>LogisticsAddressStreet</ExtendedDataType>\n' +
      '\t\t\t<IsComputedField>No</IsComputedField>\n\t\t</AxDataEntityViewField>');
  });

  it.each([
    ['Integer', 'Int'], ['Int64', 'Int64'], ['Real', 'Real'], ['Date', 'Date'], ['DateTime', 'UtcDateTime'],
    ['UtcDateTime', 'UtcDateTime'], ['GUID', 'Guid'], ['Container', 'Container'], ['Time', 'Time'],
  ])('base type %s → AxDataEntityViewUnmappedField%s', (type, suffix) => {
    const r: any = buildEntityUnmappedFieldXml({ name: 'F', baseType: type });
    expect(r.ok).toBe(true);
    expect(r.xml).toContain(`i:type="AxDataEntityViewUnmappedField${suffix}"`);
    expect(r.xml).toContain('<IsComputedField>No</IsComputedField>');
  });

  it('an enum type gives the Enum element with EnumType after IsComputedField', () => {
    const r: any = buildEntityUnmappedFieldXml({ name: 'S', enumType: 'NoYes', label: '@X:S' });
    expect(r.xml).toContain('AxDataEntityViewUnmappedFieldEnum');
    expect(tags(r.xml)).toEqual(['Name', 'Label', 'IsComputedField', 'EnumType']);
  });

  it('keeps the serializer order of the optional members', () => {
    const r: any = buildEntityUnmappedFieldXml({
      name: 'N', edt: 'Notes', baseType: 'String', label: '@X:N', helpText: '@X:H', mandatory: true });
    expect(tags(r.xml)).toEqual(['Name', 'HelpText', 'Label', 'Mandatory', 'ExtendedDataType', 'IsComputedField']);
  });

  it('a computed field carries ComputedFieldMethod instead of IsComputedField', () => {
    const r: any = buildEntityUnmappedFieldXml({ name: 'C', edt: 'AmountMST', baseType: 'Real', computedFieldMethod: 'cDef' });
    expect(tags(r.xml)).toEqual(['Name', 'ComputedFieldMethod', 'ExtendedDataType']);
  });

  it('a string without an EDT gets StringSize, and is refused without one', () => {
    expect((buildEntityUnmappedFieldXml({ name: 'S', baseType: 'String', stringSize: 20 }) as any).xml)
      .toContain('<StringSize>20</StringSize>');
    expect(buildEntityUnmappedFieldXml({ name: 'S', baseType: 'String' }).ok).toBe(false);
  });

  it('never guesses a type: an EDT of unknown base type is refused, a resolver supplies it', () => {
    const r: any = buildEntityUnmappedFieldXml({ name: 'F', edt: 'MyEdt' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('fieldBaseType');
    expect((buildEntityUnmappedFieldXml({ name: 'F', edt: 'MyEdt' }, () => 'Real') as any).xml)
      .toContain('UnmappedFieldReal');
  });

  it('refuses bad names, base types and Mandatory values', () => {
    expect(buildEntityUnmappedFieldXml({ name: 'a b', baseType: 'Real' }).ok).toBe(false);
    expect(buildEntityUnmappedFieldXml({ name: 'F', baseType: 'Boolean' }).ok).toBe(false);
    expect(buildEntityUnmappedFieldXml({ name: 'F', baseType: 'Real', mandatory: 'maybe' }).ok).toBe(false);
  });
});

describe('addEntityUnmappedField', () => {
  it('appends at the end of <Fields> and touches nothing else', () => {
    const before = entity();
    const r = addEntityUnmappedField(before, { name: 'ContentBase64', edt: 'Notes', baseType: 'String' });
    expect(r.ok).toBe(true);
    const after = r.xml!;
    const names = [...after.matchAll(/<AxDataEntityViewField[^>]*>\s*<Name>(\w+)</g)].map(m => m[1]);
    expect(names).toEqual(['AssetId', 'Amount', 'ContentBase64']);
    // Everything outside the new element is byte-identical: keys, public names, query, staging reference.
    const element = /\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedField[\s\S]*?<\/AxDataEntityViewField>\n/.exec(after)![0];
    expect(after.replace(element, '')).toBe(before);
    expect(after.indexOf(element)).toBeLessThan(after.indexOf('<Keys>'));
    // not in the query
    expect(after.match(/<Name>ContentBase64<\/Name>/g)).toHaveLength(1);
  });

  it('works on a self-closed <Fields />', () => {
    const xml = entity().replace(/\t<Fields>[\s\S]*?\n\t<\/Fields>/, '\t<Fields />');
    const r = addEntityUnmappedField(xml, { name: 'V', baseType: 'Integer' });
    expect(r.xml).toMatch(/\t<Fields>\n\t\t<AxDataEntityViewField[\s\S]*UnmappedFieldInt[\s\S]*\n\t<\/Fields>/);
  });

  it('is placed after mapped fields added earlier and does not break a later mapped add', () => {
    const a = addEntityUnmappedField(entity(), { name: 'V', baseType: 'Real' }).xml!;
    const b = addDataEntityMappedField(a, { name: 'Extra', dataField: 'Extra', dataSource: 'AssetTrans' });
    expect(b.ok).toBe(true);
    expect([...b.xml!.matchAll(/<AxDataEntityViewField[^>]*>\s*<Name>(\w+)</g)].map(m => m[1]))
      .toEqual(['AssetId', 'Amount', 'V', 'Extra']);
  });

  it('refuses a duplicate name and a non-entity document', () => {
    expect(addEntityUnmappedField(entity(), { name: 'AssetId', baseType: 'Real' }).ok).toBe(false);
    expect(addEntityUnmappedField('<AxTable><Name>T</Name></AxTable>', { name: 'F', baseType: 'Real' }).ok).toBe(false);
  });

  it('adds to a data-entity extension\'s top-level <Fields>, not the field group\'s', () => {
    const ext = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityViewExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoThingEntity.ContosoExt</Name>
\t<DataSources />
\t<FieldGroupExtensions>
\t\t<AxTableFieldGroupExtension>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>X</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroupExtension>
\t</FieldGroupExtensions>
\t<FieldGroups />
\t<FieldModifications />
\t<Fields />
\t<Mappings />
\t<PropertyModifications />
\t<Relations />
</AxDataEntityViewExtension>`;
    const r = addEntityUnmappedField(ext, { name: 'V', baseType: 'Date' });
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('\t<Fields>\n\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedFieldDate">');
    expect(r.xml!.indexOf('UnmappedFieldDate')).toBeGreaterThan(r.xml!.indexOf('</FieldModifications>'));
  });
});

describe('create data-entity with unmapped fields', () => {
  const create = (fields: any[], extra: Record<string, any> = {}) => buildAxDataEntityXml('ContosoThingEntity', {
    label: '@X:Y', primaryTable: 'AssetTrans', fields, ...extra });

  it('only unmapped:true makes an unmapped field; a bare {name} stays mapped', () => {
    const xml = create([{ name: 'AssetId' }, { name: 'Content', unmapped: true, edt: 'Notes', type: 'String' },
      { name: 'Flag', unmapped: true, enumType: 'NoYes' }]);
    expect(xml).toContain('i:type="AxDataEntityViewMappedField">\n\t\t\t<Name>AssetId</Name>');
    expect(xml).toContain('UnmappedFieldString');
    expect(xml).toContain('UnmappedFieldEnum');
  });

  it('a typed entry WITHOUT unmapped:true is still mapped (table-create shape, no regression)', () => {
    const xml = create([{ name: 'AccountNum', type: 'String', edt: 'CustAccount' }, { name: 'Name' }]);
    expect(xml).not.toContain('Unmapped');
    expect(xml).toMatch(/<AxDataEntityViewKeyField>\s*<DataField>AccountNum</);
  });

  it('unmapped fields stay out of the query and are never the default key', () => {
    const xml = create([{ name: 'Content', unmapped: true, edt: 'Notes', type: 'String' }, { name: 'AssetId' }]);
    expect(xml.slice(xml.indexOf('<ViewMetadata>'))).not.toContain('Content');
    expect(xml).toMatch(/<AxDataEntityViewKeyField>\s*<DataField>AssetId<\/DataField>/);
  });

  it('refuses an unmapped key, an all-unmapped list, unmapped+dataField, and an untypeable entry', () => {
    expect(() => create([{ name: 'AssetId' }, { name: 'C', unmapped: true, type: 'Real' }], { primaryKeyField: 'C' })).toThrow(/unmapped/);
    expect(() => create([{ name: 'C', unmapped: true, type: 'Real' }])).toThrow(/every field is unmapped/);
    expect(() => create([{ name: 'AssetId' }, { name: 'C', unmapped: true, dataField: 'X', type: 'Real' }])).toThrow(/both unmapped/);
    expect(() => create([{ name: 'AssetId' }, { name: 'C', unmapped: true, edt: 'SomeEdt' }])).toThrow(/cannot tell the type/);
  });
});

describe('review regressions', () => {
  it('a base-type keyword in the EDT slot is a base type, not an EDT', () => {
    const r: any = buildEntityUnmappedFieldXml({ name: 'F', edt: 'String', stringSize: 50 });
    expect(r.xml).toContain('UnmappedFieldString');
    expect(r.xml).not.toContain('<ExtendedDataType>');
    expect(r.xml).toContain('<StringSize>50</StringSize>');
    expect((buildEntityUnmappedFieldXml({ name: 'F', edt: 'Real' }) as any).xml).toContain('UnmappedFieldReal');
  });
  it('refuses an XML element name as the EDT', () => {
    expect(buildEntityUnmappedFieldXml({ name: 'F', edt: 'AxTableFieldString' }).ok).toBe(false);
  });
  it('validates StringSize and keeps it next to an EDT', () => {
    expect(buildEntityUnmappedFieldXml({ name: 'F', baseType: 'String', stringSize: 'abc' }).ok).toBe(false);
    expect(buildEntityUnmappedFieldXml({ name: 'F', baseType: 'Real', stringSize: 5 }).ok).toBe(false);
    expect((buildEntityUnmappedFieldXml({ name: 'F', edt: 'Notes', baseType: 'String', stringSize: 30 }) as any).xml)
      .toContain('<StringSize>30</StringSize>');
  });
  it('refuses a base type that contradicts the EDT', () => {
    const r: any = buildEntityUnmappedFieldXml({ name: 'F', edt: 'CustAccount', baseType: 'Real' }, () => 'String');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('is a String');
  });
  it('duplicate names are matched case-insensitively', () => {
    expect(addEntityUnmappedField(entity(), { name: 'assetid', baseType: 'Real' }).ok).toBe(false);
  });
});

describe('selecting the unmapped path', () => {
  it('add-field: only unmapped=true (or a bare computedFieldMethod) selects it', () => {
    expect(isUnmappedEntityField({ unmapped: true, fieldType: 'Notes' })).toBe(true);
    expect(isUnmappedEntityField({ computedFieldMethod: 'm' })).toBe(true);
    expect(isUnmappedEntityField({ fieldType: 'Notes' })).toBe(false);
    expect(isUnmappedEntityField({ fieldBaseType: 'Real' })).toBe(false);
    expect(isUnmappedEntityField({ unmapped: false, fieldType: 'Notes' })).toBe(false);
  });
  it('add-field: a binding keeps the mapped path exactly as before', () => {
    expect(isUnmappedEntityField({ dataField: 'F', dataSource: 'T' })).toBe(false);
    expect(isUnmappedEntityField({ dataField: 'F', dataSource: 'T', fieldType: 'Notes' })).toBe(false);
  });
  it('create fields[]', () => {
    expect(isUnmappedEntityFieldSpec({ name: 'A' })).toBe(false);
    expect(isUnmappedEntityFieldSpec({ name: 'A', type: 'Real', edt: 'X' })).toBe(false);
    expect(isUnmappedEntityFieldSpec({ name: 'A', unmapped: true })).toBe(true);
  });
});
