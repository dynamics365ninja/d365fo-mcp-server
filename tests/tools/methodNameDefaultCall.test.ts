/**
 * A default argument that is a call must not rename the method.
 *
 * The class-source split named each method after the identifier before the LAST
 * '(' of its signature. That skips attribute parentheses, but
 *
 *     public void run(TransDate _from = dateNull())
 *
 * has a later '(' inside the parameter list, so the method was written as a
 * <Method> named `dateNull`. In the inner-class split, a signature spread over
 * several lines also lost every line above that call, because the method start
 * was taken from the line holding the wrong '('. Seen creating classes whose
 * date parameters default to dateNull(); the workaround was add-method with an
 * explicit methodName.
 */
import { describe, expect, it } from 'vitest';
import { XmlTemplateGenerator, parameterListOpenIndex } from '../../src/tools/xml/xmlTemplateGenerator.js';

const split = (src: string) => XmlTemplateGenerator.splitXppClassSource(src);
const names = (src: string) => split(src).methods.map(m => m.name);

describe('parameterListOpenIndex', () => {
  it('finds the list after an attribute with parentheses', () => {
    const sig = `[DataMemberAttribute('Query')]\n    public str parmQuery(str _q = '')\n    `;
    expect(parameterListOpenIndex(sig)).toBe(sig.indexOf('parmQuery(') + 'parmQuery'.length);
  });

  it('skips a call in a default argument', () => {
    const sig = 'public void run(TransDate _from = dateNull())';
    expect(parameterListOpenIndex(sig)).toBe(sig.indexOf('('));
  });

  it('skips nested calls and quoted parentheses', () => {
    const sig = `public void run(TransDate _d = str2Date(')', 123), str _s = '(')`;
    expect(parameterListOpenIndex(sig)).toBe(sig.indexOf('('));
  });

  it('falls back to the last ( when there is no )', () => {
    expect(parameterListOpenIndex('void broken(int _x')).toBe(11);
    expect(parameterListOpenIndex('no parens')).toBe(-1);
  });
});

describe('class-source split keeps the method name', () => {
  it('methods after the class body', () => {
    const src = `public class ContosoPeriodService
{
}
public void run(TransDate _from = dateNull(), TransDate _to = maxDate())
{
}
public static ContosoPeriodService construct()
{
    return new ContosoPeriodService();
}`;
    expect(names(src)).toEqual(['run', 'construct']);
  });

  it('methods inside the class body', () => {
    const src = `public class ContosoPeriodService
{
    TransDate fromDate;

    [SysObsoleteAttribute('Use runFor', false)]
    public void run(TransDate _from = dateNull())
    {
        fromDate = _from;
    }

    public TransDate parmFromDate(TransDate _fromDate = fromDate)
    {
        fromDate = _fromDate;
        return fromDate;
    }
}`;
    expect(names(src)).toEqual(['run', 'parmFromDate']);
  });

  it('a multi-line signature keeps its first line and its attribute', () => {
    const src = `public class ContosoPeriodService
{
    [Hookable(false)]
    public void runFor(
        CustAccount _account,
        TransDate   _from = dateNull(),
        TransDate   _to   = DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()))
    {
    }
}`;
    const [method] = split(src).methods;
    expect(method.name).toBe('runFor');
    expect(method.source).toContain('[Hookable(false)]');
    expect(method.source).toContain('public void runFor(');
    expect(method.source).toContain('CustAccount _account,');
  });
});
