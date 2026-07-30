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
 * properties.primaryKeyFields      – string[] for a composite/business key; wins over
 *                                     primaryKeyField. Each entry is an entity field name.
 * properties.primaryKey            – NAME of the AxDataEntityViewKey (default: "EntityKey").
 *                                     Alias: properties.entityKeyName. 5713/5899 shipped
 *                                     entities use EntityKey but named keys are legal
 *                                     (CustomerGroupKey, VendorGroupKey, …) and used to be
 *                                     silently discarded — see "Change tracking / key naming".
 * properties.entityCategory        – Master | Transaction | Reference | Document | Parameter
 *                                     (default: Transaction).
 * properties.isPublic              – default TRUE. Set false to emit a non-public entity:
 *                                     <IsPublic>, <PublicCollectionName> and <PublicEntityName>
 *                                     are then all omitted (shipped census: 1316/1329 entities
 *                                     without IsPublic also omit both public names; no shipped
 *                                     entity writes <IsPublic>No</IsPublic> — NoYes defaults
 *                                     are omitted by the platform serializer).
 * properties.allowRowVersionChangeTracking
 *                                  – opt IN to change tracking (dual-write / virtual entities).
 *                                     Emits <AllowRowVersionChangeTracking>Yes</…>. Alias:
 *                                     properties.changeTrackingEnabled — the legacy
 *                                     <ChangeTrackingEnabled> ELEMENT is deliberately never
 *                                     emitted: it is not on the MetaModel.AxDataEntityView type
 *                                     and the deserializer silently drops it (22 shipped files
 *                                     still carry it, all inert). NOTE the cross-object rule:
 *                                     the SOURCE TABLE must set AllowRowVersionChangeTracking=Yes
 *                                     too or the build fails with "Change tracking cannot be
 *                                     enabled since the Allow Row Version Change Tracking
 *                                     property is not set to Yes for the table".
 * properties.dataManagementEnabled – opt IN to data-management/DIXF staging (default: false —
 *                                     see below). When true, properties.dataManagementStagingTable
 *                                     overrides the default `${entityName}Staging` name.
 * properties.standardStructure     – opt IN to the AOT-canonical entity skeleton: <SourceCode>
 *                                     (declaration + methods), the five standard <FieldGroups>,
 *                                     and empty <DeleteActions /> / <StateMachines />. Present in
 *                                     5859/5859 shipped entities but OFF by default so existing
 *                                     callers keep byte-identical output. Implied by passing any
 *                                     of declaration / methods / fieldGroups.
 * properties.declaration           – X++ class declaration block for <SourceCode><Declaration>
 *                                     (default: `public class ${entityName} extends common {}`).
 * properties.methods               – [{ name, source }] → <SourceCode><Methods><Method>.
 *                                     Callers holding raw X++ should split it first
 *                                     (XmlTemplateGenerator.parseSourceForBridge) — this builder
 *                                     deliberately does no X++ parsing.
 * properties.fieldGroups           – [{ name, autoPopulate?, fields?: string[] }] overriding the
 *                                     five standard groups. Pass [] for <FieldGroups />.
 * properties.dynamicFields         – emit <DynamicFields>Yes</DynamicFields> on the root query
 *                                     data source (after <Name>, before <Table>).
 *
 * Without primaryTable + at least one field, this emits an inert skeleton
 * (no query) that can never function as a data entity — callers should
 * always pass both.
 *
 * ELEMENT ORDER IS NOT NEGOTIABLE. The D365FO deserializer silently drops
 * mis-ordered or unknown elements, so a green build proves nothing. The order
 * below was derived empirically from ALL 5899 shipped AxDataEntityView files in
 * PackagesLocalDirectory (reference file:
 * ApplicationSuite/Foundation/AxDataEntityView/AssetConditionEntity.xml) and
 * every pairwise constraint in it holds in all 5899:
 *
 *   Name, SourceCode, Label, AllowRowVersionChangeTracking, DataManagementEnabled,
 *   DataManagementStagingTable, EntityCategory, IsPublic, PrimaryKey,
 *   PublicCollectionName, PublicEntityName, DeleteActions, FieldGroups, Fields,
 *   Keys, Mappings, Ranges, Relations, StateMachines, ViewMetadata
 *
 * (the platform serializer emits base-class properties alphabetically, then
 * AxDataEntityView properties alphabetically, then collections alphabetically —
 * hence AllowRowVersionChangeTracking before DataManagementEnabled, and
 * DeleteActions/FieldGroups before Fields.)
 *
 * DataManagementEnabled defaults to "No" (regression: this used to hard-code
 * "Yes" + DataManagementStagingTable=`${entityName}Staging` unconditionally —
 * every generated entity then failed its very next build with "Table
 * '<Name>Staging' does not exist", since this tool has no path that creates a
 * staging table. Enabling data-management for a real staging scenario is an
 * explicit opt-in via properties.dataManagementEnabled — the caller is then
 * responsible for the staging table existing (create it as its own table).
 */

/** The five field groups every shipped data entity carries (5810/5859). */
const STANDARD_FIELD_GROUPS: Array<{ name: string; autoPopulate?: boolean }> = [
  { name: 'AutoReport' },
  { name: 'AutoLookup' },
  { name: 'AutoIdentification', autoPopulate: true },
  { name: 'AutoSummary' },
  { name: 'AutoBrowse' },
];

/** NoYes-ish inputs: true / "Yes" / "true" / 1 all mean Yes. */
export function isYes(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'yes' || v === 'true' || v === '1';
  }
  return false;
}

