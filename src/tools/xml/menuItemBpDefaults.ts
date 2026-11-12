/**
 * OperationalDomain and SubscriberAccessLevel on a new menu item.
 *
 * Neither writer sets them: the template emitted Name/Label/Object/ObjectType
 * only, and the C# bridge's SetAxMenuItemProperty() has no case for either, so
 * every menu item this server created drew two or three xppbp warnings
 * (BPCheckMenuItemOperationalDomainPropertyNotSpecified,
 * BPCheckMenuItemSubscriberAccessLevelPropertyNotSpecified and, on an Action
 * item, …PropertyUnexpected). The expected values are in
 * src/utils/bpCreateDefaults.ts.
 *
 * Applied to the XML after either writer, the same way the table create
 * reconcile works, so it also covers an old bridge binary. A value the caller
 * passed in `properties` wins; without one, an element the writer (or the
 * caller's own xmlContent) already carries is left alone.
 *
 * AxMenuItem* properties are serialised in alphabetical order after <Name>
 * (no shipped file disagrees), so a new element goes before the first sibling
 * that sorts after it.
 */

import {
  expectedMenuItemBpDefaults,
  menuItemKindOf,
  parseOperationalDomain,
  type BpDefaults,
} from '../../utils/bpCreateDefaults.js';
import {
  SUBSCRIBER_PERMISSIONS,
  describeSubscriberAccessLevel,
  parseSubscriberAccessLevel,
  sameSubscriberAccessLevel,
  type SubscriberAccessLevel,
} from '../../utils/subscriberAccessLevel.js';

export interface MenuItemBpResult {
  xml: string;
  /** What was written, e.g. "OperationalDomain=Local". */
  applied: string[];
  /** Caller values that could not be used, with the reason. */
  unhonoured: string[];
  /** The rule behind the defaults, when a default was written. */
  reason?: string;
  /** xppbp names the OperationalDomain too (a form whose data sources are all Local). */
  domainExpected?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findKey(properties: Record<string, unknown> | undefined, key: string): string | undefined {
  return properties ? Object.keys(properties).find(k => k.toLowerCase() === key.toLowerCase()) : undefined;
}

/** The menu item's top-level indent (that of <Name>), or a tab. */
export function topIndent(xml: string): string {
  return /^([ \t]+)<Name>/m.exec(xml)?.[1] ?? '\t';
}

/** The top-level element `name` with its line(s), or null. */
export function findTopLevel(xml: string, indent: string, name: string): RegExpExecArray | null {
  const i = escapeRegExp(indent);
  return new RegExp(
    `^${i}<${name}\\s*/>[ \\t]*\\r?\\n|^${i}<${name}>[^\\n]*?</${name}>[ \\t]*\\r?\\n|^${i}<${name}>\\r?\\n[\\s\\S]*?^${i}</${name}>[ \\t]*\\r?\\n`,
    'm',
  ).exec(xml);
}

/**
 * Insert `block` (complete lines) before the first top-level sibling that sorts after `name`.
 * `trailing` names the siblings that close the document whatever their name (the
 * <Elements> of an AxMenu): the block goes before the first of them at the latest.
 */
export function insertAlphabetically(
  xml: string,
  indent: string,
  name: string,
  block: string,
  trailing: readonly string[] = [],
): string | null {
  const i = escapeRegExp(indent);
  for (const m of xml.matchAll(new RegExp(`^${i}<(\\w+)[\\s/>]`, 'gm'))) {
    if (m[1] === 'Name') continue;
    if (trailing.includes(m[1]) || m[1].localeCompare(name, 'en', { sensitivity: 'base' }) > 0) {
      return xml.slice(0, m.index) + block + xml.slice(m.index);
    }
  }
  const close = /^<\/(?:AxMenuItem(?:Action|Display|Output)|AxMenu)>/m.exec(xml);
  if (!close) return null;
  return xml.slice(0, close.index) + block + xml.slice(close.index);
}

function renderAccessLevel(level: SubscriberAccessLevel, indent: string, eol: string, childNs: string): string {
  const child = indent + (/^ +$/.test(indent) ? indent : '\t');
  const lines = SUBSCRIBER_PERMISSIONS.filter(p => level[p]).map(p => `${child}<${p}${childNs}>${level[p]}</${p}>`);
  if (lines.length === 0) return '';
  return `${indent}<SubscriberAccessLevel>${eol}${lines.join(eol)}${eol}${indent}</SubscriberAccessLevel>${eol}`;
}

function readAccessLevel(block: string): SubscriberAccessLevel {
  const level: SubscriberAccessLevel = {};
  for (const p of SUBSCRIBER_PERMISSIONS) {
    const v = new RegExp(`<${p}(?:\\s[^>]*)?>\\s*(Allow|Deny)\\s*</${p}>`).exec(block)?.[1];
    if (v === 'Allow' || v === 'Deny') level[p] = v;
  }
  return level;
}

/**
 * Give a new AxMenuItemAction/Display/Output the OperationalDomain and
 * SubscriberAccessLevel xppbp expects. Anything that is not a menu item comes
 * back unchanged.
 */
export function applyMenuItemBpDefaults(
  xml: string,
  properties?: Record<string, unknown>,
  options: { withDefaults?: boolean; allDataSourcesLocal?: boolean } = {},
): MenuItemBpResult {
  // modify-property sets only what it was asked for: no default fills the other property.
  const withDefaults = options.withDefaults !== false;
  const result: MenuItemBpResult = { xml, applied: [], unhonoured: [] };
  const root = /<(AxMenuItem(?:Action|Display|Output))[\s>]/.exec(xml);
  const kind = root ? menuItemKindOf(root[1]) : undefined;
  if (!kind) return result;

  const eol = /\r\n/.test(xml) ? '\r\n' : '\n';
  const indent = topIndent(xml);
  const objectType = /^[ \t]*<ObjectType>\s*([^<]*?)\s*<\/ObjectType>/m.exec(xml)?.[1];
  const defaults: BpDefaults = expectedMenuItemBpDefaults(kind, objectType, {
    allDataSourcesLocal: options.allDataSourcesLocal,
  });
  // Children of a property element leave the root's default namespace, as in every shipped file.
  const childNs = /<AxMenuItem\w+\b[^>]*\sxmlns="[^"]+"/.test(xml) ? ' xmlns=""' : '';
  let usedDefault = false;

