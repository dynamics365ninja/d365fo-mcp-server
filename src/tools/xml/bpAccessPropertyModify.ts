/**
 * modify-property for OperationalDomain and SubscriberAccessLevel on an existing
 * table or menu item.
 *
 * Both properties are what xppbp checks on every table and menu item
 * (BPCheckTableOperationalDomainProperty*, BPCheckTableSubscriberAccessLevelProperty*,
 * BPCheckMenuItemOperationalDomainPropertyNotSpecified,
 * BPCheckMenuItemSubscriberAccessLevelProperty*). New objects get them from the
 * create reconcile (src/utils/bpCreateDefaults.ts). Objects that already exist
 * could not be fixed: the C# bridge's property setter has no case for either on a
 * menu item, SubscriberAccessLevel holds child elements no scalar writer can
 * express, and the bridge result for a table depended on the bridge build.
 *
 * So these two properties are written here, on the XML, for both object kinds,
 * and never handed to the bridge. The same writers place them as the create path
 * does: AxTable in its canonical element order (after Label), AxMenuItem* in
 * alphabetical order after Name, with `xmlns=""` on the access level's children.
 * An existing element is replaced, never duplicated.
 */

import {
  expectedMenuItemBpDefaults,
  expectedTableBpDefaults,
  menuItemKindOf,
  parseOperationalDomain,
  tableBpInputsFromXml,
  type BpDefaults,
} from '../../utils/bpCreateDefaults.js';
import { upsertAxTableProperty, upsertAxTableSubscriberAccessLevel } from '../../utils/axTablePropertyOrder.js';
import {
  describeSubscriberAccessLevel,
  readSubscriberAccessLevel,
  sameSubscriberAccessLevel,
  subscriberAccessLevelValue,
  type SubscriberAccessLevel,
} from '../../utils/subscriberAccessLevel.js';
import { applyMenuItemBpDefaults } from './menuItemBpDefaults.js';

export type BpAccessProperty = 'OperationalDomain' | 'SubscriberAccessLevel';

/** The object types this writer serves. */
export function isBpAccessObjectType(objectType: string): boolean {
  return objectType === 'table' || menuItemKindOf(objectType) !== undefined;
}

/** The property a propertyPath names, when it is one of the two (bare name, any case). */
export function bpAccessPropertyOf(propertyPath: string): BpAccessProperty | undefined {
  const p = propertyPath.trim().toLowerCase();
  if (p === 'operationaldomain') return 'OperationalDomain';
  if (p === 'subscriberaccesslevel') return 'SubscriberAccessLevel';
  return undefined;
}

export type BpAccessModifyResult =
  | { ok: true; xml: string; changed: boolean; written: string; bpNote?: string }
  | { ok: false; error: string };

function readOperationalDomain(xml: string): string | undefined {
  return /^[ \t]*<OperationalDomain>\s*([^<]*?)\s*<\/OperationalDomain>/m.exec(xml)?.[1];
}

/**
 * A hint when the value written is not the one xppbp expects for this object.
 * Menu items get none for OperationalDomain: xppbp only requires one there
 * (BPCheckMenuItemOperationalDomainPropertyNotSpecified) and names no value. A
 * Display item on a class passes with any permission allowed.
 */
function bpNoteFor(
  property: BpAccessProperty,
  xml: string,
  expected: BpDefaults,
  level?: SubscriberAccessLevel,
  menu?: { displayOnClass: boolean },
): string | undefined {
  if (property === 'OperationalDomain') {
    if (menu) return undefined;
    const now = readOperationalDomain(xml);
    if (now === expected.operationalDomain) return undefined;
    return `xppbp expects OperationalDomain=${expected.operationalDomain} here (${expected.reason}).`;
  }
  if (level && sameSubscriberAccessLevel(level, expected.subscriberAccessLevel)) return undefined;
  if (menu?.displayOnClass && level && Object.values(level).includes('Allow')) return undefined;
  return (
    `xppbp expects SubscriberAccessLevel ${describeSubscriberAccessLevel(expected.subscriberAccessLevel)} ` +
    `here (${expected.reason}).`
  );
}

/**
 * Set OperationalDomain or SubscriberAccessLevel on an AxTable or AxMenuItem*
 * document. Returns undefined for any other document, so the caller can fall
 * through to the generic property path.
 */
export function setBpAccessProperty(
  xml: string,
  property: BpAccessProperty,
  rawValue: unknown,
): BpAccessModifyResult | undefined {
  const isTable = /<AxTable[\s>]/.test(xml);
  const menuRoot = /<(AxMenuItem(?:Action|Display|Output))[\s>]/.exec(xml);
  const kind = menuRoot ? menuItemKindOf(menuRoot[1]) : undefined;
  if (!isTable && !kind) return undefined;

  const objectType = kind ? /^[ \t]*<ObjectType>\s*([^<]*?)\s*<\/ObjectType>/m.exec(xml)?.[1] : undefined;
  const expected = kind ? expectedMenuItemBpDefaults(kind, objectType) : expectedTableBpDefaults(tableBpInputsFromXml(xml));
  const menu = kind ? { displayOnClass: kind === 'Display' && /^class$/i.test(objectType ?? '') } : undefined;

  if (property === 'OperationalDomain') {
    const domain = parseOperationalDomain(rawValue);
    if (!domain) {
      return {
        ok: false,
        error: `Invalid OperationalDomain ${JSON.stringify(rawValue)}. Use Company, Shared or Local.`,
      };
    }
    let next: string | null;
    if (isTable) {
      next = upsertAxTableProperty(xml, 'OperationalDomain', domain);
    } else {
      const r = applyMenuItemBpDefaults(xml, { operationalDomain: domain }, { withDefaults: false });
      next = r.xml;
    }
    if (next === null) return { ok: false, error: 'Could not place OperationalDomain in this file.' };
    return {
      ok: true,
      xml: next,
      changed: next !== xml,
      written: `OperationalDomain=${domain}`,
      bpNote: bpNoteFor(property, next, expected, undefined, menu),
    };
  }

  const parsed = subscriberAccessLevelValue(rawValue);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let next: string | null;
  if (isTable) {
    next = upsertAxTableSubscriberAccessLevel(xml, parsed.level);
  } else {
    const r = applyMenuItemBpDefaults(xml, { subscriberAccessLevel: parsed.level }, { withDefaults: false });
    if (r.unhonoured.length > 0) return { ok: false, error: r.unhonoured.join(' ') };
    next = r.xml;
  }
  if (next === null) return { ok: false, error: 'Could not place SubscriberAccessLevel in this file.' };
  const level = isTable ? readSubscriberAccessLevel(next) : parsed.level;
  return {
    ok: true,
    xml: next,
    changed: next !== xml,
    written: `SubscriberAccessLevel=${describeSubscriberAccessLevel(parsed.level)}`,
    bpNote: bpNoteFor(property, next, expected, level, menu),
  };
}
