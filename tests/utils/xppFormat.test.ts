import { describe, it, expect } from 'vitest';
import { reindentXppSource } from '../../src/utils/xppFormat';

describe('reindentXppSource', () => {
  it('re-indents a flush-left (no indentation at all) method to the standard convention', () => {
    const input = `public void new(str _prefix)
{
prefix = _prefix;
}`;
    expect(reindentXppSource(input)).toBe(
      `    public void new(str _prefix)\n    {\n        prefix = _prefix;\n    }`
    );
  });

  it('re-indents a method with inconsistent/ragged existing indentation', () => {
    const input = `  public str format(str _text)
        {
    return prefix + ': ' + _text;
}`;
    expect(reindentXppSource(input)).toBe(
      `    public str format(str _text)\n    {\n        return prefix + ': ' + _text;\n    }`
    );
  });

  it('handles nested blocks (if/while) going one level deeper per brace', () => {
    const input = `public display str dimensionDisplayValue()
{
DimensionAttributeValueSetStorage dimStorage;
if (!this.DefaultDimension)
{
return '';
}
return dimStorage.toString();
}`;
    const expected = [
      '    public display str dimensionDisplayValue()',
      '    {',
      '        DimensionAttributeValueSetStorage dimStorage;',
      '        if (!this.DefaultDimension)',
      '        {',
      "            return '';",
      '        }',
      '        return dimStorage.toString();',
      '    }',
    ].join('\n');
    expect(reindentXppSource(input)).toBe(expected);
  });

  it('preserves blank lines between statements', () => {
    const input = `public void new(str _prefix)
{
prefix = _prefix;

}`;
    expect(reindentXppSource(input)).toBe(
      `    public void new(str _prefix)\n    {\n        prefix = _prefix;\n\n    }`
    );
  });

  it('preserves a leading doc comment at the same depth as the signature', () => {
    const input = `/// <summary>
/// Initializes a new instance.
/// </summary>
protected void new(AvailabilityViewSelections _selections)
{
selections = _selections;
}`;
    const expected = [
      '    /// <summary>',
      '    /// Initializes a new instance.',
      '    /// </summary>',
      '    protected void new(AvailabilityViewSelections _selections)',
      '    {',
      '        selections = _selections;',
      '    }',
    ].join('\n');
    expect(reindentXppSource(input)).toBe(expected);
  });

  it('does not miscount braces inside string literals', () => {
    const input = `public str curly()
{
return '{ not a brace }';
}`;
    expect(reindentXppSource(input)).toBe(
      `    public str curly()\n    {\n        return '{ not a brace }';\n    }`
    );
  });

  it('does not miscount braces inside line comments', () => {
    const input = `public void withComment()
{
// this comment has a { brace
doSomething();
}`;
    expect(reindentXppSource(input)).toBe(
      '    public void withComment()\n    {\n        // this comment has a { brace\n        doSomething();\n    }'
    );
  });

  it('honors an explicit baseDepth (e.g. a delegate declaration nested differently)', () => {
    const input = `delegate void noteAdded(str _noteId)
{
}`;
    expect(reindentXppSource(input, 1)).toBe('    delegate void noteAdded(str _noteId)\n    {\n    }');
  });

  it('is idempotent — re-running on already-correct output changes nothing', () => {
    const once = reindentXppSource(`public void m()\n{\nx = 1;\n}`);
    const twice = reindentXppSource(once);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// A `case` label opens a level even though it opens no brace. Deriving depth
// from braces alone flattened every case body onto its label, and did it to
// CORRECT input too — a well-formatted switch handed in came back wrong, which
// is how a generated method needed hand-repair right after it was written.
// Verified against shipped code: ApplicationFoundation/AxClass/AVTimeframe.xml.
// ---------------------------------------------------------------------------

describe('reindentXppSource — switch/case', () => {
  const flat = [
    'public str label(QualityTier _t)',
    '{',
    'switch (_t)',
    '{',
    'case QualityTier::None:',
    'return "@None";',
    'case QualityTier::Gold:',
    'x = 1;',
    'return "@Gold";',
    'default:',
    "return '';",
    '}',
    '}',
  ].join('\n');

  const expected = [
    '    public str label(QualityTier _t)',
    '    {',
    '        switch (_t)',
    '        {',
    '            case QualityTier::None:',
    '                return "@None";',
    '            case QualityTier::Gold:',
    '                x = 1;',
    '                return "@Gold";',
    '            default:',
    "                return '';",
    '        }',
    '    }',
  ].join('\n');

  it('indents case bodies one level under their label', () => {
    expect(reindentXppSource(flat)).toBe(expected);
  });

  it('leaves an already-correct switch alone', () => {
    // The regression that made this necessary: correct input came back flattened.
    expect(reindentXppSource(expected)).toBe(expected);
  });

  it('closes the case level on the switch closing brace', () => {
    const input = 'public void m()\n{\nswitch (x)\n{\ncase 1:\na();\n}\nb();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        switch (x)',
      '        {',
      '            case 1:',
      '                a();',
      '        }',
      '        b();',
      '    }',
    ].join('\n'));
  });

  it('handles a switch nested inside another block', () => {
    const input = 'public void m()\n{\nif (x)\n{\nswitch (y)\n{\ncase 1:\nbreak;\n}\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        if (x)',
      '        {',
      '            switch (y)',
      '            {',
      '                case 1:',
      '                    break;',
      '            }',
      '        }',
      '    }',
    ].join('\n'));
  });

  it('does not shift anything for a "case" outside a switch body', () => {
    // An identifier that merely starts with "case" must not open a level.
    const input = 'public void m()\n{\ncaseId = 1;\nreturn;\n}';
    expect(reindentXppSource(input)).toBe(
      '    public void m()\n    {\n        caseId = 1;\n        return;\n    }',
    );
  });
});

