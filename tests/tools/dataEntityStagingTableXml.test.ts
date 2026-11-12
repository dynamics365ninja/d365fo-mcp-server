/**
 * The staging table of a data entity, as XML.
 *
 * The expected shape is the shipped CustCustomerGroupEntityStaging: a regular
 * table in TableGroup Staging with the four DMF fields, one field per public
 * entity field, the alternate-key index StagingIdx and the DataEntity relation.
 * The entity here is a custom one over the standard CustGroup table.
 */
import { describe, it, expect } from 'vitest';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';
import {
  buildStagingTableXml, readEntityForStaging, type StagingTableField,
} from '../../src/tools/xml/dataEntityStagingTableXml';
import { applyTableBpDefaults } from '../../src/tools/xml/tableBpDefaults';

const FIELDS: StagingTableField[] = [
  { name: 'CustomerGroupId', fieldType: 'AxTableFieldString', extendedDataType: 'CustGroupId' },
  { name: 'Description', fieldType: 'AxTableFieldString', extendedDataType: 'Description' },
  { name: 'IsSalesTaxIncludedInPrice', fieldType: 'AxTableFieldEnum', enumType: 'NoYes', label: '@RET5093' },
  { name: 'PaymentTermId', fieldType: 'AxTableFieldString', extendedDataType: 'PaymTermId' },
];

const staging = (extra: Record<string, unknown> = {}) => buildStagingTableXml({
  tableName: 'ContosoCustomerGroupEntityStaging',
  entityName: 'ContosoCustomerGroupEntity',
  label: '@SYS16445',
  configurationKey: 'LedgerBasic',
  formRef: 'CustGroup',
  fields: FIELDS,
  keyFields: ['CustomerGroupId'],
  ...extra,
});

const topLevel = (xml: string) => [...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1]);
const fieldBlock = (xml: string, name: string) =>
  new RegExp(`\\t\\t<AxTableField xmlns=""\\n\\t\\t\\ti:type="\\w+">\\n\\t\\t\\t<Name>${name}</Name>\\n[\\s\\S]*?\\t\\t</AxTableField>\\n`).exec(xml)?.[0] ?? '';
const children = (block: string) => [...block.matchAll(/^\t\t\t<(\w+)>/gm)].map(m => m[1]);

