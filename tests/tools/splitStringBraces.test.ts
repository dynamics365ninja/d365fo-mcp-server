/**
 * A brace inside a string literal or a comment must not change the class split.
 *
 * splitXppClassSource and extractInnerClassMethods matched '{' and '}' by
 * counting them in the raw text. Strings often hold a lone brace — an MT940
 * parser searches for '{4:', the start of the message text block — and that '{'
 * was counted as an opening brace. The method body then never closed, the loop
 * stopped, and every method after it was dropped. `d365fo_file(action="create")` reported success, and the
 * missing methods turned up only later.
 *
 * Braces are now matched on maskXpp()'s copy of the source, and a '{' that
 * really is never closed is an error instead of a partial split.
 */
import { describe, expect, it } from 'vitest';
import { XmlTemplateGenerator, XppSplitError } from '../../src/tools/xml/xmlTemplateGenerator.js';
import { renderEquivalentModifyCall } from '../../src/tools/write/createD365File.js';

const split = (src: string) => XmlTemplateGenerator.splitXppClassSource(src);
const names = (src: string) => split(src).methods.map(m => m.name);

describe('splitXppClassSource — braces inside literals and comments', () => {
  it('keeps every method after an unbalanced { in a single-quoted string', () => {
    // An MT940 message starts with header blocks; '{4:' opens the text block.
    // The BIC CNTSUS30 is made up (a '0' as the 2nd location character marks a
    // test BIC), as are the session and sequence numbers.
    const src = `class ContosoMT940ParserTest extends SysTestCase
{
    str message;
}

public void setUp()
{
    message = '{1:F01CNTSUS30AXXX1234123456}{2:O940CNTSUS30AXXXN}{4:';
}

public void testFindTextBlock()
{
    int textStart = strScan(message, '{4:', 1, strLen(message));
    this.assertEquals(51, textStart);
}

public void testEmptyMessage()
{
    this.assertEquals(0, strScan('', '{4:', 1, 0));
}`;
    const { methods } = split(src);
    expect(methods.map(m => m.name)).toEqual(['setUp', 'testFindTextBlock', 'testEmptyMessage']);
    expect(methods[1].source).toContain(`strScan(message, '{4:', 1, strLen(message));`);
    expect(methods[1].source.trim().endsWith('}')).toBe(true);
  });

  it('ignores braces in double-quoted, verbatim and escaped strings', () => {
    const src = `class ContosoBraces
{
}

public void a()
{
    str s1 = "{";
    str s2 = @"C:\\temp\\{";
    str s3 = "\\"{";
}

public void b()
{
}`;
    expect(names(src)).toEqual(['a', 'b']);
  });

  it('ignores braces in line and block comments', () => {
    const src = `class ContosoBraces
{
}

// helper for { cases
public void a()
{
    // a stray } here
    /* and { here */
    int i;
}

public void b()
{
}`;
    const { methods } = split(src);
    expect(methods.map(m => m.name)).toEqual(['a', 'b']);
    expect(methods[0].source).toContain('/* and { here */');
  });

  it('does not end a method at a } inside a string', () => {
    const src = `class ContosoBraces
{
}

public str closing()
{
    return '}';
}

public void after()
{
}`;
    const { methods } = split(src);
    expect(methods.map(m => m.name)).toEqual(['closing', 'after']);
    expect(methods[0].source).toContain(`return '}';`);
  });

  it('does not end the class declaration at a } inside a string', () => {
    const src = `class ContosoBraces
{
    str marker; // }
}

public void a()
{
}`;
    const { declaration, methods } = split(src);
    expect(declaration).toContain('str marker;');
    expect(methods.map(m => m.name)).toEqual(['a']);
  });

  it('is not thrown off by an apostrophe in a comment before a { in a string', () => {
    const src = `class ContosoBraces
{
}

public void a()
{
    // don't count this
    str s = '{';
}

public void b()
{
}`;
    expect(names(src)).toEqual(['a', 'b']);
  });

  it('keeps an empty class body empty when a doc comment above it holds a {', () => {
    const { declaration } = split('/// handles { blocks\nclass ContosoBraces\n{\n}');
    expect(declaration).toBe('/// handles { blocks\nclass ContosoBraces\n{\n}');
  });

  it('keeps every inner-class method after an unbalanced { in a string', () => {
    const src = `class ContosoMT940ParserTest extends SysTestCase
{
    str message;

    public void testFindTextBlock()
    {
        this.assertTrue(strScan(message, '{4:', 1, strLen(message)) > 0);
    }

    public void testEmptyMessage()
    {
        this.assertEquals(0, strScan('', '{4:', 1, 0));
    }
}`;
    const { declaration, methods } = split(src);
    expect(methods.map(m => m.name)).toEqual(['testFindTextBlock', 'testEmptyMessage']);
    expect(declaration).toContain('str message;');
    expect(declaration).not.toContain('testEmptyMessage');
  });
});

