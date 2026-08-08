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
 * properties.objectType    – EntryPointType: None | MenuItemDisplay | MenuItemOutput |
 *                            MenuItemAction | ServiceOperation (default: MenuItemDisplay)
 * properties.accessLevel   – 'view' | 'read' (Read only) | 'maintain' (full CRUD).
 *                            Default 'view'.
 * properties.dataEntity    – Name of the data entity to grant permissions on (optional)
 */

import { assertKnownEnumValue, SECURITY_ENTRY_POINT_TYPES } from '../utils/axEnumProperties.js';

/** The only two grant shapes this builder can emit. Anything else is a wrong privilege. */
const ACCESS_LEVELS = ['view', 'read', 'maintain'] as const;

export function buildAxSecurityPrivilegeXml(name: string, properties?: Record<string, any>): string {
  const label = properties?.label || '@TODO:LabelId';
  const targetObject: string | undefined = properties?.targetObject;

  // <ObjectType> is the EntryPointType enum — an unknown value is dropped by the
  // deserializer, leaving the entry point pointing at nothing.
  const objType: string = assertKnownEnumValue(
    `Security privilege '${name}': objectType`,
    properties?.objectType,
    SECURITY_ENTRY_POINT_TYPES,
    'MenuItemDisplay',
  );

  // Only 'maintain' ever produced a CRUD grant; EVERY other string — including the
  // plausible-sounding 'full', 'edit', 'update', 'delete' — fell through to the
  // read-only branch. That privilege builds clean, passes BP, and grants the wrong
  // permissions, which is the one failure class a security object must not have.
  // So this is a closed enum, not a comparison.
  const rawAccess = properties?.accessLevel === undefined || properties?.accessLevel === null
    ? 'view'
    : String(properties.accessLevel).trim().toLowerCase();
  if (!(ACCESS_LEVELS as readonly string[]).includes(rawAccess)) {
    throw new Error(
      `Security privilege '${name}': accessLevel "${properties?.accessLevel}" is not supported — ` +
      `nothing was written. Use "maintain" for full CRUD (Read+Update+Create+Delete, plus Correct on a ` +
      `data entity) or "view"/"read" for Read only. There is no "full"/"edit" level here — those used to ` +
      `be accepted and silently degraded to Read-only.`,
    );
  }
  const al = rawAccess;

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
\t<Label>${label}</Label>
\t${dataEntityPermissionsElement}
\t<DirectAccessPermissions />
\t<EntryPoints>${entryPointsXml}</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;
}
