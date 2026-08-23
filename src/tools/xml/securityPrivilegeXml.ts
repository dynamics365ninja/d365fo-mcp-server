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
import { escapeXml } from '../../utils/xmlEscape.js';
import { assertKnownEnumValue, SECURITY_ENTRY_POINT_TYPES } from '../../utils/axEnumProperties.js';

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
    // ALPHABETICAL, like the data-entity grant below — the Microsoft deserializer
    // is sequence-ordered, so out-of-order elements are dropped in silence. This
    // branch used to emit Read/Update/Create/Delete, which round-tripped as
    // R:[Allow] U:[Allow] C:[Unset] D:[Unset]: `maintain` granted read+update,
    // built clean and passed xppbp. Measured, not assumed — 370 shipped
    // AxSecurityPrivilege files hold 731 multi-element entry-point grants and
    // NONE is out of alphabetical order. (Eval case
    // L2-object-delete-and-entry-point-cleanup, 2026-08-23.)
    const grantXml = al === 'maintain'
      ? '\t\t\t\t<Create>Allow</Create>\n\t\t\t\t<Delete>Allow</Delete>\n\t\t\t\t<Read>Allow</Read>\n\t\t\t\t<Update>Allow</Update>'
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

// ─── Entry-point removal ─────────────────────────────────────────────────────

/** One entry point as it is written into an AxSecurityPrivilege's <EntryPoints>. */
export interface SecurityEntryPointRef {
  /** <Name> — the entry point's own name, conventionally equal to ObjectName. */
  name: string;
  /** <ObjectName> — the menu item / service operation the entry point grants. */
  objectName: string;
  /** <ObjectType> — the EntryPointType enum value. */
  objectType: string;
}

export type RemoveEntryPointResult =
  /** Removed. `removed` is the entry that went, `xml` the updated document. */
  | { kind: 'removed'; xml: string; removed: SecurityEntryPointRef }
  /** No entry point matched. `present` lists the ones there are, for the error. */
  | { kind: 'not-found'; present: SecurityEntryPointRef[] }
  /** More than one entry point matched — refuse rather than pick. */
  | { kind: 'ambiguous'; matches: SecurityEntryPointRef[] }
  /** Not an AxSecurityPrivilege; the caller declines. */
  | { kind: 'unsupported' };

/** Text of the first `<tag>…</tag>` inside `block`, or '' when absent. */
function childText(block: string, tag: string): string {
  const m = new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`).exec(block);
  return m ? m[1].trim() : '';
}

/**
 * Every <AxSecurityEntryPointReference> in the privilege, with its byte range.
 *
 * Matched non-greedily on the element, not on `<Name>`: a privilege's own <Name>
 * and its <DataEntityPermissions> entries carry <Name> too, and an entry point's
 * <Grant> holds a whole CRUD block of its own.
 */
function scanEntryPoints(xml: string): Array<SecurityEntryPointRef & { from: number; to: number }> {
  const found: Array<SecurityEntryPointRef & { from: number; to: number }> = [];
  const re = /[\t ]*<AxSecurityEntryPointReference>[\s\S]*?<\/AxSecurityEntryPointReference>\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    found.push({
      name: childText(block, 'Name'),
      objectName: childText(block, 'ObjectName'),
      objectType: childText(block, 'ObjectType'),
      from: m.index,
      to: m.index + block.length,
    });
  }
  return found;
}

/**
 * Remove one <AxSecurityEntryPointReference> from an AxSecurityPrivilege.
 *
 * The inverse of what buildAxSecurityPrivilegeXml writes for `targetObject`, and
 * the only grounded way to take a menu item's security exposure back off a
 * privilege: there is no bridge operation for security objects at all (they are
 * deliberately excluded from BRIDGE_CREATE_TYPES for the same reason — the
 * generic property channel cannot carry <EntryPoints>), so the alternative was a
 * whole-file overwrite.
 *
 * Identified by `name`, or by `objectName` (+ `objectType` when the same object
 * is referenced through more than one entry-point type). Two matches are refused
 * rather than resolved: removing the wrong entry point silently revokes access
 * to a different menu item, which builds clean and only surfaces as a user
 * losing a form.
 *
 * When the last entry point goes, <EntryPoints> is collapsed to the self-closing
 * spelling the serializer uses for an empty collection.
 */
export function removeSecurityEntryPoint(
  xml: string,
  criteria: { name?: string; objectName?: string; objectType?: string },
): RemoveEntryPointResult {
  if (!/<AxSecurityPrivilege\b/.test(xml)) return { kind: 'unsupported' };

  const entries = scanEntryPoints(xml);
  const present = entries.map(({ name, objectName, objectType }) => ({ name, objectName, objectType }));

  const eq = (a: string, b: string | undefined) =>
    b !== undefined && a.toLowerCase() === b.trim().toLowerCase();

  const matches = entries.filter(e => {
    if (criteria.name !== undefined) return eq(e.name, criteria.name);
    if (!eq(e.objectName, criteria.objectName)) return false;
    return criteria.objectType === undefined || eq(e.objectType, criteria.objectType);
  });

  if (matches.length === 0) return { kind: 'not-found', present };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      matches: matches.map(({ name, objectName, objectType }) => ({ name, objectName, objectType })),
    };
  }

  const hit = matches[0];
  let updated = xml.slice(0, hit.from) + xml.slice(hit.to);

  // Last one out — collapse the collection to the SAME empty spelling
  // buildAxSecurityPrivilegeXml above emits for a privilege created without a
  // targetObject, so a privilege stripped back to nothing is byte-identical to one
  // that never had an entry point (see the round-trip test). Deliberately the
  // paired form rather than `<EntryPoints />`: that is what this builder writes and
  // what the create path's golden records, and the two must not disagree over a
  // difference the deserializer cannot see.
  if (entries.length === 1) {
    updated = updated.replace(/<EntryPoints>\s*<\/EntryPoints>/, '<EntryPoints></EntryPoints>');
  }

  return {
    kind: 'removed',
    xml: updated,
    removed: { name: hit.name, objectName: hit.objectName, objectType: hit.objectType },
  };
}
