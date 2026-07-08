/**
 * Shared builders for AxQuery and AxView XML.
 *
 * createD365File.ts and generateD365Xml.ts each expose a mirrored
 * XmlTemplateGenerator class; both delegate here so the two cannot drift
 * (mirrors the securityPrivilegeXml.ts / dataEntityXml.ts pattern).
 *
 * A query's `dataSource` (table) and a view's `query` (the AxQuery it's
 * built on) are required for the object to actually function — without them
 * this emits a structurally valid but inert skeleton.
 *
 * A view references an external AxQuery by name (<Query>QueryName</Query>)
 * and its own <Fields> are AxViewFieldBound entries pointing at that query's
 * datasource alias; it does not embed its own ViewMetadata/DataSources.
 */

/**
 * properties.dataSource — REQUIRED for a functional query: the root table.
 * `table` is accepted as an alias (regression: eval/corpus/runs/
 * 2026-07-06T18__L1-query-view-basic__cb1b73d.json — `query` had NO entry in
 * the d365fo_file properties documentation, so a caller reasonably guessed
 * `table` mirroring data-entity's `primaryTable` convention, and the root
 * datasource was silently never created).
 */
export function buildAxQueryXml(queryName: string, properties?: Record<string, any>): string {
  const title = properties?.title || properties?.label || queryName;
  const dataSource: string | undefined = properties?.dataSource || properties?.table;
  const dataSourceName: string = properties?.dataSourceName || dataSource || '';
  const fields: Array<{ name: string; field?: string }> | undefined =
    Array.isArray(properties?.fields) ? properties.fields : undefined;

  const classDeclaration = `\t<SourceCode>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Query]
public class ${queryName} extends QueryRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>`;

  if (!dataSource) {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="AxQuerySimple">
\t<Name>${queryName}</Name>
${classDeclaration}
\t<Title>${title}</Title>
\t<DataSources />
</AxQuery>
`;
  }

  const fieldsXml = fields?.length
    ? fields.map(f => `\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t<Name>${f.field || f.name}</Name>
\t\t\t\t<Field>${f.field || f.name}</Field>
\t\t\t</AxQuerySimpleDataSourceField>`).join('\n')
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="AxQuerySimple">
\t<Name>${queryName}</Name>
${classDeclaration}
\t<Title>${title}</Title>
\t<DataSources>
\t\t<AxQuerySimpleRootDataSource>
\t\t\t<Name>${dataSourceName}</Name>
\t\t\t<Table>${dataSource}</Table>
\t\t\t<DataSources />
\t\t\t<DerivedDataSources />
\t\t\t<Fields>
${fieldsXml}
\t\t\t</Fields>
\t\t\t<Ranges />
\t\t\t<GroupBy />
\t\t\t<Having />
\t\t\t<OrderBy />
\t\t</AxQuerySimpleRootDataSource>
\t</DataSources>
</AxQuery>
`;
}

/**
 * properties.query      — name of an existing AxQuery this view is built on.
 * properties.dataSource  — that query's root datasource NAME (defaults to
 *                           properties.query — matches the common convention
 *                           of naming a simple query's root datasource after
 *                           its table, and matching buildAxQueryXml's default
 *                           dataSourceName when the caller didn't override it).
 * properties.fields      — [{ name, dataField? }] → one AxViewFieldBound per
 *                           entry, dataField defaults to name.
 */
export function buildAxViewXml(viewName: string, properties?: Record<string, any>): string {
  const label = properties?.label || viewName;
  const query: string | undefined = properties?.query;
  const dataSource: string = properties?.dataSource || query || '';
  const fields: Array<{ name: string; dataField?: string }> | undefined =
    Array.isArray(properties?.fields) ? properties.fields : undefined;

  if (!query || !fields || fields.length === 0) {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${viewName}</Name>
\t<Label>${label}</Label>
\t<Fields />
\t<Mappings />
\t<ViewMetadata />
</AxView>
`;
  }

  const fieldsXml = fields.map(f => `\t\t<AxViewField xmlns=""
\t\t\ti:type="AxViewFieldBound">
\t\t\t<Name>${f.name}</Name>
\t\t\t<DataField>${f.dataField || f.name}</DataField>
\t\t\t<DataSource>${dataSource}</DataSource>
\t\t</AxViewField>`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${viewName}</Name>
\t<Label>${label}</Label>
\t<Query>${query}</Query>
\t<Fields>
${fieldsXml}
\t</Fields>
\t<Mappings />
\t<ViewMetadata />
</AxView>
`;
}
