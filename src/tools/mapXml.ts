/**
 * Shared builder for AxMap XML.
 *
 * `map` was not a supported create objectType at all before this (not in the
 * zod enum, no template in either XmlTemplateGenerator copy) — a genuine
 * capability gap rather than a silent-drop bug, found while building the eval
 * Phase 6 map breadth case. Routed through the TypeScript fallback (never
 * added to BRIDGE_CREATE_TYPES) from day one, so it can't inherit the
 * bridge's silent-property-drop behavior seen on query/view/data-entity.
 *
 * Structure verified against a real shipped map read directly off disk
 * (ApplicationFoundation\AxMap\LogMap.xml): fields are typed via an i:type
 * discriminator (AxMapFieldInt, AxMapFieldInt64, AxMapFieldString,
 * AxMapFieldContainer, ...), and a map is wired to an underlying table via
 * <Mappings><AxTableMapping><Connections> entries pairing each map field
 * name (MapField) with the target table's field name (MapFieldTo).
 */

const FIELD_TYPE_TO_AXTYPE: Record<string, string> = {
  Int: 'AxMapFieldInt',
  Int64: 'AxMapFieldInt64',
  String: 'AxMapFieldString',
  Real: 'AxMapFieldReal',
  Enum: 'AxMapFieldEnum',
  Container: 'AxMapFieldContainer',
  Date: 'AxMapFieldDate',
  UtcDateTime: 'AxMapFieldUtcDateTime',
  Guid: 'AxMapFieldGuid',
  Boolean: 'AxMapFieldBoolean',
};

interface MapFieldDef {
  name: string;
  type?: string;
  extendedDataType?: string;
  enumType?: string;
  stringSize?: number;
}

interface MapMappingConnection {
  mapField: string;
  mapFieldTo: string;
}

/**
 * properties.fields         — [{ name, type?, extendedDataType?, enumType?, stringSize? }]
 * properties.mappingTable   — name of the underlying AxTable this map targets.
 * properties.mappings       — [{ mapField, mapFieldTo }] connections into that table.
 *                              Defaults to one connection per field (mapFieldTo = name)
 *                              when the caller didn't specify explicit mappings.
 */
export function buildAxMapXml(mapName: string, properties?: Record<string, any>): string {
  const label: string | undefined = properties?.label;
  const developerDocumentation: string | undefined = properties?.developerDocumentation;
  const mappingTable: string | undefined = properties?.mappingTable;
  const fields: MapFieldDef[] = Array.isArray(properties?.fields) ? properties.fields : [];
  const explicitMappings: MapMappingConnection[] | undefined =
    Array.isArray(properties?.mappings) ? properties.mappings : undefined;

  const fieldsXml = fields.length
    ? fields.map(f => {
      const axType = FIELD_TYPE_TO_AXTYPE[f.type || 'String'] || 'AxMapFieldString';
      const inner: string[] = [`\t\t\t<Name>${f.name}</Name>`];
      if (f.extendedDataType) inner.push(`\t\t\t<ExtendedDataType>${f.extendedDataType}</ExtendedDataType>`);
      if (axType === 'AxMapFieldEnum' && f.enumType) inner.push(`\t\t\t<EnumType>${f.enumType}</EnumType>`);
      if (axType === 'AxMapFieldString' && f.stringSize !== undefined) inner.push(`\t\t\t<StringSize>${f.stringSize}</StringSize>`);
      return `\t\t<AxMapBaseField xmlns=""\n\t\t\ti:type="${axType}">\n${inner.join('\n')}\n\t\t</AxMapBaseField>`;
    }).join('\n')
    : '';

  const mappingConnections: MapMappingConnection[] = explicitMappings
    || (mappingTable ? fields.map(f => ({ mapField: f.name, mapFieldTo: f.name })) : []);

  const mappingsXml = mappingTable
    ? `\t<Mappings>
\t\t<AxTableMapping>
\t\t\t<MappingTable>${mappingTable}</MappingTable>
\t\t\t<Connections>
${mappingConnections.map(c => `\t\t\t\t<AxTableMappingConnection>\n\t\t\t\t\t<MapField>${c.mapField}</MapField>\n\t\t\t\t\t<MapFieldTo>${c.mapFieldTo}</MapFieldTo>\n\t\t\t\t</AxTableMappingConnection>`).join('\n')}
\t\t\t</Connections>
\t\t</AxTableMapping>
\t</Mappings>`
    : `\t<Mappings />`;

  return `<?xml version="1.0" encoding="utf-8"?>
<AxMap xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${mapName}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ${mapName} extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>${developerDocumentation ? `\n\t<DeveloperDocumentation>${developerDocumentation}</DeveloperDocumentation>` : ''}${label ? `\n\t<Label>${label}</Label>` : ''}
\t<FieldGroups />
\t<Fields>
${fieldsXml}
\t</Fields>
${mappingsXml}
</AxMap>
`;
}
