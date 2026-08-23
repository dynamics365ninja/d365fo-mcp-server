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
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * The CRUD block of a <Grant>, for either place a privilege carries one.
 *
 * ONE function on purpose. The two call sites drifted before: the data-entity
 * branch emitted alphabetically and the entry-point branch emitted
 * Read/Update/Create/Delete, so `maintain` on an entry point silently granted
 * read+update — the Microsoft deserializer is sequence-ordered and dropped the
 * rest. Both build clean and pass xppbp, which is why nothing caught it until a
 * live round trip did (eval case L2-object-delete-and-entry-point-cleanup).
 *
 * That same round trip then caught the second half, in THIS function's own
 * reasoning. It used to withhold `Correct` from entry points, on the stated
 * grounds that it is a data-entity permission and granting it "would grant more
 * than was asked". That was wrong. Measured over every AxSecurityPrivilege in
 * PackagesLocalDirectory — 20,164 files, 30,169 entry-point <Grant> blocks:
 *
 *   14034  Correct,Create,Delete,Read,Update
 *   12765  Read
 *    2050  Correct,Create,Delete,Invoke,Read,Update
 *     660  Create,Read,Update
 *     586  Read,Update
 *      65  Correct,Create,Read,Update
 *       3  Delete
 *
 * The shape emitted for `maintain` — Create,Delete,Read,Update — occurs ZERO
 * times. Withholding `Correct` granted LESS than the AOT designer's own Delete
 * level: the same silent-underspecification as the ordering bug, and just as
 * invisible to the compiler and to xppbp.
 *
 * `Invoke` splits by entry-point type rather than by access level, so it is the
 * one thing this still keys on: 1066 of ServiceOperation's 1074 grants carry it
 * (99.3%), against 659 of MenuItemDisplay's 21769 (3.0%) and comparable rates on
 * the other two menu-item types. Majority behaviour on both sides of that split.
 */
