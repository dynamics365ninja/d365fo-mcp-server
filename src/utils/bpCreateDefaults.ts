/**
 * The OperationalDomain and SubscriberAccessLevel values xppbp expects on a NEW
 * table or menu item.
 *
 * Neither property is written by Visual Studio's "new item" templates for menu
 * items, and VS writes only SubscriberAccessLevel Read=Allow on a new table. The
 * best-practice checker then reports every object it finds without them:
 *
 *   BPCheckTableOperationalDomainPropertyNotSpecified / …Unexpected
 *   BPCheckTableSubscriberAccessLevelPropertyNotSpecified / …Unexpected
 *   BPCheckMenuItemOperationalDomainPropertyNotSpecified
 *   BPCheckMenuItemSubscriberAccessLevelPropertyNotSpecified / …Unexpected
 *
 * The expected values below are the ones the checker names in its own messages,
 * read from an xppbp log over a real ISV model (one message per rule branch):
 *
 *   Table
 *     "The Expected value for OperationalDomain property is Local, because the value for property TableType is TempDB."   (also InMemory)
 *     "The Expected value for OperationalDomain property is Local, because the value for property TableGroup is Staging."
 *     "The Expected value for OperationalDomain property is Company, because the value for property SaveDataPerCompany is Yes."
 *     "The Expected value for OperationalDomain property is Shared, because the value for property SaveDataPerCompany is No."
 *     "The Expected value for SubscriberAccessLevel property is No Access, because the value for property TableType is TempDB." (also InMemory)
 *     "The Expected value for SubscriberAccessLevel property is No Access, because the value for property TableGroup is Staging."
 *     "The Expected value for SubscriberAccessLevel property is Read, because the value for property SubscriberAccessLevel is Unset."
 *   Menu item
 *     "The Expected value for SubscriberAccessLevel property is No Access, because the menu item type is Action and ObjectType is Class."
 *     "The Expected value for SubscriberAccessLevel property is Read/Update/Create/Correct/Delete/Invoke, because the menu item type is Display and ObjectType is Class."
 *
 * Staging and TempDB/InMemory win over SaveDataPerCompany: a staging table with
 * SaveDataPerCompany=No is still expected to be Local. A Display menu item on a
 * form carrying Read=Allow passed the checker, as did one on a class.
 *
 * For a menu item the checker names no expected OperationalDomain, it only
 * requires one. The defaults follow what shipped menu items pair with each access
 * level: Local with No Access (84 of 161 shipped Action/Class items), Shared with
 * Read (113 of 136 shipped Display/Form items that grant Read).
 *
 * "No Access" is all six AccessGrant permissions set to Deny, as every shipped
 * object that has it writes it (e.g. the BatchRun action menu item).
 */

import {
  SUBSCRIBER_PERMISSIONS,
  type SubscriberAccessLevel,
} from './subscriberAccessLevel.js';

/** The legal OperationalDomain values, as shipped metadata spells them. */
export const OPERATIONAL_DOMAINS = ['Company', 'Shared', 'Local'] as const;
export type OperationalDomain = (typeof OPERATIONAL_DOMAINS)[number];

/** "No Access": every permission denied. */
export const NO_ACCESS: SubscriberAccessLevel = Object.fromEntries(
  SUBSCRIBER_PERMISSIONS.map(p => [p, 'Deny']),
) as SubscriberAccessLevel;

/** "Read/Update/Create/Correct/Delete/Invoke": every permission allowed. */
export const FULL_ACCESS: SubscriberAccessLevel = Object.fromEntries(
  SUBSCRIBER_PERMISSIONS.map(p => [p, 'Allow']),
) as SubscriberAccessLevel;

/** "Read": what xppbp expects on a regular table. */
export const READ_ACCESS: SubscriberAccessLevel = { Read: 'Allow' };

/** The table properties the rules read. Values as written in XML, or undefined when absent. */
export interface TableBpInputs {
  tableType?: string;
  tableGroup?: string;
  saveDataPerCompany?: string;
}

