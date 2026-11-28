/**
 * INT001 — an interface method declared C#-style, with `;` instead of a body.
 *
 * X++ interface methods carry an empty body. Written as `void run(str _a);` the
 * compiler stops with a fatal "'{' expected" on the interface, then reports errors on
 * the implementing classes ("declared private on the base class and may not be
 * overridden") and on the callers ("expects 0 argument(s)"), none of which names the
 * semicolon. The rule only looks after an `interface` declaration, so a class, an
 * abstract class or a field declaration can never trip it. Over every AxClass of a
 * platform install it reports nothing.
 */

import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';

const int001 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'INT001');

describe('INT001 fires on a bodiless interface method', () => {
  it('catches a method header ending in ";" inside the interface braces', () => {
    const code = [
      'public interface ContosoRentalPricingI',
      '{',
      '    public void setRentalPeriod(str _from, str _to);',
      '    public real calcPrice()',
      '    {',
      '    }',
      '}',
    ].join('\n');
    const v = int001(code);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
    expect(v[0].line).toBe(3);
    expect(v[0].excerpt).toBe('public void setRentalPeriod(str _from, str _to);');
    expect(v[0].fix).toContain('public void setRentalPeriod(…) { }');
  });

  it('catches the C# shape without an access modifier and with an EDT return type', () => {
    const code = 'interface ContosoRentalI\n{\n    AmountMST total();\n    void reset();\n}';
    expect(int001(code).map(v => v.line)).toEqual([3, 4]);
  });

  it('catches methods written after the declaration, the way AxClass XML stores them', () => {
    const code = [
      'public interface ContosoRentalI',
      '{',
      '}',
      '',
      'public void setRentalPeriod(TransDate _from = dateNull(), TransDate _to = maxDate());',
    ].join('\n');
    const v = int001(code);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(5);
  });

  it('reads a header that spans several lines as one statement', () => {
    const code = [
      'interface ContosoRentalI',
      '{',
      '    public void setRentalPeriod(',
      '        TransDate _from,',
      '        TransDate _to);',
      '}',
    ].join('\n');
    const v = int001(code);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(3);
  });
});

describe('INT001 sees through comments and array return types', () => {
  it('reports the header line when a doc comment precedes the method', () => {
    const code = [
      'internal interface ContosoRentalRefresher',
      '{',
      '}',
      '',
      '    /// <summary>',
      '    /// Refreshes the rental data sources.',
      '    /// </summary>',
      '    public void doRefresh();',
    ].join('\n');
    const v = int001(code);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(8);
  });

  it('finds the method after a block comment', () => {
    const code = [
      'interface ContosoRentalBatchable',
      '{',
      '}',
      '',
      '    /*',
      '    Returns the rental batch information.',
      '    */',
      '    public ContosoRentalInfo rentalInfo();',
    ].join('\n');
    expect(int001(code).map(v => v.line)).toEqual([8]);
  });

  it('accepts an array return type', () => {
    const code = 'public interface ContosoRentalFeatures\n{\n}\n\npublic str[] enabledFeatures();';
    expect(int001(code)).toHaveLength(1);
  });
});

describe('INT001 stays quiet on legal code', () => {
  it('accepts interface methods with an empty body', () => {
    const code = [
      'public interface ContosoRentalPricingI',
      '{',
      '    public void setRentalPeriod(str _from, str _to)',
      '    {',
      '    }',
      '',
      '    [Hookable(false)]',
      '    public real calcPrice()',
      '    {',
      '    }',
      '}',
    ].join('\n');
    expect(int001(code)).toEqual([]);
  });

  it('ignores a class, even one that implements an interface', () => {
    const code = [
      'public class ContosoRentalPricing implements ContosoRentalPricingI',
      '{',
      '    TransDate fromDate;',
      '',
      '    public void setRentalPeriod(str _from, str _to)',
      '    {',
      '        fromDate = str2Date(_from, 321);',
      '        this.calcPrice();',
      '    }',
      '}',
    ].join('\n');
    expect(int001(code)).toEqual([]);
  });

  it('ignores statements inside a method body that follows the interface', () => {
    const code = [
      'interface ContosoRentalI',
      '{',
      '}',
      'public void reset()',
      '{',
      '    ContosoRentalTable table = ContosoRentalTable::find(curExt());',
      '    info(strFmt("@ContosoExt:Reset", table.RentalId));',
      '}',
    ].join('\n');
    expect(int001(code)).toEqual([]);
  });

  it('ignores the word interface in a comment or a string', () => {
    const code = [
      '// interface ContosoRentalI',
      'public class ContosoRentalJob',
      '{',
      '    str label = "interface ContosoRentalI";',
      '    public void run();',
      '}',
    ].join('\n');
    expect(int001(code)).toEqual([]);
  });
});
