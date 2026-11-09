/**
 * decodeXmlEntitiesFromXppSource must round-trip real X++ exactly.
 *
 * A `///` doc comment is XML, so an ampersand in it is written `&amp;`
 * ("/// <summary>Builds the P&amp;L.</summary>"). Decoding that to a bare `&`
 * made the comment malformed XML (BPXmlDocMalformed) on every add-method and
 * replace-code. X++ string literals that build XML or HTML ("&lt;b&gt;") were
 * corrupted the same way. The decode exists only for a payload that arrives
 * entity-encoded as a whole (copied out of an SSRS <Text> block), so it now
 * runs only when the payload carries no literal angle bracket at all, plus a
 * narrow per-line repair for a doc-comment line whose tags were escaped.
 */
import { describe, it, expect } from 'vitest';
import { decodeXmlEntitiesFromXppSource as decode } from '../../src/utils/xmlEscape.js';

describe('decodeXmlEntitiesFromXppSource', () => {
  it('keeps &amp; inside a doc comment (the P&L case)', () => {
    const src = [
      '/// <summary>',
      '/// Returns the P&amp;L amount for the deal.',
      '/// </summary>',
      'public AmountMST plAmount()',
      '{',
      '    return 0;',
      '}',
    ].join('\n');
    expect(decode(src)).toBe(src);
  });

  it('keeps entities in X++ string literals that build markup', () => {
    const src = '/// <summary>Wraps the text in bold.</summary>\npublic str bold(str _s)\n{\n    return "&lt;b&gt;" + _s + "&lt;/b&gt;";\n}';
    expect(decode(src)).toBe(src);
  });

  it('keeps a method with literal && and < untouched', () => {
    const src = 'void run()\n{\n    if (a < b && c > d) { info("x"); }\n}';
    expect(decode(src)).toBe(src);
  });

  it('decodes a payload that arrived entity-encoded as a whole', () => {
    const encoded =
      '/// &lt;summary&gt;\n/// Returns the P&amp;amp;L.\n/// &lt;/summary&gt;\n' +
      'void run()\n{\n    if (a &lt; b &amp;&amp; c) { info(&quot;x&quot;); }\n}';
    expect(decode(encoded)).toBe(
      '/// <summary>\n/// Returns the P&amp;L.\n/// </summary>\n' +
      'void run()\n{\n    if (a < b && c) { info("x"); }\n}',
    );
  });

  it('repairs an escaped doc-comment tag line in otherwise literal code, keeping &amp;', () => {
    const src = '/// &lt;summary&gt;P&amp;L&lt;/summary&gt;\nvoid run()\n{\n    if (a < b) {}\n}';
    expect(decode(src)).toBe('/// <summary>P&amp;L</summary>\nvoid run()\n{\n    if (a < b) {}\n}');
  });

  it('still strips the &#xD; carriage-return entity', () => {
    expect(decode('void run()&#xD;\n{\n}')).toBe('void run()\n{\n}');
  });

  it('leaves code with no angle brackets and a lone &amp; alone (no evidence of encoding)', () => {
    const src = 'str t()\n{\n    return "Q&amp;A";\n}';
    expect(decode(src)).toBe(src);
  });
});