describe('splitXppClassSource — a { that is never closed', () => {
  it('throws instead of dropping the methods after it', () => {
    const src = `class ContosoBroken
{
}

public void a()
{
    if (true)
    {
}

public void b()
{
}`;
    expect(() => split(src)).toThrow(/never closed \(line 6, the block after "public void a\(\)"\)/);
  });

  it('quotes the brace line itself when it holds more than the {', () => {
    const src = 'class ContosoBroken\n{\n}\n\npublic void a() {\n    int i;\n';
    expect(() => split(src)).toThrow(/never closed \(line 5: "public void a\(\) \{"\)/);
  });

  it('throws an XppSplitError, so callers can tell it from a bridge failure', () => {
    expect(() => split('class ContosoBroken\n{\n')).toThrow(XppSplitError);
  });

  it('reports the right line for CRLF source', () => {
    const src = 'class ContosoBroken\r\n{\r\n}\r\n\r\npublic void a()\r\n{\r\n    int i;\r\n';
    expect(() => split(src)).toThrow(/never closed \(line 6, the block after "public void a\(\)"\)/);
  });

  // An apostrophe in macro text opens a string to the lexer, which can hide the
  // class's closing brace. This pins the current behaviour: a clear error that
  // names the likely cause, rather than a split that drops code.
  it('names an apostrophe in macro text as a possible cause', () => {
    const src = `class ContosoMacro
{
    #define.Msg(don't)
}

public void a()
{
}`;
    expect(() => split(src)).toThrow(/apostrophe in macro text/);
  });

  it('throws when the class body itself is never closed', () => {
    expect(() => split('class ContosoBroken\n{\n    int i;\n')).toThrow(/never closed \(line 2, the block after "class ContosoBroken"\)/);
  });

  it('throws through generateAxClassXml, so nothing partial is written', () => {
    expect(() => XmlTemplateGenerator.generateAxClassXml(
      'ContosoBroken',
      'class ContosoBroken\n{\n}\n\npublic void a()\n{\n',
    )).toThrow(/never closed/);
  });
});

describe('generateAxClassXml / parseSourceForBridge with a { in a string', () => {
  const src = `class ContosoMT940Parser
{
}

public int textBlockStart(str message)
{
    return strScan(message, '{4:', 1, strLen(message));
}

public void second()
{
}`;

  it('writes both methods to the XML', () => {
    const xml = XmlTemplateGenerator.generateAxClassXml('ContosoMT940Parser', src);
    expect(xml).toContain('<Name>textBlockStart</Name>');
    expect(xml).toContain('<Name>second</Name>');
  });

  it('hands both methods to the bridge', () => {
    const parsed = XmlTemplateGenerator.parseSourceForBridge(src, 'ContosoMT940Parser');
    expect(parsed.methods.map(m => m.name)).toEqual(['textBlockStart', 'second']);
  });
});

// The hint for a create that lands on an existing object. Nothing is written on
// that path, so the hint is the only place that can report the unclosed brace.
describe('renderEquivalentModifyCall with an unclosed {', () => {
  const sourceCode = 'class ContosoBroken\n{\n}\n\npublic void a()\n{\n';

  it('reports the line instead of throwing or dropping the methods silently', () => {
    const hint = renderEquivalentModifyCall('class', 'ContosoBroken', { sourceCode });
    expect(hint).toMatch(/could not be split into methods: .*never closed \(line 6/);
    expect(hint).not.toContain('add-method');
    // Nothing was written because the object exists, not because of the brace.
    expect(hint).not.toContain('Nothing was written');
  });

  // Source copied out of XML arrives entity-encoded; create decodes it (the
  // &gt; is the evidence it looks for) before splitting, and so must the hint.
  it('decodes XML entities first, as create does, so it raises no false alarm', () => {
    const hint = renderEquivalentModifyCall('class', 'ContosoMT940Parser', {
      sourceCode: 'class ContosoMT940Parser\n{\n}\n\npublic boolean hasTextBlock(str message)\n{\n' +
        '    return strScan(message, &apos;{4:&apos;, 1, strLen(message)) &gt; 0;\n}',
    });
    expect(hint).not.toContain('could not be split');
    expect(hint).toContain('"methodName":"hasTextBlock"');
  });

  it('still offers the call for the other changes', () => {
    const hint = renderEquivalentModifyCall('class', 'ContosoBroken', {
      sourceCode,
      properties: { label: '@ContosoExt:Broken' },
    });
    expect(hint).toContain('so the call below has no add-method operations');
    expect(hint).toContain('"propertyPath":"Label"');
  });
});
