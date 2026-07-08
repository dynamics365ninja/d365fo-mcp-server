/**
 * Shared builder for AxDataEntityView XML.
 *
 * createD365File.ts and generateD365Xml.ts each expose a mirrored
 * XmlTemplateGenerator class; both delegate here so the two cannot drift.
 *
 * properties.primaryTable          – REQUIRED for a functional entity: the root table.
 * properties.fields                – [{ name, dataField? }] one AxDataEntityViewMappedField
 *                                     + one query datasource field per entry, both sourced
 *                                     from primaryTable. dataField defaults to name.
 * properties.primaryKeyField       – field `name` to use as the entity key (default: fields[0].name).
 * properties.entityCategory        – Master | Transaction | Reference | Document | Parameter
 *                                     (default: Transaction).
 * properties.dataManagementEnabled – opt IN to data-management/DIXF staging (default: false —
 *                                     see below). When true, properties.dataManagementStagingTable
 *                                     overrides the default `${entityName}Staging` name.
 *
 * Without primaryTable + at least one field, this emits an inert skeleton
 * (no query) that can never function as a data entity — callers should
 * always pass both.
 *
 * DataManagementEnabled defaults to "No" (regression: this used to hard-code
 * "Yes" + DataManagementStagingTable=`${entityName}Staging` unconditionally —
 * every generated entity then failed its very next build with "Table
 * '<Name>Staging' does not exist", since this tool has no path that creates a
 * staging table. Enabling data-management for a real staging scenario is an
 * explicit opt-in via properties.dataManagementEnabled — the caller is then
 * responsible for the staging table existing (create it as its own table).
 */
export function buildAxDataEntityXml(entityName: string, properties?: Record<string, any>): string {
  const label = properties?.label || entityName;
  const publicEntityName = properties?.publicEntityName || entityName;
  const publicCollectionName = properties?.publicCollectionName || `${entityName}Collection`;
  const entityCategory = properties?.entityCategory || 'Transaction';
  const primaryTable: string | undefined = properties?.primaryTable;
  const fields: Array<{ name: string; dataField?: string }> | undefined =
    Array.isArray(properties?.fields) ? properties.fields : undefined;
  const dataManagementEnabled = properties?.dataManagementEnabled === true;
  const dataManagementXml = dataManagementEnabled
    ? `\t<DataManagementEnabled>Yes</DataManagementEnabled>\n` +
      `\t<DataManagementStagingTable>${properties?.dataManagementStagingTable || `${entityName}Staging`}</DataManagementStagingTable>\n`
    : `\t<DataManagementEnabled>No</DataManagementEnabled>\n` +
      `\t<DataManagementStagingTable />\n`;

  if (!primaryTable || !fields || fields.length === 0) {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
${dataManagementXml}\t<EntityCategory>${entityCategory}</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PublicCollectionName>${publicCollectionName}</PublicCollectionName>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<Fields />
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata />
</AxDataEntityView>
`;
  }

  const keyFieldName = properties?.primaryKeyField || fields[0].name;

  const entityFieldsXml = fields.map(f => `\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>${f.name}</Name>
\t\t\t<DataField>${f.dataField || f.name}</DataField>
\t\t\t<DataSource>${primaryTable}</DataSource>
\t\t</AxDataEntityViewField>`).join('\n');

  const querySourceFieldsXml = fields.map(f => `\t\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t\t<Name>${f.dataField || f.name}</Name>
\t\t\t\t\t\t<Field>${f.dataField || f.name}</Field>
\t\t\t\t\t</AxQuerySimpleDataSourceField>`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
${dataManagementXml}\t<EntityCategory>${entityCategory}</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PrimaryKey>EntityKey</PrimaryKey>
\t<PublicCollectionName>${publicCollectionName}</PublicCollectionName>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<Fields>
${entityFieldsXml}
\t</Fields>
\t<Keys>
\t\t<AxDataEntityViewKey>
\t\t\t<Name>EntityKey</Name>
\t\t\t<Fields>
\t\t\t\t<AxDataEntityViewKeyField>
\t\t\t\t\t<DataField>${keyFieldName}</DataField>
\t\t\t\t</AxDataEntityViewKeyField>
\t\t\t</Fields>
\t\t</AxDataEntityViewKey>
\t</Keys>
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<SourceCode>
\t\t\t<Methods>
\t\t\t\t<Method>
\t\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t\t<Source><![CDATA[
[Query]
public class Metadata extends QueryRun
{
}
]]></Source>
\t\t\t\t</Method>
\t\t\t</Methods>
\t\t</SourceCode>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>${primaryTable}</Name>
\t\t\t\t<Table>${primaryTable}</Table>
\t\t\t\t<DataSources />
\t\t\t\t<DerivedDataSources />
\t\t\t\t<Fields>
${querySourceFieldsXml}
\t\t\t\t</Fields>
\t\t\t\t<Ranges />
\t\t\t\t<GroupBy />
\t\t\t\t<Having />
\t\t\t\t<OrderBy />
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxDataEntityView>
`;
}