function buildFieldGroupsXml(
  groups: Array<{ name: string; autoPopulate?: boolean; fields?: string[] }>,
): string {
  if (groups.length === 0) return '\t<FieldGroups />\n';
  const body = groups
    .map(g => {
      const autoPopulate = isYes(g.autoPopulate) ? '\n\t\t\t<AutoPopulate>Yes</AutoPopulate>' : '';
      const fields =
        Array.isArray(g.fields) && g.fields.length > 0
          ? '\n\t\t\t<Fields>\n' +
            g.fields
              .map(f => `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxTableFieldGroupField>`)
              .join('\n') +
            '\n\t\t\t</Fields>'
          : '\n\t\t\t<Fields />';
      return `\t\t<AxTableFieldGroup>\n\t\t\t<Name>${g.name}</Name>${autoPopulate}${fields}\n\t\t</AxTableFieldGroup>`;
    })
    .join('\n');
  return `\t<FieldGroups>\n${body}\n\t</FieldGroups>\n`;
}

function buildSourceCodeXml(
  entityName: string,
  declaration: string | undefined,
  methods: Array<{ name: string; source?: string }> | undefined,
): string {
  const decl = (declaration && declaration.trim())
    ? declaration.replace(/\s+$/, '')
    : `public class ${entityName} extends common\n{\n}`;
  const methodsXml =
    methods && methods.length > 0
      ? '\t\t<Methods>\n' +
        methods
          .map(
            m =>
              `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${(m.source ?? '').replace(/\s+$/, '')}\n\n]]></Source>\n\t\t\t</Method>`,
          )
          .join('\n') +
        '\n\t\t</Methods>\n'
      : '\t\t<Methods />\n';
  return `\t<SourceCode>\n\t\t<Declaration><![CDATA[\n${decl}\n]]></Declaration>\n${methodsXml}\t</SourceCode>\n`;
}

