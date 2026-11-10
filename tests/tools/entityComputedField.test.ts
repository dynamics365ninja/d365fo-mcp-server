/**
 * modify-field computedFieldMethod: a data entity's mapped field becomes a computed field.
 * Shape pinned against shipped entities (PurchPurchaseAgreementConfirmationHeaderEntity,
 * HcmBIEmployedApplicantEntity): i:type AxDataEntityViewUnmappedField<Type>, then
 * ComputedFieldMethod, ExtendedDataType, EnumType where DataField/DataSource were.
 */
import { describe, it, expect } from 'vitest';
import {
  convertEntityFieldToComputed, entityMappedFieldBinding, tableFieldComputedType, returnFieldMethodSource,
} from '../../src/tools/xml/entityComputedField.js';

const ENTITY = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ShopExportLineEntity</Name>
	<SourceCode>
		<Declaration><![CDATA[
public class ShopExportLineEntity extends common
{
}
]]></Declaration>
		<Methods />
	</SourceCode>
	<Fields>
		<AxDataEntityViewField xmlns=""
			i:type="AxDataEntityViewMappedField">
			<Name>ExportId</Name>
			<DataField>ExportId</DataField>
			<DataSource>ShopExportLine</DataSource>
		</AxDataEntityViewField>
		<AxDataEntityViewField xmlns=""
			i:type="AxDataEntityViewMappedField">
			<Name>ExportedDateTime</Name>
			<Label>@Shop:ExportedDateTime</Label>
			<DataField>CreatedDateTime</DataField>
			<DataSource>ShopExportLine</DataSource>
		</AxDataEntityViewField>
		<AxDataEntityViewField xmlns=""
			i:type="AxDataEntityViewMappedField">
			<Name>Status</Name>
			<AllowEdit>No</AllowEdit>
			<Mandatory>No</Mandatory>
			<DataField>Status</DataField>
			<DataSource>ShopExportLine</DataSource>
		</AxDataEntityViewField>
	</Fields>
	<Keys>
		<AxDataEntityViewKey>
			<Name>EntityKey</Name>
			<Fields>
				<AxDataEntityViewKeyField>
					<DataField>ExportId</DataField>
				</AxDataEntityViewKeyField>
			</Fields>
		</AxDataEntityViewKey>
	</Keys>
	<ViewMetadata>
		<Name>Metadata</Name>
		<SourceCode>
			<Methods>
				<Method>
					<Name>classDeclaration</Name>
					<Source><![CDATA[
[Query]
public class Metadata extends QueryRun
{
}
]]></Source>
				</Method>
			</Methods>
		</SourceCode>
		<DataSources>
			<AxQuerySimpleRootDataSource>
				<Name>ShopExportLine</Name>
				<DynamicFields>Yes</DynamicFields>
				<Table>ShopExportLineTable</Table>
				<DataSources />
			</AxQuerySimpleRootDataSource>
		</DataSources>
	</ViewMetadata>
</AxDataEntityView>
`;

const TABLE = `<AxTable><Fields>
		<AxTableField xmlns=""
			i:type="AxTableFieldEnum">
			<Name>Status</Name>
			<ExtendedDataType>ShopExportStatusId</ExtendedDataType>
			<EnumType>ShopExportStatus</EnumType>
		</AxTableField>
		<AxTableField xmlns=""
			i:type="AxTableFieldGUID">
			<Name>Token</Name>
		</AxTableField>