describe('xppMethodSourceForXml', () => {
  it('ends the method with the blank line shipped metadata has', async () => {
    const { xppMethodSourceForXml } = await import('../../src/utils/xppFormat');
    // Microsoft writes "}\n\n]]></Source>"; writers that omitted it produced
    // classes whose methods sit directly on top of each other.
    expect(xppMethodSourceForXml('public void m()\n{\n}')).toBe('    public void m()\n    {\n    }\n');
  });

  it('returns empty for empty source rather than a lone newline', async () => {
    const { xppMethodSourceForXml } = await import('../../src/utils/xppFormat');
    expect(xppMethodSourceForXml('   \n  ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Shapes below were generated through the real generator, written into a model
// and compiled with xppc.exe 7.0.7996.33 — "Errors: 0, Warnings: 0". The run
// was proved to actually reach the file by injecting a missing semicolon and
// confirming the compiler reported it ("';' expected" with coordinates), so the
// pass is evidence rather than a check that silently skipped.
//
// Indentation does not affect X++ validity; what the compile establishes is
// that the generator emits code that builds first time, and these expectations
// pin the layout so it keeps matching shipped platform code.
// ---------------------------------------------------------------------------

describe('reindentXppSource — compiler-validated switch shapes', () => {
  it('keeps consecutive fall-through labels on one level and indents the shared body', () => {
    // 3 of 40 sampled shipped classes put two labels in a row; all of them do
    // it this way, which is why a label must close the previous label's level
    // before opening its own rather than stair-stepping.
    const input = 'public str f(int _k)\n{\nswitch (_k)\n{\ncase 1:\ncase 2:\nreturn \'low\';\ndefault:\nreturn \'none\';\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public str f(int _k)',
      '    {',
      '        switch (_k)',
      '        {',
      '            case 1:',
      '            case 2:',
      "                return 'low';",
      '            default:',
      "                return 'none';",
      '        }',
      '    }',
    ].join('\n'));
  });

  it('restores the outer case level after a nested switch closes', () => {
    const input = 'public int f(int _a, int _b)\n{\nswitch (_a)\n{\ncase 1:\nswitch (_b)\n{\ncase 10:\nreturn 11;\n}\ncase 2:\nreturn 20;\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public int f(int _a, int _b)',
      '    {',
      '        switch (_a)',
      '        {',
      '            case 1:',
      '                switch (_b)',
      '                {',
      '                    case 10:',
      '                        return 11;',
      '                }',
      '            case 2:',
      '                return 20;',
      '        }',
      '    }',
    ].join('\n'));
  });

  it('handles a case body wrapped in its own braces', () => {
    const input = 'public str f(int _k)\n{\nswitch (_k)\n{\ncase 1:\n{\nstr local = \'one\';\nreturn local;\n}\ndefault:\n{\nreturn \'other\';\n}\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public str f(int _k)',
      '    {',
      '        switch (_k)',
      '        {',
      '            case 1:',
      '                {',
      "                    str local = 'one';",
      '                    return local;',
      '                }',
      '            default:',
      '                {',
      "                    return 'other';",
      '                }',
      '        }',
      '    }',
    ].join('\n'));
  });

  it('indents break with the rest of the case body', () => {
    // 33 of 33 sampled shipped classes indent `break` under its label.
    const input = 'public void f(NoYes _flag)\n{\nswitch (_flag)\n{\ncase NoYes::Yes:\ncounter++;\nbreak;\ndefault:\nbreak;\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void f(NoYes _flag)',
      '    {',
      '        switch (_flag)',
      '        {',
      '            case NoYes::Yes:',
      '                counter++;',
      '                break;',
      '            default:',
      '                break;',
      '        }',
      '    }',
    ].join('\n'));
  });
});

