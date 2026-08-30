/**
 * Shared builder for AxTable XML.
 *
 * createD365File.ts and generateD365Xml.ts each expose a mirrored
 * XmlTemplateGenerator class; both delegate here so the two cannot drift
 * (mirrors the securityPrivilegeXml.ts / queryViewXml.ts pattern).
 *
 * They had already drifted: the create copy grew canonical property ordering,
 * a real <Fields> block and X++ source handling, while the generate copy kept
 * emitting a bare `<Fields />` and a hand-rolled property block in a different
 * order. Since the documented hybrid flow is generate → create(xmlContent),
 * every table produced that way lost all of its fields — silently, because a
 * table with no fields still builds clean.
 */

import { escapeXml } from '../../utils/xmlEscape.js';
import { axTableFieldElement, baseTypeFromEdtName, normalizeFieldBaseType } from '../../utils/axFieldTypes.js';
import { renderAxTableProperties } from '../../utils/axTablePropertyOrder.js';
import { isYes } from './dataEntityXml.js';

/** Field spec as accepted by the tool surface; every key is optional but `name`. */
export interface AxTableFieldSpec {
  name: string;
  edt?: string;
  type?: string;
  fieldType?: string;
  enumType?: string;
  mandatory?: boolean;
  label?: string;
}

/** X++ source already split by the caller (see XmlTemplateGenerator.parseSourceForBridge). */
export interface ParsedTableSource {
  declaration?: string;
  methods?: Array<{ name: string; source?: string }>;
}

/**
 * Map a D365FO base type name to the XML i:type attribute used in <AxTableField>.
 * If the explicit fieldType is not a known primitive, fall back to name-based heuristics
 * using edtName (same heuristics as SmartXmlBuilder.getAxTableFieldType).
 */
export function fieldTypeToAxType(fieldType: string, edtName?: string): string {
  const explicit = normalizeFieldBaseType(fieldType);
  if (explicit) return axTableFieldElement(explicit);

  // Fall back to EDT name heuristics — the same ones every other caller uses.
  const heuristic = baseTypeFromEdtName(edtName || fieldType);
  return heuristic ? axTableFieldElement(heuristic) : 'AxTableFieldString';
}

/** Field-group spec as accepted by the tool surface (same shape as the table-extension path). */
export interface AxTableFieldGroupSpec {
  name: string;
  label?: string;
  fields?: string[];
}

/**
 * The five groups every AxTable carries. They are not optional — the metadata
 * layer expects them by name — so caller groups are APPENDED to these rather
 * than replacing them.
 */
const AUTO_FIELD_GROUPS: ReadonlyArray<{ name: string; autoPopulate?: boolean }> = [
  { name: 'AutoReport' },
  { name: 'AutoLookup' },
  { name: 'AutoIdentification', autoPopulate: true },
  { name: 'AutoSummary' },
  { name: 'AutoBrowse' },
];

/**
 * Render <FieldGroups>: the five Auto* groups, then whatever the caller asked for.
 *
 * This block used to be a hardcoded literal, so `properties.fieldGroups` on a
 * table create was DROPPED — silently, because a table with no groups of its own
 * still builds clean. It stops being silent one step later and in the wrong
 * place: the SimpleList form template emits `<DataGroup>Overview</DataGroup>`
 * for its grid, and the build then fails with "Field group 'Overview' does not
 * exist" on the FORM, pointing away from the table that actually lost it.
 * Found by capturing L3-form-event-handler-class on the VM.
 */
export function buildAxTableFieldGroupsXml(groupSpecs: AxTableFieldGroupSpec[]): string {
  let xml = '\t<FieldGroups>\n';
  for (const g of AUTO_FIELD_GROUPS) {
    xml += `\t\t<AxTableFieldGroup>\n\t\t\t<Name>${g.name}</Name>\n`;
    if (g.autoPopulate) xml += '\t\t\t<AutoPopulate>Yes</AutoPopulate>\n';
    xml += '\t\t\t<Fields />\n\t\t</AxTableFieldGroup>\n';
  }
  for (const g of groupSpecs) {
    if (!g?.name) continue;
    // A caller group named like an Auto* one would be a duplicate the metadata
    // layer rejects; the five above already carry those names.
    if (AUTO_FIELD_GROUPS.some(a => a.name.toLowerCase() === g.name.toLowerCase())) continue;
    xml += `\t\t<AxTableFieldGroup>\n\t\t\t<Name>${escapeXml(g.name)}</Name>\n`;
    if (g.label) xml += `\t\t\t<Label>${escapeXml(g.label)}</Label>\n`;
    const fields = Array.isArray(g.fields) ? g.fields : [];
    if (fields.length === 0) {
      xml += '\t\t\t<Fields />\n';
    } else {
      xml += '\t\t\t<Fields>\n';
      for (const df of fields) {
        xml += `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${escapeXml(df)}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`;
      }
      xml += '\t\t\t</Fields>\n';
    }
    xml += '\t\t</AxTableFieldGroup>\n';
  }
  return `${xml}\t</FieldGroups>`;
}

