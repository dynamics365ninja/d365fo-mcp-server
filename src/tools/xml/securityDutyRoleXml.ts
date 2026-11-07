/**
 * Shared builders for AxSecurityDuty / AxSecurityRole and their extensions.
 *
 * createD365File.ts and generateD365Xml.ts each expose a mirrored
 * XmlTemplateGenerator class; both delegate here so the two cannot drift
 * (mirrors the securityPrivilegeXml.ts / queryViewXml.ts pattern).
 *
 * This module exists because they DID drift, badly. The create path was fixed
 * after the "security chain silent empty write" incident; the generate mirror
 * kept hard-coding `<Privileges />` and `<Duties />` regardless of what the
 * caller passed. Since the documented hybrid flow is
 * generate → create(xmlContent), that mirror wrote empty, non-functional
 * security objects to disk — and they build perfectly clean, so nothing fails
 * until someone notices the role grants nothing.
 */

import { escapeXml } from '../../utils/xmlEscape.js';
import { createXmlTokenScanner } from '../../utils/xmlScan.js';

/**
 * Normalize a name list that may arrive as an array or a comma/semicolon/
 * newline-separated string (models pass either). Returns trimmed, non-empty names.
 */
export function normalizeNameList(value: any): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[,;\n]+/);
  return arr.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0);
}

/**
 * Render a security reference container: a self-closing tag when empty, or the
 * wrapped child references (e.g. <AxSecurityPrivilegeReference><Name>…</Name></…>).
 *
 * The child element name matters: a duty/role that lists its privileges under
 * `AxSecurityRolePermissionSet` / `AxSecurityRoleDutyPermission` deserializes into
 * an EMPTY reference list, so the whole duty→privilege→role chain is dead —
 * xppbp then reports BPErrorDutyHasNoPrivileges / BPErrorPrivilegeNotCoveredByDuty /
 * BPErrorDutyNotCoveredByRole for references that are physically in the file.
 * The correct names are AxSecurityPrivilegeReference / AxSecurityDutyReference.
 * Evidence: the 2026-07-21 eval sweep, finding #31 (L4-master-security-slice run).
 */
export function securityRefContainer(container: string, childTag: string, names: string[]): string {
  if (names.length === 0) return `\t<${container} />`;
  const children = names.map(n => securityRefXml(childTag, n)).join('\n');
  return `\t<${container}>\n${children}\n\t</${container}>`;
}

/** One reference, as it sits inside its container. */
function securityRefXml(childTag: string, name: string): string {
  return `\t\t<${childTag}>\n\t\t\t<Name>${name}</Name>\n\t\t</${childTag}>`;
}

/**
 * AxSecurityDuty.
 * properties.privileges – privilege names to reference (array or comma-separated).
 */
export function buildAxSecurityDutyXml(name: string, properties?: Record<string, any>): string {
  const label = properties?.label || '@TODO:LabelId';
  const privileges = normalizeNameList(properties?.privileges);
  return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>
${securityRefContainer('Privileges', 'AxSecurityPrivilegeReference', privileges)}
</AxSecurityDuty>`;
}

/**
 * AxSecurityRole.
 * properties.duties     – duty names to reference (array or comma-separated).
 * properties.privileges – privilege names to reference directly on the role.
 */
export function buildAxSecurityRoleXml(name: string, properties?: Record<string, any>): string {
  const label = properties?.label || '@TODO:LabelId';
  const duties = normalizeNameList(properties?.duties);
  const privileges = normalizeNameList(properties?.privileges);
  return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRole xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>
\t<DirectAccessPermissions />
${securityRefContainer('Duties', 'AxSecurityDutyReference', duties)}
${securityRefContainer('Privileges', 'AxSecurityPrivilegeReference', privileges)}
\t<SubRoles />
</AxSecurityRole>`;
}

/**
 * AxSecurityDutyExtension — adds privileges to an EXISTING (often Microsoft-owned)
 * duty without overlaying it. Real Microsoft object type, e.g.
 * K:\...\ApplicationCommon\AxSecurityDutyExtension\BatchJobMaintain.ApplicationCommon.xml.
 * Name convention: "<BaseDuty>.<PrefixOrModel>Extension" (same dot-notation as
 * menu-extension / table-extension — see DOT_NOTATION_EXTENSION_TYPES).
 * properties.privileges – privilege names to add to the base duty.
 */