export function buildAxDataEntityXml(entityName: string, properties?: Record<string, any>): string {
  const label = properties?.label || entityName;
  const publicEntityName = properties?.publicEntityName || entityName;
  const publicCollectionName = properties?.publicCollectionName || `${entityName}Collection`;
  const entityCategory = properties?.entityCategory || 'Transaction';
  const primaryTable: string | undefined = properties?.primaryTable;
  const fields: Array<{ name: string; dataField?: string }> | undefined =
    Array.isArray(properties?.fields) ? properties.fields : undefined;

  // ── Opt-in additions. Every one of these must be absent from the output when
  //    the caller passes none of them, so existing callers stay byte-identical.
  const changeTracking = isYes(
    properties?.allowRowVersionChangeTracking ?? properties?.changeTrackingEnabled,
  );
  const changeTrackingXml = changeTracking
    ? '\t<AllowRowVersionChangeTracking>Yes</AllowRowVersionChangeTracking>\n'
    : '';

  // isPublic defaults to true (the historical hard-coded <IsPublic>Yes</IsPublic>).
  // Only an explicit false turns the entity non-public, and then the two public
  // names go with it — see the census in the header.
  const isPublic = properties?.isPublic === undefined ? true : isYes(properties.isPublic);
  const isPublicXml = isPublic ? '\t<IsPublic>Yes</IsPublic>\n' : '';
  const publicNamesXml = isPublic
    ? `\t<PublicCollectionName>${publicCollectionName}</PublicCollectionName>\n` +
      `\t<PublicEntityName>${publicEntityName}</PublicEntityName>\n`
    : '';

  const declaration: string | undefined =
    typeof properties?.declaration === 'string' ? properties.declaration : undefined;
  const methods: Array<{ name: string; source?: string }> | undefined =
    Array.isArray(properties?.methods) ? properties.methods : undefined;
  const fieldGroups: Array<{ name: string; autoPopulate?: boolean; fields?: string[] }> | undefined =
    Array.isArray(properties?.fieldGroups) ? properties.fieldGroups : undefined;
  const standardStructure =
    properties?.standardStructure === true ||
    declaration !== undefined ||
    methods !== undefined ||
    fieldGroups !== undefined;

  const sourceCodeXml = standardStructure
    ? buildSourceCodeXml(entityName, declaration, methods)
    : '';
  const deleteActionsXml = standardStructure ? '\t<DeleteActions />\n' : '';
  const fieldGroupsXml = standardStructure
    ? buildFieldGroupsXml(fieldGroups ?? STANDARD_FIELD_GROUPS)
    : '';
  const stateMachinesXml = standardStructure ? '\t<StateMachines />\n' : '';

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
${sourceCodeXml}\t<Label>${label}</Label>
${changeTrackingXml}${dataManagementXml}\t<EntityCategory>${entityCategory}</EntityCategory>
${isPublicXml}${publicNamesXml}${deleteActionsXml}${fieldGroupsXml}\t<Fields />
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
${stateMachinesXml}\t<ViewMetadata />
</AxDataEntityView>
`;
  }

  // Entity key: NAME is caller-controllable (used to be hard-coded to "EntityKey"
  // in both <PrimaryKey> and <AxDataEntityViewKey><Name>), and the key may span
  // several fields for a composite business key.
  const keyName: string = properties?.primaryKey || properties?.entityKeyName || 'EntityKey';
  const keyFields: string[] =
    Array.isArray(properties?.primaryKeyFields) && properties.primaryKeyFields.length > 0
      ? properties.primaryKeyFields.map((f: any) => String(f))
      : [properties?.primaryKeyField || fields[0].name];

  const entityFieldsXml = fields.map(f => `\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>${f.name}</Name>
\t\t\t<DataField>${f.dataField || f.name}</DataField>
\t\t\t<DataSource>${primaryTable}</DataSource>
\t\t</AxDataEntityViewField>`).join('\n');

  const keyFieldsXml = keyFields.map(f => `\t\t\t\t<AxDataEntityViewKeyField>
\t\t\t\t\t<DataField>${f}</DataField>
\t\t\t\t</AxDataEntityViewKeyField>`).join('\n');

  const querySourceFieldsXml = fields.map(f => `\t\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t\t<Name>${f.dataField || f.name}</Name>
\t\t\t\t\t\t<Field>${f.dataField || f.name}</Field>
\t\t\t\t\t</AxQuerySimpleDataSourceField>`).join('\n');

  // On the root query data source DynamicFields sits between <Name> and <Table>.
  const dynamicFieldsXml = isYes(properties?.dynamicFields)
    ? '\t\t\t\t<DynamicFields>Yes</DynamicFields>\n'
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
${sourceCodeXml}\t<Label>${label}</Label>
${changeTrackingXml}${dataManagementXml}\t<EntityCategory>${entityCategory}</EntityCategory>
${isPublicXml}\t<PrimaryKey>${keyName}</PrimaryKey>
${publicNamesXml}${deleteActionsXml}${fieldGroupsXml}\t<Fields>
${entityFieldsXml}
\t</Fields>
\t<Keys>
\t\t<AxDataEntityViewKey>
\t\t\t<Name>${keyName}</Name>
\t\t\t<Fields>
${keyFieldsXml}
\t\t\t</Fields>
\t\t</AxDataEntityViewKey>
\t</Keys>
\t<Mappings />
\t<Ranges />
\t<Relations />
${stateMachinesXml}\t<ViewMetadata>
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
${dynamicFieldsXml}\t\t\t\t<Table>${primaryTable}</Table>
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