export interface BpDefaults {
  operationalDomain: OperationalDomain;
  subscriberAccessLevel: SubscriberAccessLevel;
  /** The rule that decided it, in the checker's own words. */
  reason: string;
}

/** Whether a table is one the checker keeps away from subscribers (TempDB, InMemory, Staging). */
function isLocalOnlyTable(t: TableBpInputs): string | undefined {
  const type = (t.tableType ?? '').trim();
  if (/^(TempDB|InMemory)$/i.test(type)) return `TableType is ${/^tempdb$/i.test(type) ? 'TempDB' : 'InMemory'}`;
  if (/^staging$/i.test((t.tableGroup ?? '').trim())) return 'TableGroup is Staging';
  return undefined;
}

/** What xppbp expects on a table with these properties. */
export function expectedTableBpDefaults(t: TableBpInputs): BpDefaults {
  const localOnly = isLocalOnlyTable(t);
  if (localOnly) {
    return { operationalDomain: 'Local', subscriberAccessLevel: { ...NO_ACCESS }, reason: localOnly };
  }
  // SaveDataPerCompany defaults to Yes: the serializer omits it.
  const perCompany = !/^(no|false|0)$/i.test((t.saveDataPerCompany ?? '').trim());
  return {
    operationalDomain: perCompany ? 'Company' : 'Shared',
    subscriberAccessLevel: { ...READ_ACCESS },
    reason: `SaveDataPerCompany is ${perCompany ? 'Yes' : 'No'}`,
  };
}

/** Read the rule inputs from an AxTable document's own property block. */
export function tableBpInputsFromXml(xml: string): TableBpInputs {
  const block = xml.slice(0, propertyBlockEnd(xml));
  const read = (el: string) => new RegExp(`^[ \\t]*<${el}>\\s*([^<]*?)\\s*</${el}>`, 'm').exec(block)?.[1];
  return {
    tableType: read('TableType'),
    tableGroup: read('TableGroup'),
    saveDataPerCompany: read('SaveDataPerCompany'),
  };
}

/** Where an AxTable's property block ends: the first collection element. */
function propertyBlockEnd(xml: string): number {
  const m = /^[ \t]*<(DeleteActions|FieldGroups|Fields|FullTextIndexes|Indexes|Mappings|Relations|StateMachines)[\s/>]/m.exec(xml);
  return m ? m.index : xml.length;
}

export type MenuItemKind = 'Action' | 'Display' | 'Output';

/**
 * What xppbp expects on a menu item. `objectType` is the menu item's ObjectType
 * element; an absent one is a Display item's default, Form.
 */
export function expectedMenuItemBpDefaults(kind: MenuItemKind, objectType?: string): BpDefaults {
  const ot = (objectType ?? '').trim() || (kind === 'Display' ? 'Form' : 'Class');
  if (kind === 'Action') {
    return {
      operationalDomain: 'Local',
      subscriberAccessLevel: { ...NO_ACCESS },
      reason: `the menu item type is Action and ObjectType is ${ot}`,
    };
  }
  if (kind === 'Display' && /^class$/i.test(ot)) {
    return {
      operationalDomain: 'Shared',
      subscriberAccessLevel: { ...FULL_ACCESS },
      reason: 'the menu item type is Display and ObjectType is Class',
    };
  }
  return {
    operationalDomain: 'Shared',
    subscriberAccessLevel: { ...READ_ACCESS },
    reason: `the menu item type is ${kind} and ObjectType is ${ot}`,
  };
}

/** The canonical spelling of an OperationalDomain value, or undefined when it is not one. */
export function parseOperationalDomain(raw: unknown): OperationalDomain | undefined {
  if (typeof raw !== 'string') return undefined;
  return OPERATIONAL_DOMAINS.find(d => d.toLowerCase() === raw.trim().toLowerCase());
}

/** The menu item kind for a root element or objectType, or undefined for anything else. */
export function menuItemKindOf(rootOrObjectType: string): MenuItemKind | undefined {
  const m = /^(?:AxMenuItem|menu-item-)(action|display|output)$/i.exec(rootOrObjectType.trim());
  if (!m) return undefined;
  return (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()) as MenuItemKind;
}
