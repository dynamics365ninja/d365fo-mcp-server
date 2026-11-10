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

const XPP_STRING_LITERAL = /@"[^"]*"|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'/g;

/**
 * Whether a payload with no literal angle bracket was entity-encoded. A one-line
 * oldCode or a method without a doc comment has no angle bracket either, so the
 * entities in its string literals say nothing: `return "&lt;b&gt;";` is real X++.
 * Outside a literal, `&lt;`, `&gt;` and `&amp;` cannot be X++. In a comment line
 * only an encoded tag counts, since `&amp;` is correct in a doc comment and an
 * apostrophe in prose would read as the start of a literal.
 */
function hasEncodingEvidence(source: string): boolean {
  return source.split(/\r?\n/).some((line) => (/^\s*\/\//.test(line)
    ? /&(lt|gt);/.test(line)
    : /&(lt|gt|amp);/.test(line.replace(XPP_STRING_LITERAL, ''))));
}

/**
 * Decode XML entities from X++ source code — only when the payload was
 * entity-encoded, so real X++ round-trips byte for byte.
 *
 * An AI that copies code out of an SSRS report's entity-encoded <Text> block
 * sends `&lt;summary&gt;`, `a &lt; b`, `&amp;&amp;`; those must be decoded or
 * they land in the CDATA literally. But real X++ legitimately carries entities:
 * a `///` doc comment is XML, so "P&L" is written `P&amp;L` there, and string
 * literals that build XML or HTML hold `&lt;b&gt;`. Decoding those made the doc
 * comment malformed (BPXmlDocMalformed) and changed the strings.
 *
 * So the evidence decides:
 *  - no literal `<` or `>` anywhere, and an entity that cannot be X++ (see
 *    hasEncodingEvidence) → the whole payload was escaped once; undo exactly
 *    that escape.
 *  - literal angle brackets present → the payload is real X++. Only a `///`
 *    line whose tags were escaped and that has no literal tag gets its `&lt;` /
 *    `&gt;` repaired; its `&amp;` stays, because inside an XML doc comment
 *    `&amp;` is the correct spelling.
 *  - anything else is left alone: an entity inside a string literal, or a
 *    `&amp;` in a doc comment, is no evidence of encoding.
 * The xml2js carriage-return entity `&#xD;` is always stripped.
 *
 * Lives here, beside escapeXml, because it is that function's inverse — and
 * because its previous home was the modify TOOL, which made src/utils/
 * smartXmlBuilder.ts import from src/tools/ to reach it: a three-module cycle
 * running the wrong way across the layer boundary.
 */
export function decodeXmlEntitiesFromXppSource(source: string): string {
  const s = source.replace(/&#xD;/g, '');
  const hasLiteralAngle = /[<>]/.test(s);
  if (!hasLiteralAngle) {
    return hasEncodingEvidence(s) ? decodeStandardXmlEntities(s) : s;
  }
  return s.replace(/^([ \t]*\/\/\/)([^\r\n]*)$/gm, (line, lead: string, rest: string) =>
    /[<>]/.test(rest) || !/&(lt|gt);/.test(rest)
      ? line
      : lead + rest.replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}
