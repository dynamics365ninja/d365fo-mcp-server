/**
 * The single XML escaper for every metadata builder.
 *
 * Most builders in src/tools interpolate caller-supplied strings straight into
 * XML template literals. Labels, descriptions, help text and developer
 * documentation are free text, so an ampersand or angle bracket in any of them
 * (`label: "Purchases & Sales"`) writes malformed XML into
 * PackagesLocalDirectory — and the create path adds the file to the .rnrproj
 * before anything parses it, so the failure surfaces much later as an
 * unexplained build break.
 *
 * Before this module five builders carried their own private copy of the
 * escaper and disagreed about what to escape, while the rest escaped nothing at
 * all. Import from here instead of writing a sixth.
 *
 * IMPORTANT: escaping is not idempotent — `&` becomes `&amp;`, so applying it
 * twice yields `&amp;amp;`. Escape at the point where a raw value enters XML,
 * never on a fragment that is already XML.
 */

/**
 * Escape a value for use as XML **text content**.
 *
 * Only `&`, `<` and `>` are escaped, matching what the Microsoft metadata
 * serializer emits for text nodes — escaping quotes here too would round-trip
 * correctly but make our files differ needlessly from shipped ones.
 */
export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a value for use inside a double-quoted XML **attribute**.
 * Adds `"` to the text-content set so the attribute cannot be terminated early.
 */
export function escapeXmlAttr(value: unknown): string {
  return escapeXml(value).replace(/"/g, '&quot;');
}
