/**
 * The staging table of a data entity with data management enabled.
 *
 * An entity with <DataManagementEnabled>Yes</DataManagementEnabled> names a
 * <DataManagementStagingTable>, and the build fails until that table exists.
 * Visual Studio generates it with the entity. This builder writes the same
 * document, in the shape of the shipped CustCustomerGroupEntityStaging:
 *
 *   • a regular table (no <TableType>), TableGroup=Staging, SaveDataPerCompany=No,
 *     DeveloperDocumentation=@DMF:StagingDeveloperDocumentation;
 *   • Label, ConfigurationKey and FormRef copied from the entity;
 *   • the four DMF fields DefinitionGroup, ExecutionId, IsSelected and
 *     TransferStatus, in the ExtensionList field group;
 *   • one field per public entity field, with the same EDT or enum. Key fields
 *     get AllowEdit=No and Mandatory=Yes;
 *   • the alternate-key index StagingIdx on DefinitionGroup, ExecutionId and the
 *     entity's key fields, which is also PrimaryIndex and ReplacementKey;
 *   • the foreign-key relation DataEntity to the entity, on the key fields.
 *
 * Element order follows that file: the deserializer drops what is out of order.
 * Nothing here decides a field's type. The caller resolves each one and leaves
 * out what it cannot resolve (see write/stagingTableProvisioning.ts).
 */

/** The fields every staging table carries, by name. An entity field cannot reuse one. */
export const DMF_STAGING_FIELDS: readonly string[] = ['DefinitionGroup', 'ExecutionId', 'IsSelected', 'TransferStatus'];

/** One entity field as the entity document declares it. */
export interface StagingEntityField {
  name: string;
  /** The i:type, e.g. AxDataEntityViewMappedField or AxDataEntityViewUnmappedFieldString. */
  iType: string;
  dataSource?: string;
  dataField?: string;
  extendedDataType?: string;
  enumType?: string;
  label?: string;
  stringSize?: string;
  /** AccessModifier=Private: not part of the entity's public shape, so not on the staging table. */
  isPrivate: boolean;
}

/** What a staging table needs to know about its entity, read from the entity XML. */
export interface StagingEntityInfo {
  name: string;
  label?: string;
  configurationKey?: string;
  formRef?: string;
  dataManagementEnabled: boolean;
  stagingTable?: string;
  fields: StagingEntityField[];
  /** The fields of the entity's primary key. */
  keyFields: string[];
  /** Query data source name (lower-cased) → the table, view or entity it reads. */
  dataSources: Map<string, string>;
  /** The entity's AutoReport field group. */
  autoReportFields: string[];
}

/** One field of the staging table. Values are XML text, written as given. */
export interface StagingTableField {
  name: string;
  /** The i:type, e.g. AxTableFieldString. */
  fieldType: string;
  extendedDataType?: string;
  enumType?: string;
  label?: string;
  stringSize?: string;
}

export interface StagingTableSpec {
  tableName: string;
  entityName: string;
  label?: string;
  configurationKey?: string;
  formRef?: string;
  /** The entity fields, in entity order. The DMF fields are added here. */
  fields: StagingTableField[];
  /** Entity key fields. Only those present in `fields` reach the index and the relation. */
  keyFields: string[];
  /** AutoReport members. Only those present in `fields` are written. Default: every field. */
  autoReportFields?: string[];
}

function childText(block: string, name: string): string | undefined {
  const value = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block)?.[1];
  return value ? value : undefined;
}

function dataFieldsOf(block: string | undefined): string[] {
  return [...(block ?? '').matchAll(/<DataField>\s*([^<]*?)\s*<\/DataField>/g)].map(m => m[1]).filter(Boolean);
}

/**
 * Read an AxDataEntityView document for what its staging table mirrors.
 * Undefined when the text is not a data entity.
 */