</Fields></AxTable>`;

describe('entityMappedFieldBinding', () => {
  it('reads the binding and the datasource table', () => {
    expect(entityMappedFieldBinding(ENTITY, 'ExportedDateTime')).toEqual({
      dataField: 'CreatedDateTime', dataSource: 'ShopExportLine', table: 'ShopExportLineTable',
    });
  });
  it('explains an unknown field', () => {
    expect(entityMappedFieldBinding(ENTITY, 'Nope')).toEqual({ error: expect.stringMatching(/no field 'Nope'/) });
  });
});

describe('tableFieldComputedType', () => {
  it('knows the system fields without the table XML', () => {
    expect(tableFieldComputedType(null, 'CreatedDateTime')).toEqual({ baseType: 'UtcDateTime', edt: 'CreatedDateTime' });
  });
  it('reads type, EDT and enum from the table XML', () => {
    expect(tableFieldComputedType(TABLE, 'Status')).toEqual({ baseType: 'Enum', edt: 'ShopExportStatusId', enumType: 'ShopExportStatus' });
    expect(tableFieldComputedType(TABLE, 'Token')).toEqual({ baseType: 'Guid' });
  });
  it('is undefined for an unknown field', () => {
    expect(tableFieldComputedType(TABLE, 'Nope')).toBeUndefined();
  });
});

describe('convertEntityFieldToComputed', () => {
  it('rewrites the mapped field in the shipped shape and touches nothing else', () => {
    const r = convertEntityFieldToComputed(ENTITY, 'ExportedDateTime', 'exportedDateTimeDefinition',
      { baseType: 'UtcDateTime', edt: 'CreatedDateTime' });
    expect(r.ok).toBe(true);
    const xml = (r as { xml: string }).xml;
    expect(xml).toContain(
      '\t\t<AxDataEntityViewField xmlns=""\n\t\t\ti:type="AxDataEntityViewUnmappedFieldUtcDateTime">\n' +
      '\t\t\t<Name>ExportedDateTime</Name>\n\t\t\t<Label>@Shop:ExportedDateTime</Label>\n' +
      '\t\t\t<ComputedFieldMethod>exportedDateTimeDefinition</ComputedFieldMethod>\n' +
      '\t\t\t<ExtendedDataType>CreatedDateTime</ExtendedDataType>\n\t\t</AxDataEntityViewField>',
    );
    // Only that field changed.
    expect(xml.replace(/<AxDataEntityViewField[\s\S]*?<\/AxDataEntityViewField>/g, ''))
      .toBe(ENTITY.replace(/<AxDataEntityViewField[\s\S]*?<\/AxDataEntityViewField>/g, ''));
    expect(xml.match(/AxDataEntityViewMappedField/g)).toHaveLength(2);
  });

  it('keeps AllowEdit/Mandatory before ComputedFieldMethod and writes EnumType last', () => {
    const r = convertEntityFieldToComputed(ENTITY, 'Status', 'statusDefinition',
      { baseType: 'Enum', edt: 'ShopExportStatusId', enumType: 'ShopExportStatus' });
    expect((r as { xml: string }).xml).toContain(
      '<Name>Status</Name>\n\t\t\t<AllowEdit>No</AllowEdit>\n\t\t\t<Mandatory>No</Mandatory>\n' +
      '\t\t\t<ComputedFieldMethod>statusDefinition</ComputedFieldMethod>\n' +
      '\t\t\t<ExtendedDataType>ShopExportStatusId</ExtendedDataType>\n\t\t\t<EnumType>ShopExportStatus</EnumType>\n',
    );
  });

  it('refuses a key field, an unknown field and a field that is already computed', () => {
    expect(convertEntityFieldToComputed(ENTITY, 'ExportId', 'm', { baseType: 'String' })).toMatchObject({ ok: false, message: expect.stringMatching(/entity key/) });
    expect(convertEntityFieldToComputed(ENTITY, 'Nope', 'm', { baseType: 'String' })).toMatchObject({ ok: false });
    const once = (convertEntityFieldToComputed(ENTITY, 'ExportedDateTime', 'm', { baseType: 'UtcDateTime' }) as { xml: string }).xml;
    expect(convertEntityFieldToComputed(once, 'ExportedDateTime', 'm', { baseType: 'UtcDateTime' }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/not a mapped field/) });
  });
});

describe('returnFieldMethodSource', () => {
  it('builds the SysComputedColumn::returnField method', () => {
    const src = returnFieldMethodSource('ShopExportLineEntity', 'exportedDateTimeDefinition', 'ExportedDateTime',
      { dataField: 'CreatedDateTime', dataSource: 'ShopExportLine', table: 'ShopExportLineTable' });
    expect(src).toContain('private static str exportedDateTimeDefinition()');
    expect(src).toContain('tableStr(ShopExportLineEntity),');
    expect(src).toContain('identifierStr(ShopExportLine),');
    expect(src).toContain('fieldStr(ShopExportLineTable, CreatedDateTime));');
  });
});
