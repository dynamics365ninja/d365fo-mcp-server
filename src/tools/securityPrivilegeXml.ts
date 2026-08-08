/**
 * Shared builder for AxSecurityPrivilege XML.
 *
 * createD365File.ts and generateD365Xml.ts each expose a mirrored
 * XmlTemplateGenerator class; both delegate here so the two cannot drift.
 *
 * Element order matches the Microsoft metadata serializer, verified against
 * real shipped privileges in
 *   ApplicationCommon\AxSecurityPrivilege\AgentFeedEntity{Maintain,View}.xml:
 *   • AxSecurityDataEntityPermission children:  Grant, Name, Fields, Methods
 *     (Grant FIRST — unlike AxSecurityEntryPointReference, which is Name-first)
 *   • <Grant> CRUD elements are alphabetical:   Correct, Create, Delete, Read, Update
 *
 * properties.label         – label id (default: @TODO:LabelId)
 * properties.targetObject  – ObjectName of the target menu item (optional)
 * properties.objectType    – MenuItemDisplay | MenuItemAction | MenuItemOutput (default: MenuItemDisplay)
 * properties.accessLevel   – 'view' | 'maintain' | 'read' (default: 'view' = Read only)
 * properties.dataEntity    – Name of the data entity to grant permissions on (optional)
 */
import { escapeXml } from '../utils/xmlEscape.js';

export function buildAxSecurityPrivilegeXml(name: string, properties?: Record<string, any>): string {
  const label = properties?.label || '@TODO:LabelId';
  const targetObject: string | undefined = properties?.targetObject;
  const objType: string = properties?.objectType || 'MenuItemDisplay';
  const al = (properties?.accessLevel || 'view').toLowerCase();

  let entryPointsXml: string;
  if (targetObject) {
    const grantXml = al === 'maintain'
      ? '\t\t\t\t<Read>Allow</Read>\n\t\t\t\t<Update>Allow</Update>\n\t\t\t\t<Create>Allow</Create>\n\t\t\t\t<Delete>Allow</Delete>'
      : '\t\t\t\t<Read>Allow</Read>';
    entryPointsXml = `\n\t\t<AxSecurityEntryPointReference>\n\t\t\t<Name>${targetObject}</Name>\n\t\t\t<Grant>\n${grantXml}\n\t\t\t</Grant>\n\t\t\t<ObjectName>${targetObject}</ObjectName>\n\t\t\t<ObjectType>${objType}</ObjectType>\n\t\t\t<Forms />\n\t\t</AxSecurityEntryPointReference>\n\t`;
  } else {
    entryPointsXml = '';
  }

  const dataEntity: string | undefined = properties?.dataEntity;
  let dataEntityPermissionsXml: string;
  if (dataEntity) {
    // CRUD elements alphabetical, matching the Microsoft serializer.
    const grantXml = al === 'maintain'
      ? '\t\t\t\t<Correct>Allow</Correct>\n\t\t\t\t<Create>Allow</Create>\n\t\t\t\t<Delete>Allow</Delete>\n\t\t\t\t<Read>Allow</Read>\n\t\t\t\t<Update>Allow</Update>'
      : '\t\t\t\t<Read>Allow</Read>';
    // Grant comes before Name for data-entity permissions.
    dataEntityPermissionsXml = `\n\t\t<AxSecurityDataEntityPermission>\n\t\t\t<Grant>\n${grantXml}\n\t\t\t</Grant>\n\t\t\t<Name>${dataEntity}</Name>\n\t\t\t<Fields />\n\t\t\t<Methods />\n\t\t</AxSecurityDataEntityPermission>\n\t`;
  } else {
    dataEntityPermissionsXml = '';
  }

  const dataEntityPermissionsElement = dataEntityPermissionsXml
    ? `<DataEntityPermissions>${dataEntityPermissionsXml}</DataEntityPermissions>`
    : '<DataEntityPermissions />';

  return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>
\t${dataEntityPermissionsElement}
\t<DirectAccessPermissions />
\t<EntryPoints>${entryPointsXml}</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;
}