describe('buildStagingTableXml', () => {
  it('writes the top-level elements in the order of the shipped staging table', () => {
    expect(topLevel(staging())).toEqual([
      'Name', 'SourceCode', 'ConfigurationKey', 'DeveloperDocumentation', 'FormRef', 'Label', 'TableGroup',
      'TitleField1', 'TitleField2', 'PrimaryIndex', 'ReplacementKey', 'SaveDataPerCompany', 'DeleteActions',
      'FieldGroups', 'Fields', 'FullTextIndexes', 'Indexes', 'Mappings', 'Relations', 'StateMachines',
    ]);
  });

  it('is a regular table in TableGroup Staging, shared across companies', () => {
    const xml = staging();
    expect(xml).not.toContain('<TableType>');
    expect(xml).toContain('<TableGroup>Staging</TableGroup>');
    expect(xml).toContain('<SaveDataPerCompany>No</SaveDataPerCompany>');
    expect(xml).toContain('<DeveloperDocumentation>@DMF:StagingDeveloperDocumentation</DeveloperDocumentation>');
    expect(xml).toContain('<PrimaryIndex>StagingIdx</PrimaryIndex>');
    expect(xml).toContain('<ReplacementKey>StagingIdx</ReplacementKey>');
    expect(xml).toContain('public class ContosoCustomerGroupEntityStaging extends common\n{\n}\n\n]]></Declaration>');
  });

  it('copies Label, ConfigurationKey and FormRef from the entity and leaves out what the entity has not', () => {
    const xml = staging();
    expect(xml).toContain('<Label>@SYS16445</Label>');
    expect(xml).toContain('<ConfigurationKey>LedgerBasic</ConfigurationKey>');
    expect(xml).toContain('<FormRef>CustGroup</FormRef>');
    const bare = topLevel(staging({ label: undefined, configurationKey: undefined, formRef: undefined }));
    expect(bare.slice(0, 4)).toEqual(['Name', 'SourceCode', 'DeveloperDocumentation', 'TableGroup']);
  });

  it('takes the title fields from the key and the next field', () => {
    const xml = staging();
    expect(xml).toContain('<TitleField1>CustomerGroupId</TitleField1>');
    expect(xml).toContain('<TitleField2>Description</TitleField2>');
  });

  it('writes the four DMF fields exactly as shipped', () => {
    const xml = staging();
    expect(fieldBlock(xml, 'DefinitionGroup')).toBe(
      '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldString">\n' +
      '\t\t\t<Name>DefinitionGroup</Name>\n\t\t\t<AllowEdit>No</AllowEdit>\n' +
      '\t\t\t<ExtendedDataType>DMFDefinitionGroupName</ExtendedDataType>\n' +
      '\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n\t\t\t<Mandatory>Yes</Mandatory>\n' +
      '\t\t\t<StringSize>60</StringSize>\n\t\t</AxTableField>\n');
    expect(fieldBlock(xml, 'ExecutionId')).toBe(
      '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldString">\n' +
      '\t\t\t<Name>ExecutionId</Name>\n\t\t\t<AllowEdit>No</AllowEdit>\n' +
      '\t\t\t<ExtendedDataType>DMFExecutionId</ExtendedDataType>\n' +
      '\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n\t\t\t<Mandatory>Yes</Mandatory>\n' +
      '\t\t\t<StringSize>90</StringSize>\n\t\t</AxTableField>\n');
    expect(fieldBlock(xml, 'IsSelected')).toBe(
      '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldEnum">\n' +
      '\t\t\t<Name>IsSelected</Name>\n\t\t\t<ExtendedDataType>DMFIsSelected</ExtendedDataType>\n' +
      '\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n\t\t\t<EnumType>NoYes</EnumType>\n\t\t</AxTableField>\n');
    expect(fieldBlock(xml, 'TransferStatus')).toBe(
      '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldEnum">\n' +
      '\t\t\t<Name>TransferStatus</Name>\n\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n' +
      '\t\t\t<EnumType>DMFTransferStatus</EnumType>\n\t\t</AxTableField>\n');
  });

  it('writes one field per entity field, the key locked and mandatory', () => {
    const xml = staging();
    expect(children(fieldBlock(xml, 'CustomerGroupId'))).toEqual(
      ['Name', 'AllowEdit', 'ExtendedDataType', 'IsSystemGenerated', 'Mandatory']);
    expect(fieldBlock(xml, 'CustomerGroupId')).toContain('<ExtendedDataType>CustGroupId</ExtendedDataType>');
    expect(children(fieldBlock(xml, 'Description'))).toEqual(['Name', 'ExtendedDataType', 'IsSystemGenerated']);
    expect(fieldBlock(xml, 'IsSalesTaxIncludedInPrice')).toBe(
      '\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldEnum">\n' +
      '\t\t\t<Name>IsSalesTaxIncludedInPrice</Name>\n\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n' +
      '\t\t\t<Label>@RET5093</Label>\n\t\t\t<EnumType>NoYes</EnumType>\n\t\t</AxTableField>\n');
    expect([...xml.matchAll(/<AxTableField xmlns=""/g)]).toHaveLength(8);
  });

  it('puts the DMF fields in the ExtensionList group and the entity fields in AutoReport', () => {
    const xml = staging({ autoReportFields: ['CustomerGroupId', 'Description', 'NotOnTheTable'] });
    expect(xml).toContain(
      '\t\t<AxTableFieldGroup>\n\t\t\t<Name>ExtensionList</Name>\n\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n' +
      '\t\t\t<Label>@DMF:StagingExtensionGroup</Label>\n\t\t\t<Fields>\n' +
      ['DefinitionGroup', 'IsSelected', 'TransferStatus', 'ExecutionId']
        .map(f => `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`).join('') +
      '\t\t\t</Fields>\n\t\t</AxTableFieldGroup>\n');
    const autoReport = /<Name>AutoReport<\/Name>[\s\S]*?<\/AxTableFieldGroup>/.exec(xml)![0];
    expect([...autoReport.matchAll(/<DataField>(\w+)</g)].map(m => m[1])).toEqual(['CustomerGroupId', 'Description']);
    expect(xml).toContain('<Name>AutoIdentification</Name>\n\t\t\t<AutoPopulate>Yes</AutoPopulate>\n\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>');
    // Without an AutoReport on the entity every entity field is listed, so none is left in no group.
    const all = /<Name>AutoReport<\/Name>[\s\S]*?<\/AxTableFieldGroup>/.exec(staging())![0];
    expect([...all.matchAll(/<DataField>(\w+)</g)].map(m => m[1])).toEqual(FIELDS.map(f => f.name));
  });

  it('writes the index StagingIdx on DefinitionGroup, ExecutionId and the key fields', () => {
    expect(staging()).toContain(
      '\t<Indexes>\n\t\t<AxTableIndex>\n\t\t\t<Name>StagingIdx</Name>\n\t\t\t<AlternateKey>Yes</AlternateKey>\n' +
      '\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n\t\t\t<Fields>\n' +
      ['DefinitionGroup', 'ExecutionId', 'CustomerGroupId']
        .map(f => `\t\t\t\t<AxTableIndexField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxTableIndexField>\n`).join('') +
      '\t\t\t</Fields>\n\t\t</AxTableIndex>\n\t</Indexes>\n');
  });

  it('writes the DataEntity relation to the entity on the key fields', () => {
    expect(staging()).toContain(
      '\t<Relations>\n\t\t<AxTableRelation xmlns=""\n\t\t\ti:type="AxTableRelationForeignKey">\n' +
      '\t\t\t<Name>DataEntity</Name>\n\t\t\t<Cardinality>ExactlyOne</Cardinality>\n' +
      '\t\t\t<EntityRelationshipRole>@DMF:StagingToDataEntityRelationshipRole</EntityRelationshipRole>\n' +
      '\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n' +
      '\t\t\t<RelatedTable>ContosoCustomerGroupEntity</RelatedTable>\n' +
      '\t\t\t<RelatedTableCardinality>ZeroOne</RelatedTableCardinality>\n' +
      '\t\t\t<RelationshipType>Link</RelationshipType>\n\t\t\t<Validate>No</Validate>\n' +
      '\t\t\t<Constraints>\n\t\t\t\t<AxTableRelationConstraint xmlns=""\n\t\t\t\t\ti:type="AxTableRelationConstraintField">\n' +
      '\t\t\t\t\t<Name>CustomerGroupId</Name>\n\t\t\t\t\t<Field>CustomerGroupId</Field>\n' +
      '\t\t\t\t\t<RelatedField>CustomerGroupId</RelatedField>\n\t\t\t\t</AxTableRelationConstraint>\n' +
      '\t\t\t</Constraints>\n\t\t</AxTableRelation>\n\t</Relations>\n');
  });

  it('keeps a key field that is not on the table out of the index and the relation', () => {
    const xml = staging({ fields: FIELDS.slice(1), keyFields: ['CustomerGroupId'] });
    expect(xml).not.toContain('<DataField>CustomerGroupId</DataField>');
    expect(xml).toContain('<Constraints />');
    expect(xml).toContain('<TitleField1>Description</TitleField1>');
  });

  it('never writes an entity field under the name of a DMF field', () => {
    const xml = staging({ fields: [...FIELDS, { name: 'ExecutionId', fieldType: 'AxTableFieldInt64' }] });
    expect([...xml.matchAll(/<Name>ExecutionId<\/Name>/g)]).toHaveLength(1);
    expect(xml).not.toContain('AxTableFieldInt64');
  });

  it('the table best-practice defaults leave the system-generated fields and relation alone', () => {
    const xml = staging();
    const r = applyTableBpDefaults(xml, {
      edtRelations: { custgroupid: { table: 'CustGroup', relatedField: 'CustGroup' } },
    });
    expect(r.xml).toBe(xml);
    expect(r.notes).toEqual([]);
  });
});