/** Index spec as accepted by the tool surface (same shape as the table-extension path). */
export interface AxTableIndexSpec {
  name: string;
  fields: Array<{ fieldName?: string; name?: string; dataField?: string; direction?: string } | string>;
  allowDuplicates?: boolean;
  alternateKey?: boolean;
}

/**
 * Render <Indexes> from the caller's index specs.
 *
 * Lifted out of the table-EXTENSION builder so the two cannot drift, and
 * because the plain table builder emitted a hardcoded `<Indexes />`, dropping
 * every index the caller passed. `createTablePropertyHonesty` caught the loss and
 * offered `add-index` as the repair — but that operation needs the C# bridge, so
 * on the template path there was no way to get an index at all.
 *
 * `<Relations />` is still a literal, and stays reported by that same check.
 */
export function buildAxTableIndexesXml(indexSpecs: AxTableIndexSpec[]): string {
  if (indexSpecs.length === 0) return '\t<Indexes />';

  let xml = '\t<Indexes>\n';
  for (const idx of indexSpecs) {
    if (!idx?.name) continue;
    xml += `\t\t<AxTableIndex>\n\t\t\t<Name>${escapeXml(idx.name)}</Name>\n`;
    if (idx.allowDuplicates !== undefined) {
      xml += `\t\t\t<AllowDuplicates>${idx.allowDuplicates ? 'Yes' : 'No'}</AllowDuplicates>\n`;
    }
    if (idx.alternateKey) xml += '\t\t\t<AlternateKey>Yes</AlternateKey>\n';
    // `fields: ["AccountNum"]` is the documented shape everywhere else — the
    // bridge normalizer accepts it and so does add-index. Reading only
    // `fieldName` turned the string form into a literal
    // <DataField>undefined</DataField>: it deserializes, and the index points
    // at nothing.
    const fields = (Array.isArray(idx.fields) ? idx.fields : [])
      .map((f): { fieldName?: string; direction?: string } => (typeof f === 'string'
        ? { fieldName: f }
        : { fieldName: f?.fieldName ?? f?.name ?? f?.dataField, direction: f?.direction }))
      .filter((f): f is { fieldName: string; direction?: string } =>
        typeof f.fieldName === 'string' && f.fieldName.length > 0);

    if (fields.length === 0) {
      xml += '\t\t\t<Fields />\n';
    } else {
      xml += '\t\t\t<Fields>\n';
      for (const f of fields) {
        xml += `\t\t\t\t<AxTableIndexField>\n\t\t\t\t\t<DataField>${escapeXml(f.fieldName)}</DataField>\n`;
        if (f.direction) xml += `\t\t\t\t\t<Direction>${escapeXml(f.direction)}</Direction>\n`;
        xml += '\t\t\t\t</AxTableIndexField>\n';
      }
      xml += '\t\t\t</Fields>\n';
    }
    xml += '\t\t</AxTableIndex>\n';
  }
  return `${xml}\t</Indexes>`;
}