export function buildAxSecurityDutyExtensionXml(name: string, properties?: Record<string, any>): string {
  const privileges = normalizeNameList(properties?.privileges);
  return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDutyExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
${securityRefContainer('Privileges', 'AxSecurityPrivilegeReference', privileges)}
\t<PropertyModifications />
</AxSecurityDutyExtension>`;
}

/**
 * AxSecurityRoleExtension — adds duties and/or privileges to an EXISTING (often
 * Microsoft-owned) role without overlaying it. Real Microsoft object type, e.g.
 * K:\...\ApplicationCommon\AxSecurityRoleExtension\SystemUser.ApplicationCommon.xml.
 * Name convention: "<BaseRole>.<PrefixOrModel>Extension".
 * properties.duties     – duty names to add to the base role.
 * properties.privileges – privilege names to add directly to the base role.
 */
export function buildAxSecurityRoleExtensionXml(name: string, properties?: Record<string, any>): string {
  const duties = normalizeNameList(properties?.duties);
  const privileges = normalizeNameList(properties?.privileges);
  return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRoleExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<DirectAccessPermissions />
${securityRefContainer('Duties', 'AxSecurityDutyReference', duties)}
${securityRefContainer('Privileges', 'AxSecurityPrivilegeReference', privileges)}
\t<PropertyModifications />
</AxSecurityRoleExtension>`;
}

// ─── Duty and privilege references ───────────────────────────────────────────

/** What a role or duty references: one value per add-/remove- operation pair. */
export type SecurityReferenceKind = 'duty' | 'privilege';

/**
 * Where each kind of reference lives, and which objects carry that list.
 *
 * A duty carries privileges and no duties, so add-duty has no place to write on
 * one. Its sub-duties are a different collection of the same child element, which
 * is why the scan below stays inside the named container.
 */
export const SECURITY_REFERENCE_SHAPES: Record<SecurityReferenceKind, {
  container: string;
  child: string;
  roots: readonly string[];
  objectTypes: readonly string[];
}> = {
  duty: {
    container: 'Duties',
    child: 'AxSecurityDutyReference',
    roots: ['AxSecurityRole', 'AxSecurityRoleExtension'],
    objectTypes: ['security-role', 'security-role-extension'],
  },
  privilege: {
    container: 'Privileges',
    child: 'AxSecurityPrivilegeReference',
    roots: ['AxSecurityRole', 'AxSecurityRoleExtension', 'AxSecurityDuty', 'AxSecurityDutyExtension'],
    objectTypes: ['security-role', 'security-role-extension', 'security-duty', 'security-duty-extension'],
  },
};

/** An AOT object name. A list ("A,B") or a stray tag is refused, not written into <Name>. */
const SECURITY_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SecurityReferenceScan {
  /** Local name of the document's root element. */
  root?: string;
  /** The container element. A self-closing one has an empty inner range. */
  container?: { from: number; to: number; innerFrom: number; innerTo: number };
  /** The references in the container; from/to cover their whole lines. */
  refs: Array<{ name: string; from: number; to: number }>;
}

/**
 * Walk the document token by token rather than matching <Duties> with a regex: a
 * reference commented out by hand is not a reference, and the same child element
 * can sit in another collection of the object.
 */
function scanSecurityReferences(xml: string, kind: SecurityReferenceKind): SecurityReferenceScan {
  const { container, child } = SECURITY_REFERENCE_SHAPES[kind];
  const scan: SecurityReferenceScan = { refs: [] };
  const scanner = createXmlTokenScanner();
  let depth = 0;
  let inContainer = false;
  let ref: { name: string; from: number } | null = null;
  let nameAt = 0;

  let token: RegExpExecArray | null;
  while ((token = scanner.exec(xml)) !== null) {
    const closing = token[1];
    const starting = token[2];
    const tagEnd = token.index + token[0].length;

    if (closing) {
      depth--;
      if (ref && depth === 3 && closing === 'Name') {
        ref.name = xml.slice(nameAt, token.index).trim();
      } else if (ref && depth === 2 && closing === child) {
        const to = /^\r?\n/.exec(xml.slice(tagEnd, tagEnd + 2))?.[0].length ?? 0;
        scan.refs.push({ ...ref, to: tagEnd + to });
        ref = null;
      } else if (inContainer && depth === 1 && closing === container) {
        scan.container!.innerTo = token.index;
        scan.container!.to = tagEnd;
        inContainer = false;
      }
      continue;
    }
    if (!starting) continue;

    const selfClosing = token[4] === '/';
    if (depth === 0) {
      scan.root ??= starting;
    } else if (depth === 1 && starting === container && !scan.container) {
      scan.container = { from: token.index, to: tagEnd, innerFrom: tagEnd, innerTo: tagEnd };
      inContainer = !selfClosing;
    } else if (inContainer && depth === 2 && starting === child && !selfClosing) {
      let from = token.index;
      while (from > 0 && (xml[from - 1] === '\t' || xml[from - 1] === ' ')) from--;
      ref = { name: '', from };
    } else if (ref && depth === 3 && starting === 'Name') {
      nameAt = tagEnd;
    }
    if (!selfClosing) depth++;
  }
  return scan;
}

/** The names a role, duty or extension references, in file order. */
export function listSecurityReferences(xml: string, kind: SecurityReferenceKind): string[] {
  return scanSecurityReferences(xml, kind).refs.map(r => r.name);
}