describe('readEntityForStaging', () => {
  const entityXml = buildAxDataEntityXml('ContosoCustomerGroupEntity', {
    label: '@SYS16445', configurationKey: 'LedgerBasic', primaryTable: 'CustGroup', primaryKey: 'CustomerGroupKey',
    fields: [{ name: 'CustomerGroupId', dataField: 'CustGroup' }, { name: 'Description', dataField: 'Name' }],
    dataManagementEnabled: true, standardStructure: true,
  });

  it('reads the properties, fields, key and data sources the create wrote', () => {
    const e = readEntityForStaging(entityXml)!;
    expect(e.name).toBe('ContosoCustomerGroupEntity');
    expect(e.label).toBe('@SYS16445');
    expect(e.configurationKey).toBe('LedgerBasic');
    expect(e.dataManagementEnabled).toBe(true);
    expect(e.stagingTable).toBe('ContosoCustomerGroupEntityStaging');
    expect(e.fields.map(f => [f.name, f.iType, f.dataSource, f.dataField])).toEqual([
      ['CustomerGroupId', 'AxDataEntityViewMappedField', 'CustGroup', 'CustGroup'],
      ['Description', 'AxDataEntityViewMappedField', 'CustGroup', 'Name'],
    ]);
    expect(e.keyFields).toEqual(['CustomerGroupId']);
    expect(e.dataSources.get('custgroup')).toBe('CustGroup');
    expect(e.autoReportFields).toEqual([]);
  });

  it('reads CRLF documents, private fields, computed fields and joined data sources', () => {
    const xml = entityXml
      .replace('\t</Fields>\n\t<Keys>',
        '\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewMappedField">\n\t\t\t<Name>DefaultDimension</Name>\n' +
        '\t\t\t<AccessModifier>Private</AccessModifier>\n\t\t\t<DataField>DefaultDimension</DataField>\n\t\t\t<DataSource>CustGroup</DataSource>\n' +
        '\t\t</AxDataEntityViewField>\n' +
        '\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedFieldString">\n\t\t\t<Name>Summary</Name>\n' +
        '\t\t\t<ExtendedDataType>Description</ExtendedDataType>\n\t\t</AxDataEntityViewField>\n\t</Fields>\n\t<Keys>')
      .replace('\t\t\t\t<DataSources />\n',
        '\t\t\t\t<DataSources>\n\t\t\t\t\t<AxQuerySimpleEmbeddedDataSource>\n\t\t\t\t\t\t<Name>Terms</Name>\n' +
        '\t\t\t\t\t\t<IsReadOnly>Yes</IsReadOnly>\n\t\t\t\t\t\t<Table>PaymTerm</Table>\n\t\t\t\t\t\t<DataSources />\n' +
        '\t\t\t\t\t</AxQuerySimpleEmbeddedDataSource>\n\t\t\t\t</DataSources>\n')
      .replace(/\n/g, '\r\n');
    const e = readEntityForStaging(xml)!;
    expect(e.fields.find(f => f.name === 'DefaultDimension')!.isPrivate).toBe(true);
    expect(e.fields.find(f => f.name === 'Summary')).toMatchObject({
      iType: 'AxDataEntityViewUnmappedFieldString', extendedDataType: 'Description', isPrivate: false,
    });
    expect(e.dataSources.get('terms')).toBe('PaymTerm');
    expect(e.dataSources.get('custgroup')).toBe('CustGroup');
    expect(e.keyFields).toEqual(['CustomerGroupId']);
  });

  it('says data management is off when the entity does not enable it, and ignores other documents', () => {
    const off = buildAxDataEntityXml('ContosoCustomerGroupEntity', { primaryTable: 'CustGroup', fields: [{ name: 'CustGroup' }] });
    expect(readEntityForStaging(off)!.dataManagementEnabled).toBe(false);
    expect(readEntityForStaging(off)!.stagingTable).toBeUndefined();
    expect(readEntityForStaging('<AxTable><Name>T</Name></AxTable>')).toBeUndefined();
  });
});