export function readEntityForStaging(entityXml: string): StagingEntityInfo | undefined {
  const xml = entityXml.replace(/\r\n/g, '\n');
  const root = /<AxDataEntityView\b[^>]*>/.exec(xml);
  if (!root) return undefined;
  const name = childText(xml.slice(root.index), 'Name');
  if (!name) return undefined;

  // The indent of the root's children, so a nested <Fields> or <Name> is never read as the entity's own.
  const u = /^([ \t]*)<Name>/m.exec(xml.slice(root.index))?.[1] ?? '\t';
  const section = (tag: string): string =>
    new RegExp(`^${u}<${tag}>\\n([\\s\\S]*?)^${u}</${tag}>`, 'm').exec(xml)?.[1] ?? '';

  // Scalar properties: everything before the first collection, without the X++ source.
  const firstCollection = new RegExp(`^${u}<(?:DeleteActions|FieldGroups|Fields|Keys)[\\s/>]`, 'm').exec(xml);
  const props = xml
    .slice(root.index, firstCollection ? firstCollection.index : xml.length)
    .replace(/<SourceCode>[\s\S]*?<\/SourceCode>/, '');

  const fieldsBlock = section('Fields');
  const fields: StagingEntityField[] = [];
  for (const m of fieldsBlock.matchAll(/<AxDataEntityViewField\b[^>]*?i:type="([^"]+)"[^>]*>([\s\S]*?)<\/AxDataEntityViewField>/g)) {
    const fieldName = childText(m[2], 'Name');
    if (!fieldName) continue;
    fields.push({
      name: fieldName,
      iType: m[1],
      dataSource: childText(m[2], 'DataSource'),
      dataField: childText(m[2], 'DataField'),
      extendedDataType: childText(m[2], 'ExtendedDataType'),
      enumType: childText(m[2], 'EnumType'),
      label: childText(m[2], 'Label'),
      stringSize: childText(m[2], 'StringSize'),
      isPrivate: /^private$/i.test(childText(m[2], 'AccessModifier') ?? ''),
    });
  }

  const keys = [...section('Keys')
    .matchAll(/<AxDataEntityViewKey>([\s\S]*?)<\/AxDataEntityViewKey>/g)].map(m => m[1]);
  const primaryKey = childText(props, 'PrimaryKey');
  const key = keys.find(k => childText(k, 'Name') === primaryKey) ?? keys[0];

  const dataSources = new Map<string, string>();
  const view = xml.slice(Math.max(xml.indexOf('<ViewMetadata'), 0));
  for (const m of view.matchAll(
    /<AxQuerySimple(?:Root|Embedded)DataSource>\s*<Name>([^<]+)<\/Name>(?:(?!<AxQuerySimple)[\s\S])*?<Table>([^<]+)<\/Table>/g,
  )) {
    dataSources.set(m[1].trim().toLowerCase(), m[2].trim());
  }

  const autoReport = /<AxTableFieldGroup>\s*<Name>AutoReport<\/Name>([\s\S]*?)<\/AxTableFieldGroup>/.exec(xml)?.[1];

  return {
    name,
    label: childText(props, 'Label'),
    configurationKey: childText(props, 'ConfigurationKey'),
    formRef: childText(props, 'FormRef'),
    dataManagementEnabled: /^yes$/i.test(childText(props, 'DataManagementEnabled') ?? ''),
    stagingTable: childText(props, 'DataManagementStagingTable'),
    fields,
    keyFields: dataFieldsOf(key),
    dataSources,
    autoReportFields: dataFieldsOf(autoReport),
  };
}

const opt = (indent: string, name: string, value: string | undefined): string =>
  value ? `${indent}<${name}>${value}</${name}>\n` : '';

function fieldXml(f: StagingTableField, locked = false): string {
  const t = '\t\t\t';
  return (
    `\t\t<AxTableField xmlns=""\n${t}i:type="${f.fieldType}">\n` +
    `${t}<Name>${f.name}</Name>\n` +
    (locked ? `${t}<AllowEdit>No</AllowEdit>\n` : '') +
    opt(t, 'ExtendedDataType', f.extendedDataType) +
    `${t}<IsSystemGenerated>Yes</IsSystemGenerated>\n` +
    opt(t, 'Label', f.label) +
    (locked ? `${t}<Mandatory>Yes</Mandatory>\n` : '') +
    opt(t, 'StringSize', f.stringSize) +
    opt(t, 'EnumType', f.enumType) +
    `\t\t</AxTableField>\n`
  );
}

function groupXml(name: string, fields: string[], extra: { autoPopulate?: boolean; label?: string } = {}): string {
  const t = '\t\t\t';
  const members = fields.length
    ? `${t}<Fields>\n` +
      fields.map(f => `${t}\t<AxTableFieldGroupField>\n${t}\t\t<DataField>${f}</DataField>\n${t}\t</AxTableFieldGroupField>\n`).join('') +
      `${t}</Fields>\n`
    : `${t}<Fields />\n`;
  return (
    `\t\t<AxTableFieldGroup>\n${t}<Name>${name}</Name>\n` +
    (extra.autoPopulate ? `${t}<AutoPopulate>Yes</AutoPopulate>\n` : '') +
    `${t}<IsSystemGenerated>Yes</IsSystemGenerated>\n` +
    opt(t, 'Label', extra.label) +
    members +
    `\t\t</AxTableFieldGroup>\n`
  );
}

