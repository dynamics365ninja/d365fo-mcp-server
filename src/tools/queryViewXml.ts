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

  // A data source with NO explicit field list only compiles when it is marked
  // dynamic. xppc rejects the "all fields" shape with "The field list of the data
  // source 'X' cannot be empty if the dynamic field is set to false", so every
  // fieldless query this builder produced failed the build
  // (docs/eval-sweep-findings-2026-07-21.md #20). `properties.dynamicFields` lets a
  // caller force it either way; otherwise it follows "no explicit fields ⇒ dynamic".
  //
  // Position: between <Name> and <Table>, which is where every platform query puts
  // it (ApplicationPlatform/AxQuery/BatchDelete.xml, ApplicationSuite/…/
  // ActivityListOpenTasks.xml — 13/13 of the platform queries that set it) and where
  // the captured golden eval/goldens/L3-workflow-document-submit/
  // ConDemoWfRequestQuery.metadata.xml has it. The DataContract order is
  // Name → DynamicFields → Table → DataSources → DerivedDataSources → Fields → …
  //
  // AOT XML silently DROPS misordered elements: emitted after <DerivedDataSources>
  // the flag was read back as FALSE, and the full build then failed with "The field
  // list of the data source 'X' cannot be empty if the dynamic field is set to
  // false" — the very error the flag exists to avoid. An INCREMENTAL build accepts
  // the file, so only a fullBuild caught it (L3-xds-policy-constrained-table run).
  const explicitDynamic: boolean | undefined =
    typeof properties?.dynamicFields === 'boolean'
      ? properties.dynamicFields
      : typeof properties?.dynamicFields === 'string'
        ? /^(yes|true)$/i.test(properties.dynamicFields)
        : undefined;
  const dynamicFields = explicitDynamic ?? !fields?.length;
  const dynamicFieldsXml = dynamicFields ? '\t\t\t<DynamicFields>Yes</DynamicFields>\n' : '';

  const fieldsXml = fields?.length
    ? `\t\t\t<Fields>\n${fields.map(f => `\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t<Name>${f.field || f.name}</Name>
\t\t\t\t\t<Field>${f.field || f.name}</Field>
\t\t\t\t</AxQuerySimpleDataSourceField>`).join('\n')}\n\t\t\t</Fields>\n`
    : '\t\t\t<Fields />\n';

  return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="AxQuerySimple">
\t<Name>${queryName}</Name>
${classDeclaration}
\t<Title>${title}</Title>
\t<DataSources>
\t\t<AxQuerySimpleRootDataSource>
\t\t\t<Name>${dataSourceName}</Name>
${dynamicFieldsXml}\t\t\t<Table>${dataSource}</Table>
\t\t\t<DataSources />
\t\t\t<DerivedDataSources />
${fieldsXml}\t\t\t<Ranges />
\t\t\t<GroupBy />
\t\t\t<Having />
\t\t\t<OrderBy />
\t\t</AxQuerySimpleRootDataSource>
\t</DataSources>
</AxQuery>
`;
}

/**
 * Extract the root data source NAME from an AxQuery document.
 *
 * A view's `<DataSource>` must name the query's root data source — NOT the query
 * itself. Exported so the create path can resolve it from the query file on disk.
 */
export function extractQueryRootDataSourceName(queryXml: string): string | undefined {
  const root = queryXml.match(
    /<AxQuerySimpleRootDataSource>[\s\S]*?<Name>([^<]+)<\/Name>/,
  )?.[1]?.trim();
  return root ? root : undefined;
}

/**
 * properties.query               — name of an existing AxQuery this view is built on.
 * properties.dataSource          — that query's root datasource NAME.
 * properties.queryRootDataSource — same thing, resolved by the caller from the
 *                                   query on disk (see extractQueryRootDataSourceName).
 * properties.queryXml            — the referenced query's raw XML; the root
 *                                   datasource name is read out of it.
 * properties.fields              — [{ name, dataField? }] → one AxViewFieldBound
 *                                   per entry, dataField defaults to name.
 *
 * Resolution order is deliberate: an explicit `dataSource` wins, then a resolved
 * root name, then the referenced query's own XML. Only as a LAST resort does it
 * fall back to the query name — which is what it used to do unconditionally, and
 * which is essentially always wrong: buildAxQueryXml names a simple query's root
 * datasource after its TABLE, so a view generated from a `…Query` object bound its
 * fields to a datasource that does not exist
 * (docs/eval-sweep-findings-2026-07-21.md #38; ground truth in
 * eval/goldens/L1-query-view-basic, where the view's DataSource is
 * `ConDemoNoteHeader`, not `ConDemoNoteHeaderQuery`).
 */
export function buildAxViewXml(viewName: string, properties?: Record<string, any>): string {
  const label = properties?.label || viewName;
  const query: string | undefined = properties?.query;
  const dataSource: string =
    properties?.dataSource
    || properties?.queryRootDataSource
    || (typeof properties?.queryXml === 'string'
      ? extractQueryRootDataSourceName(properties.queryXml)
      : undefined)
    || query
    || '';
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
