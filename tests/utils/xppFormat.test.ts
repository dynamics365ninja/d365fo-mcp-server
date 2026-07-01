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