/** The AxTable document of a staging table. */
export function buildStagingTableXml(spec: StagingTableSpec): string {
  const taken = new Set(DMF_STAGING_FIELDS.map(n => n.toLowerCase()));
  const fields = spec.fields.filter(f => !taken.has(f.name.toLowerCase()));
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f.name]));
  const present = (names: string[]): string[] =>
    [...new Set(names.map(n => byName.get(n.toLowerCase())).filter((n): n is string => !!n))];

  const keyFields = present(spec.keyFields);
  const isKey = new Set(keyFields);
  const autoReport = spec.autoReportFields?.length ? present(spec.autoReportFields) : fields.map(f => f.name);
  const title1 = keyFields[0] ?? fields[0]?.name;
  const title2 = fields.find(f => f.name !== title1)?.name;

  const dmfFields =
    fieldXml({ name: 'DefinitionGroup', fieldType: 'AxTableFieldString', extendedDataType: 'DMFDefinitionGroupName', stringSize: '60' }, true) +
    fieldXml({ name: 'ExecutionId', fieldType: 'AxTableFieldString', extendedDataType: 'DMFExecutionId', stringSize: '90' }, true) +
    fieldXml({ name: 'IsSelected', fieldType: 'AxTableFieldEnum', extendedDataType: 'DMFIsSelected', enumType: 'NoYes' }) +
    fieldXml({ name: 'TransferStatus', fieldType: 'AxTableFieldEnum', enumType: 'DMFTransferStatus' });

  const indexFields = ['DefinitionGroup', 'ExecutionId', ...keyFields]
    .map(f => `\t\t\t\t<AxTableIndexField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxTableIndexField>\n`)
    .join('');

  const constraints = keyFields.length
    ? `\t\t\t<Constraints>\n` +
      keyFields.map(f =>
        `\t\t\t\t<AxTableRelationConstraint xmlns=""\n\t\t\t\t\ti:type="AxTableRelationConstraintField">\n` +
        `\t\t\t\t\t<Name>${f}</Name>\n\t\t\t\t\t<Field>${f}</Field>\n\t\t\t\t\t<RelatedField>${f}</RelatedField>\n` +
        `\t\t\t\t</AxTableRelationConstraint>\n`).join('') +
      `\t\t\t</Constraints>\n`
    : `\t\t\t<Constraints />\n`;

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `\t<Name>${spec.tableName}</Name>\n` +
    `\t<SourceCode>\n\t\t<Declaration><![CDATA[\npublic class ${spec.tableName} extends common\n{\n}\n\n]]></Declaration>\n` +
    `\t\t<Methods />\n\t</SourceCode>\n` +
    opt('\t', 'ConfigurationKey', spec.configurationKey) +
    `\t<DeveloperDocumentation>@DMF:StagingDeveloperDocumentation</DeveloperDocumentation>\n` +
    opt('\t', 'FormRef', spec.formRef) +
    opt('\t', 'Label', spec.label) +
    `\t<TableGroup>Staging</TableGroup>\n` +
    opt('\t', 'TitleField1', title1) +
    opt('\t', 'TitleField2', title2) +
    `\t<PrimaryIndex>StagingIdx</PrimaryIndex>\n` +
    `\t<ReplacementKey>StagingIdx</ReplacementKey>\n` +
    `\t<SaveDataPerCompany>No</SaveDataPerCompany>\n` +
    `\t<DeleteActions />\n` +
    `\t<FieldGroups>\n` +
    groupXml('AutoReport', autoReport) +
    groupXml('AutoLookup', []) +
    groupXml('AutoIdentification', [], { autoPopulate: true }) +
    groupXml('AutoSummary', []) +
    groupXml('AutoBrowse', []) +
    groupXml('ExtensionList', ['DefinitionGroup', 'IsSelected', 'TransferStatus', 'ExecutionId'], { label: '@DMF:StagingExtensionGroup' }) +
    `\t</FieldGroups>\n` +
    `\t<Fields>\n` +
    dmfFields +
    fields.map(f => fieldXml(f, isKey.has(f.name))).join('') +
    `\t</Fields>\n` +
    `\t<FullTextIndexes />\n` +
    `\t<Indexes>\n\t\t<AxTableIndex>\n\t\t\t<Name>StagingIdx</Name>\n\t\t\t<AlternateKey>Yes</AlternateKey>\n` +
    `\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n\t\t\t<Fields>\n${indexFields}\t\t\t</Fields>\n\t\t</AxTableIndex>\n\t</Indexes>\n` +
    `\t<Mappings />\n` +
    `\t<Relations>\n\t\t<AxTableRelation xmlns=""\n\t\t\ti:type="AxTableRelationForeignKey">\n` +
    `\t\t\t<Name>DataEntity</Name>\n\t\t\t<Cardinality>ExactlyOne</Cardinality>\n` +
    `\t\t\t<EntityRelationshipRole>@DMF:StagingToDataEntityRelationshipRole</EntityRelationshipRole>\n` +
    `\t\t\t<IsSystemGenerated>Yes</IsSystemGenerated>\n` +
    `\t\t\t<RelatedTable>${spec.entityName}</RelatedTable>\n` +
    `\t\t\t<RelatedTableCardinality>ZeroOne</RelatedTableCardinality>\n` +
    `\t\t\t<RelationshipType>Link</RelationshipType>\n\t\t\t<Validate>No</Validate>\n` +
    constraints +
    `\t\t</AxTableRelation>\n\t</Relations>\n` +
    `\t<StateMachines />\n` +
    `</AxTable>\n`
  );
}