// ---------------------------------------------------------------------------
// A statement wrapped onto further lines opens no brace, so brace depth alone
// put its continuation lines at the same level as its first line — and did it
// to CORRECT input, so a caller who wrapped a `where` clause or an `&&` got the
// wrap flattened back out by the writer it handed the method to.
// ---------------------------------------------------------------------------

describe('reindentXppSource — wrapped statements', () => {
  it('indents the continuation of a wrapped select and a wrapped if condition', () => {
    // Verbatim shape from a d365fo_file(create, class) call whose wrap the
    // writer flattened: the `where` and the `&&` came back at `select`/`if` level.
    const input = [
      'public boolean validateWrite()',
      '{',
      'boolean ret = next validateWrite();',
      '',
      'select firstonly oldRecord',
      'where oldRecord.RecId == this.RecId;',
      '',
      'if (oldRecord.RecId',
      '&& enum2int(this.Tier) < enum2int(oldRecord.Tier))',
      '{',
      'ret = checkFailed("@Lbl:X");',
      '}',
      '',
      'return ret;',
      '}',
    ].join('\n');
    expect(reindentXppSource(input)).toBe([
      '    public boolean validateWrite()',
      '    {',
      '        boolean ret = next validateWrite();',
      '',
      '        select firstonly oldRecord',
      '            where oldRecord.RecId == this.RecId;',
      '',
      '        if (oldRecord.RecId',
      '            && enum2int(this.Tier) < enum2int(oldRecord.Tier))',
      '        {',
      '            ret = checkFailed("@Lbl:X");',
      '        }',
      '',
      '        return ret;',
      '    }',
    ].join('\n'));
  });

  it('leaves an already-wrapped statement alone', () => {
    // The regression this pins: correct input came back flattened.
    const correct = [
      '    public void m()',
      '    {',
      '        select firstonly t',
      '            where t.RecId == this.RecId;',
      '    }',
    ].join('\n');
    expect(reindentXppSource(correct)).toBe(correct);
  });

  it('does not stair-step a condition wrapped over three lines', () => {
    const input = 'public void m()\n{\nif (a\n&& b\n&& c)\n{\nx();\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        if (a',
      '            && b',
      '            && c)',
      '        {',
      '            x();',
      '        }',
      '    }',
    ].join('\n'));
  });

  it('keeps a wrapped signature\'s opening brace at the signature level', () => {
    const input = 'public void m(\nint _a,\nint _b)\n{\nx();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m(',
      '        int _a,',
      '        int _b)',
      '    {',
      '        x();',
      '    }',
    ].join('\n'));
  });

  it('does not treat an attribute or a doc comment as an open statement', () => {
    // `[ExtensionOf(…)]` ends in `]` and `/// <summary>` in `>`; neither may
    // push the declaration that follows it one level in.
    const input = '/// <summary>\n/// Does a thing.\n/// </summary>\n[SysObsolete("x", false)]\npublic void m()\n{\nx();\n}';
    expect(reindentXppSource(input)).toBe([
      '    /// <summary>',
      '    /// Does a thing.',
      '    /// </summary>',
      '    [SysObsolete("x", false)]',
      '    public void m()',
      '    {',
      '        x();',
      '    }',
    ].join('\n'));
  });

  it('indents a braceless if body under its condition', () => {
    const input = 'public void m()\n{\nif (a)\nreturn;\nx();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        if (a)',
      '            return;',
      '        x();',
      '    }',
    ].join('\n'));
  });
});

// ---------------------------------------------------------------------------
// X++ string literals take EITHER quote. Recognising only `'` let a brace
// inside a double-quoted string count as a real one, so `info("a } b");`
// popped a block and shifted the whole rest of the method out by a level.
// ---------------------------------------------------------------------------

