/**
 * The token scan that replaced two comment-stripping `replace()` calls.
 *
 * These exist because the last shared text utility to ship without tests — the
 * X++ lexer — had a documented contract ("delimiters survive") that was false
 * for the block-comment close delimiter, and nobody noticed until a rule
 * matched nothing. The branch that
 * matters most here is the UNTERMINATED comment: without it the scan slides one
 * character forward and reads an element out of the comment, which is the exact
 * bug the strip had (CodeQL js/incomplete-multi-character-sanitization, raised
 * against the eval oracle in 228fb58 and again against the write guards).
 */

import { describe, it, expect } from 'vitest';
import { firstLeafText, scanXmlLeaves } from '../../src/utils/xmlScan';

const TABLE = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoRentLine</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoRentLine extends common
{
\t// <Name>NotAnIdentity</Name> — markup inside X++ source
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>@Contoso:Line</Label>
\t<CacheLookup>None</CacheLookup>
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>RentLineId</Name>
\t\t</AxTableField>
\t</Fields>
</AxTable>
`;

describe('scanXmlLeaves', () => {
  it('reports a child of the root at depth 1 and a nested one deeper', () => {
    const leaves = scanXmlLeaves(TABLE);
    const depth1 = leaves.filter(l => l.depth === 1).map(l => l.name);
    expect(depth1).toEqual(['Name', 'Label', 'CacheLookup']);

    const nested = leaves.find(l => l.name === 'Name' && l.depth > 1);
    expect(nested?.text).toBe('RentLineId');
    expect(nested?.depth).toBe(3);
  });

  it('consumes CDATA whole, so X++ that looks like markup changes nothing', () => {
    // The <Name> inside the declaration is a comment in X++ source, and there is
    // an unbalanced `{` in there too. Neither may reach the depth count.
    expect(firstLeafText(TABLE, 'Name')).toBe('ConDemoRentLine');
    // No <Name> element was read out of the source, and the depth count is
    // undisturbed by the unbalanced brace and the markup-shaped comment in it.
    expect(scanXmlLeaves(TABLE).filter(l => l.name === 'Name').map(l => l.text.trim()))
      .toEqual(['ConDemoRentLine', 'RentLineId']);
    // The declaration itself IS a leaf, and its text is the CDATA verbatim —
    // consumed as one token rather than parsed as markup.
    const declaration = scanXmlLeaves(TABLE).find(l => l.name === 'Declaration');
    expect(declaration?.text).toContain('public class ConDemoRentLine extends common');
  });

  it('ignores an element inside a comment', () => {
    const xml = '<AxTable>\n\t<!-- <Name>Commented</Name> -->\n\t<Name>Real</Name>\n</AxTable>';
    expect(firstLeafText(xml, 'Name')).toBe('Real');
  });

  it('stops at an UNTERMINATED comment instead of reading through it', () => {
    // The branch the whole file exists for. A strip-then-match implementation
    // leaves the `<!--` in place and happily returns "Commented" here.
    const xml = '<AxTable>\n\t<!-- <Name>Commented</Name>\n\t<Name>Real</Name>\n</AxTable>';
    expect(firstLeafText(xml, 'Name')).toBeUndefined();
    expect(scanXmlLeaves(xml)).toEqual([]);
  });

  it('stops at an unterminated CDATA or processing instruction too', () => {
    expect(firstLeafText('<AxTable>\n\t<![CDATA[ <Name>X</Name>', 'Name')).toBeUndefined();
    expect(firstLeafText('<AxTable>\n\t<?php <Name>X</Name>', 'Name')).toBeUndefined();
  });

  it('treats a self-closing element as empty, not as a leaf with a value', () => {
    const leaves = scanXmlLeaves('<AxTable>\n\t<Fields />\n\t<Label>L</Label>\n</AxTable>');
    expect(leaves.map(l => l.name)).toEqual(['Label']);
  });

  it('does not mistake an attribute value for structure', () => {
    const xml = '<AxTable>\n\t<Label desc="</Label><Name>Injected</Name>">L</Label>\n</AxTable>';
    expect(firstLeafText(xml, 'Name')).toBeUndefined();
  });

  it('survives an empty or malformed document without throwing', () => {
    expect(scanXmlLeaves('')).toEqual([]);
    expect(scanXmlLeaves('not xml at all')).toEqual([]);
    expect(scanXmlLeaves('</AxTable>')).toEqual([]);
  });
});
