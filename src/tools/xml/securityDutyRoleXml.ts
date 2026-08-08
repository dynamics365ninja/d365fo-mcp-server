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
 * Evidence: docs/eval-sweep-findings-2026-07-21.md #31 (L4-master-security-slice run).
 */
export function securityRefContainer(container: string, childTag: string, names: string[]): string {
  if (names.length === 0) return `\t<${container} />`;
  const children = names
    .map(n => `\t\t<${childTag}>\n\t\t\t<Name>${n}</Name>\n\t\t</${childTag}>`)
    .join('\n');
  return `\t<${container}>\n${children}\n\t</${container}>`;
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