export type AddSecurityReferenceResult =
  | { kind: 'added'; xml: string; added: string }
  /** The reference is already there, spelled `existing` — idempotent no-op. */
  | { kind: 'already-present'; existing: string }
  /** Not an AOT object name. */
  | { kind: 'invalid-name' }
  /** No container to insert into. */
  | { kind: 'no-collection' }
  /** This object does not carry that list; the caller declines. */
  | { kind: 'unsupported'; root?: string };

/**
 * Add one duty or privilege reference, at the end of the list.
 *
 * `create` is the only place these lists were ever written, so changing one
 * afterwards meant create(overwrite=true) with the complete list, or hand-written
 * XML. Security objects have no bridge write path, so this is the grounded route.
 *
 * Shape measured on 172 Visual Studio-serialized roles, duties and extensions:
 * all 877 references hold <Name> and nothing else, the two containers are always
 * present on an object that has them, and an empty one is spelled `<Duties />`.
 * The paired empty form is expanded too, because a hand edit can leave one.
 *
 * Names compare case-insensitively, as AOT names do, so `sysadmin` does not become
 * a second reference next to `SysAdmin`.
 */
export function addSecurityReference(
  xml: string,
  kind: SecurityReferenceKind,
  name: string,
): AddSecurityReferenceResult {
  const shape = SECURITY_REFERENCE_SHAPES[kind];
  const scan = scanSecurityReferences(xml, kind);
  if (!scan.root || !shape.roots.includes(scan.root)) return { kind: 'unsupported', root: scan.root };

  const added = name.trim();
  if (!SECURITY_REFERENCE_NAME.test(added)) return { kind: 'invalid-name' };

  const existing = scan.refs.find(r => r.name.toLowerCase() === added.toLowerCase());
  if (existing) return { kind: 'already-present', existing: existing.name };
  if (!scan.container) return { kind: 'no-collection' };

  const { from, to, innerFrom, innerTo } = scan.container;
  const block = `${securityRefXml(shape.child, added)}\n`;
  if (xml.slice(innerFrom, innerTo).trim() === '') {
    const filled = `<${shape.container}>\n${block}\t</${shape.container}>`;
    return { kind: 'added', xml: xml.slice(0, from) + filled + xml.slice(to), added };
  }

  // Insert before the closing tag, consuming the whitespace run that is that tag's
  // own indent so the appended block is not indented on top of it.
  let end = innerTo;
  while (end > innerFrom && /\s/.test(xml[end - 1])) end--;
  return { kind: 'added', xml: `${xml.slice(0, end)}\n${block}\t${xml.slice(innerTo)}`, added };
}

export type RemoveSecurityReferenceResult =
  /** Removed. `removed` is the name as the file spelled it. */
  | { kind: 'removed'; xml: string; removed: string }
  /** No reference matched. `present` lists the ones there are, for the error. */
  | { kind: 'not-found'; present: string[]; root: string }
  /** The name is listed more than once — refuse rather than pick. */
  | { kind: 'ambiguous'; matches: string[] }
  /** This object does not carry that list; the caller declines. */
  | { kind: 'unsupported'; root?: string };

/**
 * Remove one duty or privilege reference.
 *
 * A name listed twice is refused rather than resolved: taking out one copy leaves
 * the access in place under a ✅, which is the opposite of what was asked.
 *
 * When the last reference goes, the container collapses to the self-closing
 * spelling securityRefContainer writes for an empty list, so a list emptied here is
 * byte-identical to one that never held anything. A comment left inside it keeps
 * the paired form: the collapse must not delete what it did not come for.
 */
export function removeSecurityReference(
  xml: string,
  kind: SecurityReferenceKind,
  name: string,
): RemoveSecurityReferenceResult {
  const shape = SECURITY_REFERENCE_SHAPES[kind];
  const scan = scanSecurityReferences(xml, kind);
  if (!scan.root || !shape.roots.includes(scan.root)) return { kind: 'unsupported', root: scan.root };

  const wanted = name.trim().toLowerCase();
  const matches = scan.refs.filter(r => r.name.toLowerCase() === wanted);
  if (matches.length === 0) return { kind: 'not-found', present: scan.refs.map(r => r.name), root: scan.root };
  if (matches.length > 1) return { kind: 'ambiguous', matches: matches.map(r => r.name) };

  const hit = matches[0];
  const updated = xml.slice(0, hit.from) + xml.slice(hit.to);
  const removedLength = hit.to - hit.from;
  const { from, to, innerFrom, innerTo } = scan.container!;
  if (updated.slice(innerFrom, innerTo - removedLength).trim() !== '') {
    return { kind: 'removed', xml: updated, removed: hit.name };
  }
  return {
    kind: 'removed',
    xml: `${updated.slice(0, from)}<${shape.container} />${updated.slice(to - removedLength)}`,
    removed: hit.name,
  };
}
