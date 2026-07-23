/**
 * Shared AxEdtExtension XML builder.
 *
 * Both createD365File.ts and generateD365Xml.ts delegate here so the two copies
 * cannot drift — the same reason queryViewXml.ts and mapXml.ts exist.
 *
 * An EDT extension owns no properties of its own: everything it changes about the
 * base EDT is an <AxPropertyModification> Name/Value pair. Shape and element order
 * are copied from the shipped elements, e.g.
 *   ApplicationSuite\Foundation\AxEdtExtension\DocuOverdueFineTxt_FR.Extension.xml
 *     <Name>, <ArrayElements />, <PropertyModifications>
 * All 13 EDT extensions shipped in PackagesLocalDirectory carry <ArrayElements />,
 * so it is emitted unconditionally. Element ORDER matters: the metadata
 * deserializer silently drops children it meets out of order.
 */

export interface AxPropertyModificationSpec {
  name: string;
  value: unknown;
}

/** Named shortcuts, in the order they are appended when the caller supplies them. */
const NAMED_PROPERTY_MODIFICATIONS: Array<[string, string]> = [
  ['label', 'Label'],
  ['helpText', 'HelpText'],
  ['stringSize', 'StringSize'],
  ['extends', 'Extends'],
  ['formHelp', 'FormHelp'],
];

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param name  Full extension element name, dot notation: BaseEdt.<Prefix>Extension
 * @param properties  label / helpText / stringSize / extends / formHelp, plus
 *   `propertyModifications: [{ name, value }]` as the escape hatch for anything
 *   not named above. An explicit entry wins over the named shortcut for the
 *   same property.
 */
export function buildAxEdtExtensionXml(
  name: string,
  properties?: Record<string, any>
): string {
  const mods: AxPropertyModificationSpec[] = [];
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
      modsXml += '\n\t\t<AxPropertyModification>';
      modsXml += `\n\t\t\t<Name>${escapeXmlText(m.name)}</Name>`;
      modsXml += `\n\t\t\t<Value>${escapeXmlText(String(m.value))}</Value>`;
      modsXml += '\n\t\t</AxPropertyModification>';
    }
    modsXml += '\n\t</PropertyModifications>';
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<AxEdtExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<ArrayElements />
${modsXml}
</AxEdtExtension>`;
}
