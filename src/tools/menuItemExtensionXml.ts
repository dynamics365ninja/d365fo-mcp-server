/**
 * Shared AxMenuItem{Display,Action,Output}Extension XML builder.
 *
 * Both createD365File.ts and generateD365Xml.ts delegate here so the two copies
 * cannot drift — the same reason edtExtensionXml.ts exists.
 *
 * Regression: all three menu-item extension objectTypes went through
 * generateAxSimpleExtensionXml(rootElement, name), which takes no `properties`
 * at all. A menu-item extension changes the base menu item ONLY through
 * property modifications, so dropping `properties` left the objectType with no
 * grounded path whatsoever — the element came out as an inert
 *     <AxMenuItemActionExtension><Name>…</Name><PropertyModifications /></…>
 * that builds green and changes nothing.
 *
 * Shape is pinned against the shipped elements — the only four in
 * PackagesLocalDirectory are
 *   MasterPlanningService\MasterPlanningService\AxMenuItemActionExtension\*.xml
 * and 4/4 carry BOTH the `Microsoft.Dynamics.AX.Metadata.V1` default namespace
 * on the root AND `xmlns=""` on each <AxPropertyModification>, unlike
 * AxEdtExtension which ships without either. The two are a pair: the reset on
 * the child is what puts it back in no-namespace. They are reproduced verbatim
 * rather than normalised to the EdtExtension shape, because these four files are
 * the only ground truth that exists for this element type.
 */

export interface AxMenuItemPropertyModificationSpec {
  name: string;
  value: unknown;
}

/**
 * Named shortcuts, in the order they are appended when the caller supplies them.
 * `object` is the property all four shipped extensions modify.
 */
const NAMED_PROPERTY_MODIFICATIONS: Array<[string, string]> = [
  ['object', 'Object'],
  ['label', 'Label'],
  ['helpText', 'HelpText'],
  ['enumTypeParameter', 'EnumTypeParameter'],
  ['enumParameter', 'EnumParameter'],
  ['parameters', 'Parameters'],
  ['configurationKey', 'ConfigurationKey'],
  ['needsRecord', 'NeedsRecord'],
  ['visible', 'Visible'],
];

export type AxMenuItemExtensionRootElement =
  | 'AxMenuItemDisplayExtension'
  | 'AxMenuItemActionExtension'
  | 'AxMenuItemOutputExtension';

import { escapeXml as escapeXmlText } from '../utils/xmlEscape.js';

/**
 * @param rootElement  AxMenuItem{Display,Action,Output}Extension
 * @param name  Full extension element name, dot notation: BaseMenuItem.<Prefix>Extension
 * @param properties  the named shortcuts above, plus
 *   `propertyModifications: [{ name, value }]` as the escape hatch for anything
 *   not named. An explicit entry wins over the named shortcut for the same
 *   property.
 */
export function buildAxMenuItemExtensionXml(
  rootElement: AxMenuItemExtensionRootElement,
  name: string,
  properties?: Record<string, any>
): string {
  const mods: AxMenuItemPropertyModificationSpec[] = [];
  const push = (modName: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (mods.some(m => m.name.toLowerCase() === modName.toLowerCase())) return;
    mods.push({ name: modName, value });
  };

  const explicit = properties?.propertyModifications;
  if (Array.isArray(explicit)) {
    for (const m of explicit) {
      if (m && m.name !== undefined && m.name !== null && String(m.name) !== '') {
        push(String(m.name), m.value);
      }
    }
  }
  for (const [propKey, modName] of NAMED_PROPERTY_MODIFICATIONS) {
    push(modName, properties?.[propKey]);
  }

  let modsXml: string;
  if (mods.length === 0) {
    modsXml = '\t<PropertyModifications />';
  } else {
    modsXml = '\t<PropertyModifications>';
    for (const m of mods) {
      modsXml += '\n\t\t<AxPropertyModification xmlns="">';
      modsXml += `\n\t\t\t<Name>${escapeXmlText(m.name)}</Name>`;
      modsXml += `\n\t\t\t<Value>${escapeXmlText(String(m.value))}</Value>`;
      modsXml += '\n\t\t</AxPropertyModification>';
    }
    modsXml += '\n\t</PropertyModifications>';
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<${rootElement} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
${modsXml}
</${rootElement}>`;
}
