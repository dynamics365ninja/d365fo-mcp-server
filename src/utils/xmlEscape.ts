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

/**
 * Decode the standard XML entities (&lt;, &gt;, &apos;, &quot;, &amp;) and
 * normalise line endings by stripping xml2js's &#xD; representation of carriage
 * return.
 *
 * `&amp;` is decoded LAST so that a sequence like `&amp;quot;` first becomes
 * `&quot;` and can then be decoded to `"` — decoding it first would
 * double-unescape.
 */
function decodeStandardXmlEntities(source: string): string {
  return source
    // xml2js Builder escapes \r as &#xD; — strip it to normalise to LF-only line endings
    .replace(/&#xD;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Decode XML entities from X++ source code.
 *
 * X++ source should never contain entity-encoded characters — `/// <summary>`
 * doc comments, generic types like `List<str>`, and comparison operators like
 * `x < y` all use literal `<` and `>`. When an AI model copies code from an
 * SSRS report's entity-encoded <Text> block and passes it as `methodCode`, the
 * entities would otherwise survive into the CDATA section and corrupt the source.
 *
 * Lives here, beside escapeXml, because it is that function's inverse — and
 * because its previous home was the modify TOOL, which made src/utils/
 * smartXmlBuilder.ts import from src/tools/ to reach it: a three-module cycle
 * running the wrong way across the layer boundary.
 */
export function decodeXmlEntitiesFromXppSource(source: string): string {
  return decodeStandardXmlEntities(source);
}