function buildGrantXml(al: AccessLevel, entryPointType?: string): string {
  const i = '\t\t\t\t';
  if (al !== 'maintain') return `${i}<Read>Allow</Read>`;
  const ops = entryPointType === 'ServiceOperation'
    ? ['Correct', 'Create', 'Delete', 'Invoke', 'Read', 'Update']
    : ['Correct', 'Create', 'Delete', 'Read', 'Update'];
  return ops.map(op => `${i}<${op}>Allow</${op}>`).join('\n');
}

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
  // Narrowed, not asserted: the guard above already rejected anything outside
  // the closed enum, so this is the type catching up with the check.
  const al = rawAccess as AccessLevel;

  let entryPointsXml: string;
  if (targetObject) {
    const grantXml = buildGrantXml(al, objType);
    entryPointsXml = `\n\t\t<AxSecurityEntryPointReference>\n\t\t\t<Name>${targetObject}</Name>\n\t\t\t<Grant>\n${grantXml}\n\t\t\t</Grant>\n\t\t\t<ObjectName>${targetObject}</ObjectName>\n\t\t\t<ObjectType>${objType}</ObjectType>\n\t\t\t<Forms />\n\t\t</AxSecurityEntryPointReference>\n\t`;
  } else {
    entryPointsXml = '';
  }

  const dataEntity: string | undefined = properties?.dataEntity;
  let dataEntityPermissionsXml: string;
  if (dataEntity) {
    const grantXml = buildGrantXml(al);
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

export type AddEntryPointResult =
  | { kind: 'added'; xml: string; added: SecurityEntryPointRef }
  /** An entry point with that <Name> is already there — idempotent no-op. */
  | { kind: 'already-present'; existing: SecurityEntryPointRef }
  /** objectType outside the closed EntryPointType enum. */
  | { kind: 'bad-object-type'; given: string }
  /** No <EntryPoints> collection to insert into. */
  | { kind: 'no-collection' }
  /** Not an AxSecurityPrivilege; the caller declines. */
  | { kind: 'unsupported' };

/**
 * Add one <AxSecurityEntryPointReference> to an AxSecurityPrivilege.
 *
 * The missing half of the pair. `remove-entry-point` shipped without it, so a
 * privilege could only ever be given the ONE entry point `create` takes as the
 * scalar `properties.targetObject` — a second one required
 * `create(overwrite=true, xmlContent=…)`, i.e. hand-authored XML on the
 * grounded path. That also left remove-entry-point's ambiguity refusal
 * unreachable through supported parameters, and therefore untested against a
 * real privilege (eval case L2-object-delete-and-entry-point-cleanup, 2026-08-23).
 *
 * Shape measured against the shipped AOT (ApplicationSuite +
 * ApplicationFoundation: 370 privileges, 1036 entry points):
 *   - element order Name, Grant, ObjectName, ObjectType, Forms — 915 of 1036,
 *     the remainder differing only by optional elements this does not write;
 *   - <Forms /> present in 1035 of 1036;
 *   - <Name> equals <ObjectName> in 910 of 1036, so it defaults to it and stays
 *     overridable.
 *
 * objectType is a CLOSED enum for the same reason accessLevel is: a value
 * outside EntryPointType deserializes to nothing, so the privilege builds clean,
 * passes xppbp and grants access to no object at all.
 */
export function addSecurityEntryPoint(
  xml: string,
  spec: { objectName: string; objectType: string; name?: string; accessLevel?: string },
): AddEntryPointResult {
  if (!/<AxSecurityPrivilege\b/.test(xml)) return { kind: 'unsupported' };

  const objectType = String(spec.objectType ?? '').trim();
  const matchedType = SECURITY_ENTRY_POINT_TYPES.find(
    t => t.toLowerCase() === objectType.toLowerCase(),
  );
  if (!matchedType) return { kind: 'bad-object-type', given: spec.objectType };

  const objectName = String(spec.objectName).trim();
  const name = (spec.name ?? objectName).trim();

  const existing = scanEntryPoints(xml).find(e => e.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return {
      kind: 'already-present',
      existing: { name: existing.name, objectName: existing.objectName, objectType: existing.objectType },
    };
  }

  const rawAccess = String(spec.accessLevel ?? 'view').trim().toLowerCase();
  const al: AccessLevel = rawAccess === 'maintain' ? 'maintain' : 'view';

  const block =
    `\t\t<AxSecurityEntryPointReference>\n` +
    `\t\t\t<Name>${name}</Name>\n` +
    `\t\t\t<Grant>\n${buildGrantXml(al, matchedType)}\n\t\t\t</Grant>\n` +
    `\t\t\t<ObjectName>${objectName}</ObjectName>\n` +
    `\t\t\t<ObjectType>${matchedType}</ObjectType>\n` +
    `\t\t\t<Forms />\n` +
    `\t\t</AxSecurityEntryPointReference>\n`;

  // Both empty spellings, because both occur: buildAxSecurityPrivilegeXml writes
  // the paired form for a privilege created without a targetObject, and
  // removeSecurityEntryPoint collapses back to it, while hand-written and
  // Microsoft files use the self-closing one.
  const empty = /<EntryPoints>\s*<\/EntryPoints>|<EntryPoints\s*\/>/;
  if (empty.test(xml)) {
    return {
      kind: 'added',
      xml: xml.replace(empty, `<EntryPoints>\n${block}\t</EntryPoints>`),
      added: { name, objectName, objectType: matchedType },
    };
  }

  const close = xml.indexOf('</EntryPoints>');
  if (close < 0) return { kind: 'no-collection' };

  // Insert before the closing tag, consuming the whitespace run that is that
  // tag's own indent so the appended block is not indented on top of it.
  let from = close;
  while (from > 0 && /\s/.test(xml[from - 1])) from--;
  return {
    kind: 'added',
    xml: `${xml.slice(0, from)}\n${block}\t${xml.slice(close)}`,
    added: { name, objectName, objectType: matchedType },
  };
}
