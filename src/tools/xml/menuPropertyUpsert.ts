/**
 * modify-property for a top-level scalar property of a menu item
 * (AxMenuItemDisplay / AxMenuItemAction / AxMenuItemOutput) or a menu (AxMenu)
 * that the C# bridge could not set.
 *
 * The bridge's SetAxMenuItemProperty() has a case for a handful of properties
 * (Label, HelpText, Object, ObjectType, OpenMode, NormalImage, ConfigurationKey,
 * CountryRegionCodes) and none for a menu. The generic XML fallback only replaces
 * an element that is in the file already, and a property at its default is not:
 * Parameters, EnumParameter, EnumTypeParameter, ImageLocation and the rest came
 * back as "Unknown AxMenuItem property" on every menu item that did not carry
 * them yet.
 *
 * Placement follows the serialiser. AxMenuItem* properties come alphabetically
 * after <Name> (see menuItemBpDefaults.ts). An AxMenu writes its scalar
 * properties the same way and its <Elements> collection last (Name, Label,
 * SetCompany, Elements). Both orders and both property lists below were checked
 * against the Microsoft standard menu items and menus.
 *
 * Only names this file lists are inserted. An element written under a name the
 * metamodel does not have is ignored on load, so the write would report success
 * and change nothing.
 */

import { findTopLevel, insertAlphabetically, topIndent } from './menuItemBpDefaults.js';

/**
 * Scalar properties of AxMenuItem, shared by the three kinds: the writable scalar
 * properties of the metamodel's AxMenuItem class (Microsoft.Dynamics.AX.Metadata,
 * read by reflection), which is a superset of the top-level elements the Microsoft
 * standard menu items carry. FormViewOption is used on Display items only, the
 * StateMachine* trio on Action items only. OperationalDomain and
 * SubscriberAccessLevel are missing on purpose: bpAccessPropertyModify.ts writes
 * them ahead of the bridge. Conflicts and Tags are not properties an agent sets.
 */
const MENU_ITEM_PROPERTIES = [
  'AllowRootNavigation',
  'ConfigurationKey',
  'CopyCallerQuery',
  'CorrectPermissions',
  'CountryConfigurationKey',
  'CountryRegionCodes',
  'CreatePermissions',
  'DeletePermissions',
  'DisabledImage',
  'DisabledImageLocation',
  'DisabledResource',
  'EnumParameter',
  'EnumTypeParameter',
  'ExtendedDataSecurity',
  'FeatureClass',
  'FormViewOption',
  'HelpText',
  'ImageLocation',
  'IsObsolete',
  'Label',
  'LinkedPermissionObject',
  'LinkedPermissionObjectChild',
  'LinkedPermissionType',
  'MaintainUserLicense',
  'MultiSelect',
  'NeedsRecord',
  'NormalImage',
  'NormalResource',
  'Object',
  'ObjectType',
  'OpenMode',
  'Parameters',
  'Query',
  'ReadPermissions',
  'ReportDesign',
  'StateMachine',
  'StateMachineDataSource',
  'StateMachineTransitionTo',
  'UpdatePermissions',
  'ViewUserLicense',
  'Visibility',
] as const;

/**
 * Scalar properties of the AxMenu root: the writable scalar properties of the
 * metamodel's AxMenu class besides Name and Elements (Conflicts and Tags left
 * out, as on menu items). Standard menus carry ConfigurationKey,
 * CountryRegionCodes, FeatureClass, IsObsolete, Label, MenuItemName, NormalImage
 * and SetCompany at the top level, all of them in alphabetical order before
 * <Elements>.
 */
const MENU_PROPERTIES = [
  'ConfigurationKey',
  'CountryRegionCodes',
  'DisabledImage',
  'DisabledImageLocation',
  'FeatureClass',
  'ImageLocation',
  'IsObsolete',
  'Label',
  'MenuItemName',
  'MenuItemType',
  'NormalImage',
  'Parameters',
  'SetCompany',
  'ShortCut',
  'Visibility',
] as const;

/**
 * The bridge checks these against the metamodel enum and names the legal values
 * when it refuses one. They stay with the bridge and the generic fallback, so a
 * value the bridge just rejected is not written here behind its back.
 */
const BRIDGE_VALIDATED = new Set(['objecttype', 'openmode']);

/** An AxMenu's collection, written after every scalar property. */
const MENU_TRAILING = ['Elements'] as const;

export type MenuPropertyRoot = 'AxMenuItemDisplay' | 'AxMenuItemAction' | 'AxMenuItemOutput' | 'AxMenu';

