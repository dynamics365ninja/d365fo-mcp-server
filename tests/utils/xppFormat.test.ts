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