describe('reindentXppSource — braces inside string literals', () => {
  it('ignores a closing brace inside a double-quoted string', () => {
    const input = 'public void m()\n{\ninfo("a } b");\nx = 1;\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        info("a } b");',
      '        x = 1;',
      '    }',
    ].join('\n'));
  });

  it('ignores an opening brace inside a double-quoted string', () => {
    const input = 'public void m()\n{\ninfo("a { b");\nx = 1;\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        info("a { b");',
      '        x = 1;',
      '    }',
    ].join('\n'));
  });

  it('still ignores braces inside a single-quoted string', () => {
    const input = "public void m()\n{\ninfo('a } b');\nx = 1;\n}";
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      "        info('a } b');",
      '        x = 1;',
      '    }',
    ].join('\n'));
  });

  it('does not end the literal on an escaped or doubled quote', () => {
    const input = 'public void m()\n{\ninfo("say \\" } still in");\ninfo("say "" } still in");\nx = 1;\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        info("say \\" } still in");',
      '        info("say "" } still in");',
      '        x = 1;',
      '    }',
    ].join('\n'));
  });

  it('does not cut the line at a // inside a double-quoted string', () => {
    // The `//` scan runs outside string state, so a URL no longer hides a brace.
    const input = 'public void m()\n{\nif (a)\n{\ninfo("http://x/y");\n}\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        if (a)',
      '        {',
      '            info("http://x/y");',
      '        }',
      '    }',
    ].join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Continuation depth is judged on the line's CODE, not its raw text. Judged on
// the raw text, a trailing comment hid the `;` that ends the statement and the
// NEXT line was indented as its continuation — and the result was stable under
// re-formatting, so nothing put it back. Trailing comments are ordinary X++.
// ---------------------------------------------------------------------------

describe('reindentXppSource — comments do not fake a continuation', () => {
  it('does not indent the line after a statement with a trailing comment', () => {
    const input = 'public void m()\n{\nttsbegin; // start\nttscommit;\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        ttsbegin; // start',
      '        ttscommit;',
      '    }',
    ].join('\n'));
  });

  it('does not indent the line after an opening brace with a trailing comment', () => {
    const input = 'public void m()\n{\nif (x)\n{   // guard\nfoo();\n}\nbar();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        if (x)',
      '        {   // guard',
      '            foo();',
      '        }',
      '        bar();',
      '    }',
    ].join('\n'));
  });

  it('reads through a multi-line block comment without continuing into it', () => {
    const input = 'public void m()\n{\n/* explain\nthe thing */\nfoo();\nbar();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        /* explain',
      '        the thing */',
      '        foo();',
      '        bar();',
      '    }',
    ].join('\n'));
  });

  it('does not let a brace inside a multi-line block comment pop a block', () => {
    // Prose is not code: the `}` below closes nothing, so `after();` stays inside.
    const input = 'public void m()\n{\n/* a }\nb } c */\nafter();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        /* a }',
      '        b } c */',
      '        after();',
      '    }',
    ].join('\n'));
  });

  it('still continues a wrapped statement that carries a trailing comment', () => {
    const input = 'public void m()\n{\nselect firstonly t // the live one\nwhere t.RecId == this.RecId;\nfoo();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        select firstonly t // the live one',
      '            where t.RecId == this.RecId;',
      '        foo();',
      '    }',
    ].join('\n'));
  });

  it('ignores an inline block comment in the middle of a condition', () => {
    const input = 'public void m()\n{\nif (a /* why */ && b)\n{\nx();\n}\ny();\n}';
    expect(reindentXppSource(input)).toBe([
      '    public void m()',
      '    {',
      '        if (a /* why */ && b)',
      '        {',
      '            x();',
      '        }',
      '        y();',
      '    }',
    ].join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Idempotence is the property that keeps a correctly formatted method from
// being rewritten on every subsequent modify. Each shape above is re-run
// through the formatter here so a future change cannot make one of them
// oscillate.
// ---------------------------------------------------------------------------

describe('reindentXppSource — idempotence across every shape', () => {
  const shapes: Array<[string, string]> = [
    ['wrapped select', 'public void m()\n{\nselect firstonly t\nwhere t.RecId == this.RecId;\n}'],
    ['wrapped condition', 'public void m()\n{\nif (a\n&& b)\n{\nx();\n}\n}'],
    ['wrapped signature', 'public void m(\nint _a,\nint _b)\n{\nx();\n}'],
    ['braceless if body', 'public void m()\n{\nif (a)\nreturn;\n}'],
    ['brace in a string', 'public void m()\n{\ninfo("a } b");\nx = 1;\n}'],
    ['switch', 'public void m()\n{\nswitch (x)\n{\ncase 1:\na();\nbreak;\n}\n}'],
    ['attribute + doc comment', '/// <summary>\n/// x\n/// </summary>\n[SysObsolete("x", false)]\npublic void m()\n{\n}'],
    ['trailing comment', 'public void m()\n{\nttsbegin; // start\nttscommit;\n}'],
    ['multi-line block comment', 'public void m()\n{\n/* explain\nthe thing */\nfoo();\n}'],
  ];

  for (const [name, input] of shapes) {
    it(`is idempotent for a ${name}`, () => {
      const once = reindentXppSource(input);
      expect(reindentXppSource(once)).toBe(once);
    });
  }
});