export type MenuPropertyUpsertResult =
  | {
      ok: true;
      xml: string;
      changed: boolean;
      root: MenuPropertyRoot;
      /** "Parameters='Posted'", or "Parameters" when it was removed. */
      written: string;
      /** How it was written, for the reply. */
      detail: string;
    }
  | { ok: false; error: string };

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The document's root element when it is a menu item or a menu (never one of their extensions). */
function menuRootOf(xml: string): MenuPropertyRoot | undefined {
  // A comment body is `(?:[^-]|-(?!->))*`, not `[\s\S]*?`: the lazy form inside the
  // repeated group can split "--><!--" either way and backtracks exponentially.
  const root = /^(?:\s*<\?xml[^>]*\?>)?(?:\s*<!--(?:[^-]|-(?!->))*-->)*\s*<(\w+)[\s>]/.exec(xml)?.[1];
  return root === 'AxMenuItemDisplay' || root === 'AxMenuItemAction' || root === 'AxMenuItemOutput' || root === 'AxMenu'
    ? root
    : undefined;
}

/** The properties this writer sets on `root`, in canonical casing. */
export function menuPropertiesOf(root: MenuPropertyRoot): readonly string[] {
  return root === 'AxMenu' ? MENU_PROPERTIES : MENU_ITEM_PROPERTIES;
}

/**
 * Set one top-level scalar property on a menu item or menu document: replace the
 * element when it is there, insert it in serialiser order when it is not. An
 * empty value removes the element, since a property at its default is expressed
 * by absence (as directXmlClearEmptyProperty does after a bridge write).
 *
 * Undefined means "not mine", and the caller carries on with the generic path:
 * another document, a nested path, a property the bridge validates, or a name
 * outside the list whose element is in the file already. A name outside the list
 * that the file does not have is refused with the list.
 */
export function upsertMenuProperty(
  xml: string,
  propertyPath: string,
  value: string,
): MenuPropertyUpsertResult | undefined {
  const root = menuRootOf(xml);
  if (!root) return undefined;
  const asked = propertyPath.trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(asked)) return undefined;
  if (BRIDGE_VALIDATED.has(asked.toLowerCase())) return undefined;

  const known = menuPropertiesOf(root);
  const name = known.find(p => p.toLowerCase() === asked.toLowerCase());
  const indent = topIndent(xml);
  if (!name) {
    // In the file already (on a menu, possibly on one of its elements): the generic
    // replacement serves it, as it always has.
    if (new RegExp(`<${asked}[\\s/>]`).test(xml)) return undefined;
    return {
      ok: false,
      error:
        `'${asked}' is not an ${root} property this writer can add. Known properties: ${known.join(', ')}` +
        (root === 'AxMenu' ? '' : ', OperationalDomain, SubscriberAccessLevel') +
        '.',
    };
  }

  const eol = /\r\n/.test(xml) ? '\r\n' : '\n';
  const existing = findTopLevel(xml, indent, name);
  const text = escapeText(value);

  if (value.trim() === '') {
    if (!existing) {
      return { ok: true, xml, changed: false, root, written: name, detail: 'not in the file, which is the default, nothing written' };
    }
    return {
      ok: true,
      xml: xml.slice(0, existing.index) + xml.slice(existing.index + existing[0].length),
      changed: true,
      root,
      written: name,
      detail: 'element removed, the default is expressed by absence',
    };
  }

  const written = `${name}='${value}'`;
  const line = `${indent}<${name}>${text}</${name}>${eol}`;
  if (existing) {
    const current = new RegExp(`<${name}>([^<]*)</${name}>`).exec(existing[0])?.[1];
    if (current === text) {
      return { ok: true, xml, changed: false, root, written, detail: 'already in that state, nothing written' };
    }
    return {
      ok: true,
      xml: xml.slice(0, existing.index) + line + xml.slice(existing.index + existing[0].length),
      changed: true,
      root,
      written,
      detail: 'existing element replaced',
    };
  }

  const inserted = insertAlphabetically(xml, indent, name, line, root === 'AxMenu' ? MENU_TRAILING : []);
  if (inserted === null) return { ok: false, error: `Could not place ${name} in this ${root} file.` };
  return {
    ok: true,
    xml: inserted,
    changed: true,
    root,
    written,
    detail:
      root === 'AxMenu'
        ? 'the element did not exist, inserted alphabetically ahead of <Elements>'
        : 'the element did not exist, inserted in alphabetical order after Name',
  };
}