/** Render the <Fields> block from the caller's field specs. */
export function buildAxTableFieldsXml(fieldSpecs: AxTableFieldSpec[]): string {
  if (fieldSpecs.length === 0) return '\t<Fields />\n';

  let xml = '\t<Fields>\n';
  for (const f of fieldSpecs) {
    // Determine i:type: explicit AxTableField* wins; otherwise derive from the
    // primitive type / enumType / EDT name heuristics. NEVER default to
    // AxTableFieldString blindly when an EDT or enumType is present.
    const iType = f.fieldType
      ?? fieldTypeToAxType(f.type || (f.enumType ? 'Enum' : 'String'), f.edt);
    xml += `\t\t<AxTableField xmlns=""\n\t\t\ti:type="${iType}">\n`;
    xml += `\t\t\t<Name>${f.name}</Name>\n`;
    if (f.edt)       xml += `\t\t\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
    if (f.label)     xml += `\t\t\t<Label>${escapeXml(f.label)}</Label>\n`;
    if (f.mandatory) xml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
    if (f.enumType)  xml += `\t\t\t<EnumType>${f.enumType}</EnumType>\n`;
    xml += `\t\t</AxTableField>\n`;
  }
  return xml + '\t</Fields>\n';
}

/**
 * Build a complete AxTable document.
 *
 * `parsedSource` is supplied pre-split by the caller rather than parsed here:
 * the splitter lives on XmlTemplateGenerator and pulling it down would drag the
 * whole create tool in behind it. Callers with no X++ simply omit it.
 */
export function buildAxTableXml(
  tableName: string,
  properties?: Record<string, any>,
  parsedSource?: ParsedTableSource,
): string {
  const primaryIndex = properties?.primaryIndex || '';

  // Property block, emitted in CANONICAL ORDER. AxTable XML is order-sensitive
  // and a misordered property is dropped without a word — see
  // src/utils/axTablePropertyOrder.ts and findings #13. Empty values are omitted
  // rather than written as <TitleField1></TitleField1>, matching the shipped
  // tables and the VM-captured golden eval/goldens/L1-table-basic.
  const propertiesXml = renderAxTableProperties({
    ConfigurationKey: properties?.configurationKey,
    DeveloperDocumentation: properties?.developerDocumentation,
    FormRef: properties?.formRef,
    Label: properties?.label || tableName,
    TableGroup: properties?.tableGroup || 'Main',
    TitleField1: properties?.titleField1,
    TitleField2: properties?.titleField2,
    // Dual-write's table-side prerequisite; without it the entity syncs once
    // and then stops seeing changes.
    AllowRowVersionChangeTracking:
      isYes(properties?.allowRowVersionChangeTracking) ? 'Yes' : undefined,
    CacheLookup: properties?.cacheLookup,
    // Audit system fields — NoYes, ranked but previously unreachable.
    CreatedBy: isYes(properties?.createdBy) ? 'Yes' : undefined,
    CreatedDateTime: isYes(properties?.createdDateTime) ? 'Yes' : undefined,
    CreatedTransactionId: isYes(properties?.createdTransactionId) ? 'Yes' : undefined,
    ModifiedBy: isYes(properties?.modifiedBy) ? 'Yes' : undefined,
    ModifiedDateTime: isYes(properties?.modifiedDateTime) ? 'Yes' : undefined,
    ModifiedTransactionId: isYes(properties?.modifiedTransactionId) ? 'Yes' : undefined,
    ClusteredIndex: properties?.clusteredIndex,
    PrimaryIndex: primaryIndex,
    // ReplacementKey mirrors PrimaryIndex unless the caller says otherwise.
    ReplacementKey: properties?.replacementKey || primaryIndex,
    SaveDataPerCompany: properties?.saveDataPerCompany,
    SupportInheritance: properties?.supportInheritance,
    // TableType: TempDB / InMemory; omitted for Regular, which is the default.
    TableType: properties?.tableType,
  });

  // Build <Fields> block from properties.fields array.
  // Copilot may pass field definitions via properties.fields or via sourceCode JSON —
  // both paths merge into properties before calling here.
  // Field-spec keys are unified with the table-extension path: accept an explicit
  // AxTableField* i:type (fieldType), a primitive base type (type), or infer
  // AxTableFieldEnum from enumType — and always emit <EnumType> for enum fields.
  const fieldsXml = buildAxTableFieldsXml(
    Array.isArray(properties?.fields) ? properties.fields : [],
  );

  // Caller-defined field groups, appended to the five Auto* ones.
  const fieldGroupsXml = buildAxTableFieldGroupsXml(
    Array.isArray(properties?.fieldGroups) ? properties.fieldGroups : [],
  );

  const indexesXml = buildAxTableIndexesXml(
    Array.isArray(properties?.indexes) ? properties.indexes : [],
  );

  // X++ passed in `sourceCode` used to be discarded outright: the caller got a ✅
  // and an empty <Methods /> on disk, discoverable only by reading the file back
  // (findings #19). Table source is class-shaped (`public class X extends common`
  // + methods), so the class splitter handles it; when the caller passed only
  // method bodies the splitter still returns them as methods.
  const declarationXpp =
    parsedSource?.declaration?.trim()
    && /\bclass\s+\w+/.test(parsedSource.declaration)
      ? parsedSource.declaration.trim()
      : `public class ${tableName} extends common\n{\n}`;
  const methodsFromSource = parsedSource?.methods ?? [];
  const methodsXml = methodsFromSource.length === 0
    ? '\t\t<Methods />'
    : `\t\t<Methods>\n${methodsFromSource
        .map(m =>
          `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n` +
          `\t\t\t\t<Source><![CDATA[\n${m.source ?? ''}\n\n]]></Source>\n\t\t\t</Method>`)
        .join('\n')}\n\t\t</Methods>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${tableName}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
${declarationXpp}
]]></Declaration>
${methodsXml}
\t</SourceCode>
${propertiesXml}\t<DeleteActions />
${fieldGroupsXml}
${fieldsXml}\t<FullTextIndexes />
${indexesXml}
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>
`;
}