  // ── OperationalDomain ──
  const odKey = findKey(properties, 'operationalDomain');
  const odRaw = odKey ? properties![odKey] : undefined;
  let odWanted = parseOperationalDomain(odRaw);
  if (odRaw !== undefined && odRaw !== null && !odWanted) {
    result.unhonoured.push(
      `operationalDomain=${String(odRaw)} — not a valid OperationalDomain (Company, Shared, Local); ` +
      `${defaults.operationalDomain} was written instead.`,
    );
  }
  const odExisting = findTopLevel(result.xml, indent, 'OperationalDomain');
  if (withDefaults && !odWanted && !odExisting) { odWanted = defaults.operationalDomain; usedDefault = true; }
  if (odWanted) {
    const line = `${indent}<OperationalDomain>${odWanted}</OperationalDomain>${eol}`;
    const current = odExisting ? /<OperationalDomain>\s*([^<]*?)\s*</.exec(odExisting[0])?.[1] : undefined;
    if (current !== odWanted) {
      const next = odExisting
        ? result.xml.slice(0, odExisting.index) + line + result.xml.slice(odExisting.index + odExisting[0].length)
        : insertAlphabetically(result.xml, indent, 'OperationalDomain', line);
      if (next) { result.xml = next; result.applied.push(`OperationalDomain=${odWanted}`); }
    }
  }

  // ── SubscriberAccessLevel ──
  const salKey = findKey(properties, 'subscriberAccessLevel');
  const salRaw = salKey ? properties![salKey] : undefined;
  let salWanted: SubscriberAccessLevel | undefined;
  if (salRaw !== undefined && salRaw !== null) {
    const parsed = parseSubscriberAccessLevel(salRaw);
    if (parsed.ok) salWanted = parsed.level;
    else result.unhonoured.push(`subscriberAccessLevel — ${parsed.error}`);
  }
  const salExisting = findTopLevel(result.xml, indent, 'SubscriberAccessLevel');
  if (withDefaults && !salWanted && !salExisting) { salWanted = defaults.subscriberAccessLevel; usedDefault = true; }
  if (salWanted) {
    const current = salExisting ? readAccessLevel(salExisting[0]) : {};
    if (!salExisting || !sameSubscriberAccessLevel(current, salWanted)) {
      const block = renderAccessLevel(salWanted, indent, eol, childNs);
      const next = salExisting
        ? result.xml.slice(0, salExisting.index) + block + result.xml.slice(salExisting.index + salExisting[0].length)
        : block ? insertAlphabetically(result.xml, indent, 'SubscriberAccessLevel', block) : result.xml;
      if (next) {
        result.xml = next;
        result.applied.push(`SubscriberAccessLevel=${describeSubscriberAccessLevel(salWanted)}`);
      }
    }
  }

  if (usedDefault && result.applied.length > 0) {
    result.reason = defaults.reason;
    if (options.allDataSourcesLocal && defaults.operationalDomain === 'Local' && kind === 'Display') result.domainExpected = true;
  }
  return result;
}

/** One line for the create response, or '' when nothing was written. */
export function renderMenuItemBpNote(r: MenuItemBpResult): string {
  const parts: string[] = [];
  if (r.applied.length > 0) {
    // xppbp names an expected SubscriberAccessLevel, but for OperationalDomain it
    // only requires one (BPCheckMenuItemOperationalDomainPropertyNotSpecified).
    const sal = r.applied.some(a => a.startsWith('SubscriberAccessLevel='));
    const od = r.applied.some(a => a.startsWith('OperationalDomain='));
    const why = r.reason
      ? ' (' +
        [
          sal ? `xppbp expects this SubscriberAccessLevel because ${r.reason}` : '',
          od && r.domainExpected ? `xppbp expects this OperationalDomain because ${r.reason}` : '',
          od && !r.domainExpected ? 'xppbp requires an OperationalDomain but names no value' : '',
        ].filter(Boolean).join('. ') +
        ').'
      : '.';
    parts.push(`\n📋 BP defaults: ${r.applied.join(', ')}${why}`);
  }
  if (r.unhonoured.length > 0) parts.push(`\n⚠️ ${r.unhonoured.join('\n⚠️ ')}`);
  return parts.join('');
}
