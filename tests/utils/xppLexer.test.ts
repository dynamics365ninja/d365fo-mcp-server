/**
 * The shared X++ lexer — the single place that decides what is a literal and what
 * is a comment, and therefore the place every regex rule trusts.
 *
 * It had NO tests. That is how its one asymmetry went unnoticed until a rule
 * tripped over it: the module's own documentation says "delimiters survive; only
 * the CONTENT becomes spaces", and that is true of quotes and of `//` and of the
 * OPENING `/*` — but the CLOSING `*&#47;` is blanked with the content. A rule that
 * stripped `/*…*&#47;` from masked text therefore matched nothing, which put 11
 * error-severity false positives on Microsoft's own attribute arguments.
 *
 * These tests pin the behaviour as it IS, not as the comment describes it, and
 * say which is which — so the next reader trusts the test rather than re-deriving
 * it from a rule that mysteriously does not fire. Changing the asymmetry is a
 * separate decision: `*&#47;` surviving would read as the `*` and `/` operators to
 * every arithmetic rule, which is presumably why it is blanked.
 */
import { describe, expect, it } from 'vitest';
import { isMasked, maskXpp, scanXpp } from '../../src/utils/xppLexer.js';

describe('maskXpp — the invariants every rule depends on', () => {
  const samples = [
    "strFind(text, ',', 1, strLen(text));",
    "match('????????-????-????', candidate);",
    "return ' LEFT JOIN %2 T2 ON T1.RECID = T2.RECID';",
    "str path = @'C:\\Temp\\report.pdf';",
    "str quoted = 'it''s here';",
    'str escaped = "line\\nbreak \\"quoted\\"";',
    '/* a block comment */ int i = 1;',
    '// a line comment\nint j = 2;',
    "str macroText = 'the #define directive is text here';",
  ];

  it('never changes the length of the source', () => {
    for (const s of samples) expect(maskXpp(s), s).toHaveLength(s.length);
  });

  it('never moves a newline, so line numbers taken from the mask are real', () => {
    const source = samples.join('\n');
    const masked = maskXpp(source);
    const lineStarts = (t: string) => [...t.matchAll(/\n/g)].map(m => m.index);
    expect(lineStarts(masked)).toEqual(lineStarts(source));
  });

  it('blanks the content of both quote styles but keeps the quotes', () => {
    const masked = maskXpp("a = 'x,y'; b = \"p,q\";");
    expect(masked).toBe("a = '   '; b = \"   \";");
  });

  it('treats a doubled quote as escaping, not as a closed literal', () => {
    // 'it''s here' is ONE literal. Reading it as two would leave `s here` exposed.
    const masked = maskXpp("str s = 'it''s here'; select x;");
    expect(masked).not.toContain('here');
    expect(masked).toContain('select x;');
  });

  it('does not treat a backslash as an escape inside a verbatim string', () => {
    const masked = maskXpp("str p = @'C:\\Temp\\x'; select y;");
    expect(masked).not.toContain('Temp');
    expect(masked).toContain('select y;');
  });

  it('honours a backslash escape in an ordinary string', () => {
    const masked = maskXpp('str s = "a\\"b"; select z;');
    expect(masked).not.toContain('b');
    expect(masked).toContain('select z;');
  });

  it('hides an X++ keyword that only appears inside a literal', () => {
    const masked = maskXpp("return 'delete_from CUSTTABLE';");
    expect(masked).not.toMatch(/delete_from/);
  });

  it('hides a comma inside a character literal — the FN001 false positive', () => {
    const masked = maskXpp("strFind(text, ',', 1, n);");
    // Three commas belong to the call; the fourth was inside the literal.
    expect((masked.match(/,/g) ?? []).length).toBe(3);
  });
});

describe('maskXpp — comment delimiters, including the asymmetry', () => {
  it('keeps // and blanks the rest of the line', () => {
    const masked = maskXpp('int i = 1; // set to one\nint j = 2;');
    expect(masked).toContain('//');
    expect(masked).not.toContain('set to one');
    expect(masked).toContain('int j = 2;');
  });

  it('keeps the OPENING /* and blanks the closing */ with the content', () => {
    // Documented as "delimiters survive", and only half true. A rule that strips
    // a CLOSED /*…*/ from masked text matches nothing; strip the unterminated
    // form too. This is what ATTR001 got wrong on shipped code.
    const masked = maskXpp('f(true /*why*/, 600);');
    expect(masked).toContain('/*');
    expect(masked).not.toContain('*/');
    expect(masked).not.toContain('why');
    expect(masked).toHaveLength('f(true /*why*/, 600);'.length);
  });

  it('does not let a comment marker inside a string open a comment', () => {
    const masked = maskXpp("str s = 'this /* is not */ a comment'; select t;");
    expect(masked).toContain('select t;');
  });

  it('spans a block comment across lines without eating the code after it', () => {
    const masked = maskXpp('/* one\n   two */\nselect t;');
    expect(masked).toContain('select t;');
    expect(masked).not.toContain('two');
  });
});

describe('scanXpp — the spans a rule can ask about', () => {
  it('reports each literal and comment once, with its kind', () => {
    const { spans } = scanXpp("str s = 'x'; // note\n/* block */ int i = 1;");
    expect(spans.map(s => s.kind)).toEqual(['string', 'line-comment', 'block-comment']);
  });

  it('marks a verbatim string as verbatim and records its quote', () => {
    const { spans } = scanXpp("str p = @'C:\\x'; str q = \"y\";");
    expect(spans[0].verbatim).toBe(true);
    expect(spans[0].quote).toBe("'");
    expect(spans[1].verbatim).toBeUndefined();
    expect(spans[1].quote).toBe('"');
  });

  it('answers whether a given offset is inside a literal', () => {
    const code = "select t where t.Name == 'select';";
    const { spans } = scanXpp(code);
    expect(isMasked(spans, code.indexOf('select'))).toBe(false);
    expect(isMasked(spans, code.lastIndexOf('select'))).toBe(true);
  });

  it('survives an unterminated literal at end of file without hanging', () => {
    // A truncated file reaches the validator through the write path.
    expect(() => maskXpp("str s = 'unterminated")).not.toThrow();
    expect(maskXpp("str s = 'unterminated")).toHaveLength("str s = 'unterminated".length);
  });
});
