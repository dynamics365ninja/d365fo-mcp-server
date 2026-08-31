/**
 * The five rules added in the v3 coverage wave, and — just as importantly — the
 * shapes they must stay silent on.
 *
 * Every rule here was proposed in an earlier plan and never shipped, so the
 * negative half of each test matters more than the positive one: a rule that
 * fires on Microsoft's own code is worse than no rule, and the shipped-source
 * sweep (`npm run oracle:sweep`) is what proves it does not. These tests are the
 * VM-free half of that bar.
 */
import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp.js';

const rulesOn = (code: string, kind: 'xpp' | 'xml-any' = 'xpp') =>
  runRules(code, kind).map(v => v.rule);

describe('DOC001 — /// doc comments are parsed as XML', () => {
  it('flags a bare ampersand in doc-comment prose', () => {
    const code = `
    /// <summary>
    /// Applies discount & rebate in one pass.
    /// </summary>
    public void apply()
    {
    }`;
    expect(rulesOn(code)).toContain('DOC001');
  });

  it('says why escaping it is not the fix', () => {
    const code = '    /// Discount & rebate.\n    public void apply()\n    {\n    }';
    const fix = runRules(code, 'xpp').find(v => v.rule === 'DOC001')?.fix ?? '';
    expect(fix).toMatch(/BPXmlDocMalformed/);
    expect(fix).toMatch(/does not survive the write path/i);
  });

  it('is a WARNING, because Microsoft ships this too', () => {
    // Measured over 6,000 shipped AxClass files: a bare & in a doc comment in 4
    // of them ("F&O"), a bare < in 9 ("version < CTP8"). BPXmlDocMalformed is a
    // best-practice finding, not a compile failure — an error here would stop a
    // build on code the product itself contains.
    const code = '    /// Discount & rebate.\n    public void apply()\n    {\n    }';
    expect(runRules(code, 'xpp').find(v => v.rule === 'DOC001')?.severity).toBe('warning');
  });

  it('accepts a real character entity', () => {
    const code = '    /// Discount &amp; rebate, plus &#39;quoted&#39; text.\n    public void apply()\n    {\n    }';
    expect(rulesOn(code)).not.toContain('DOC001');
  });

  it('accepts the XML tags doc comments are made of', () => {
    const code = `
    /// <summary>
    /// Finds the record.
    /// </summary>
    /// <param name = "_accountNum">The account.</param>
    /// <returns>The record, or an empty buffer.</returns>
    /// <remarks>See <c>CustTable</c> and <see cref="find" />.</remarks>
    public void find()
    {
    }`;
    expect(rulesOn(code)).not.toContain('DOC001');
  });

  it('ignores an ampersand in ordinary code and in strings', () => {
    const code = `
    public void bits()
    {
        int flags = 1 & 2;
        str text = 'a & b';
        boolean both = flags && true;
    }`;
    expect(rulesOn(code)).not.toContain('DOC001');
  });
});

describe('SET001 — set-based statements with no where clause', () => {
  it('flags update_recordset without a where', () => {
    const code = `
    public void raiseAll()
    {
        CustTable custTable;

        update_recordset custTable
            setting CreditMax = 1000;
    }`;
    expect(rulesOn(code)).toContain('SET001');
  });

  it('flags delete_from without a where', () => {
    const code = 'public void wipe()\n{\n    CustTable custTable;\n\n    delete_from custTable;\n}';
    expect(rulesOn(code)).toContain('SET001');
  });

  it('stays quiet when the where comes after setting', () => {
    const code = `
    public void raiseGroup(CustGroupId _group)
    {
        CustTable custTable;

        update_recordset custTable
            setting CreditMax = 1000
            where custTable.CustGroup == _group;
    }`;
    expect(rulesOn(code)).not.toContain('SET001');
  });

  it('stays quiet when the where sits on a joined table', () => {
    const code = `
    public void raiseJoined()
    {
        CustTable custTable;
        CustGroup custGroup;

        update_recordset custTable
            setting CreditMax = 1000
            join custGroup
                where custGroup.CustGroup == custTable.CustGroup;
    }`;
    expect(rulesOn(code)).not.toContain('SET001');
  });

  it('is a warning, because the compiler allows it and staging tables want it', () => {
    const code = 'public void wipe()\n{\n    TmpCustTable tmp;\n\n    delete_from tmp;\n}';
    const found = runRules(code, 'xpp').find(v => v.rule === 'SET001');
    expect(found?.severity).toBe('warning');
  });

  it('does not read the words inside a string literal as a statement', () => {
    const code = `
    public str sql()
    {
        return 'delete_from CUSTTABLE';
    }`;
    expect(rulesOn(code)).not.toContain('SET001');
  });
});

describe('OP001 — && and || have equal precedence in X++', () => {
  it('flags an unparenthesised mix', () => {
    const code = 'public boolean m(boolean a, boolean b, boolean c)\n{\n    return a || b && c;\n}';
    expect(rulesOn(code)).toContain('OP001');
  });

  it('explains that the X++ reading differs from C#', () => {
    const code = 'public boolean m(boolean a, boolean b, boolean c)\n{\n    return a || b && c;\n}';
    const fix = runRules(code, 'xpp').find(v => v.rule === 'OP001')?.fix ?? '';
    expect(fix).toMatch(/equal precedence/i);
    expect(fix).toMatch(/left to right/i);
  });

  it('accepts a parenthesised mix — that is the fix', () => {
    const code = 'public boolean m(boolean a, boolean b, boolean c)\n{\n    return a || (b && c);\n}';
    expect(rulesOn(code)).not.toContain('OP001');
  });

  it('accepts a parenthesised mix with nested groups', () => {
    const code =
      'public boolean m(boolean a, boolean b, boolean c, boolean d)\n{\n' +
      '    return (a && (b || c)) || (d && a);\n}';
    expect(rulesOn(code)).not.toContain('OP001');
  });

  it('says nothing about the && -first order, which groups the same everywhere', () => {
    // "a && b || c" is (a && b) || c in X++ AND in C#. Flagging it was half of the
    // 971 findings the shipped-source sweep produced — noise that trains a reader
    // to skip the case that matters.
    const code = `
    public boolean m(boolean a, boolean b, boolean c)
    {
        return a && b || c;
    }`;
    expect(rulesOn(code)).not.toContain('OP001');
  });

  it('says nothing about either operator on its own', () => {
    const code =
      'public boolean m(boolean a, boolean b, boolean c)\n{\n' +
      '    return a && b && c;\n}';
    expect(rulesOn(code)).not.toContain('OP001');
  });

  it('does not read operators inside a literal', () => {
    const code = "public str m()\n{\n    return 'a || b && c';\n}";
    expect(rulesOn(code)).not.toContain('OP001');
  });
});

describe('XML008 — an AxTableExtension has no <Methods>', () => {
  const withMethods = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>CustTable.ConExtension</Name>
  <Methods>
    <Method>
      <Name>displayCredit</Name>
      <Source><![CDATA[
    display CustCreditMax displayCredit()
    {
        return this.CreditMax;
    }
]]></Source>
    </Method>
  </Methods>
</AxTableExtension>`;

  it('flags the block the deserializer drops silently', () => {
    expect(rulesOn(withMethods, 'xml-any')).toContain('XML008');
  });

  it('points at the extension class that does work', () => {
    const fix = runRules(withMethods, 'xml-any').find(v => v.rule === 'XML008')?.fix ?? '';
    expect(fix).toMatch(/ExtensionOf\(tableStr\(CustTable\)\)/);
    expect(fix).toMatch(/silently/i);
  });

  it('says nothing about a table extension without methods', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>CustTable.ConExtension</Name>
  <Fields>
    <AxTableField i:type="AxTableFieldString">
      <Name>ConNote</Name>
    </AxTableField>
  </Fields>
</AxTableExtension>`;
    expect(rulesOn(xml, 'xml-any')).not.toContain('XML008');
  });

  it('says nothing about <Methods> on a real table, where it belongs', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoTable</Name>
  <Methods>
    <Method>
      <Name>find</Name>
      <Source><![CDATA[
    public static ConDemoTable find(RecId _recId)
    {
        ConDemoTable found;

        select firstonly found
            where found.RecId == _recId;

        return found;
    }
]]></Source>
    </Method>
  </Methods>
</AxTable>`;
    expect(rulesOn(xml, 'xml-any')).not.toContain('XML008');
  });
});

describe('XML009 — a control bound to a field group the table does not declare', () => {
  const document = (group: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoTable</Name>
  <FieldGroups>
    <AxTableFieldGroup>
      <Name>AutoReport</Name>
    </AxTableFieldGroup>
    <AxTableFieldGroup>
      <Name>DemoDetails</Name>
    </AxTableFieldGroup>
  </FieldGroups>
  <Design>
    <Control>
      <DataGroup>${group}</DataGroup>
    </Control>
  </Design>
</AxTable>`;

  it('flags a group the document itself shows is missing', () => {
    expect(rulesOn(document('Overview'), 'xml-any')).toContain('XML009');
  });

  it('names the groups that do exist, so the fix is obvious', () => {
    const fix = runRules(document('Overview'), 'xml-any').find(v => v.rule === 'XML009')?.fix ?? '';
    expect(fix).toMatch(/AutoReport/);
    expect(fix).toMatch(/DemoDetails/);
    expect(fix).toMatch(/INCREMENTAL build passes it/i);
  });

  it('accepts a group the table declares', () => {
    expect(rulesOn(document('DemoDetails'), 'xml-any')).not.toContain('XML009');
  });

  it('stays quiet when the document cannot answer the question', () => {
    // A form on its own does not carry the table's field groups. Guessing here
    // would fire on every correct form in the product.
    const formOnly = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoForm</Name>
  <Design>
    <Control>
      <DataGroup>Overview</DataGroup>
    </Control>
  </Design>
</AxForm>`;
    expect(rulesOn(formOnly, 'xml-any')).not.toContain('XML009');
  });

  it('reports each missing group once, not once per control', () => {
    const xml = document('Overview').replace(
      '</Design>',
      '  <Control>\n      <DataGroup>Overview</DataGroup>\n    </Control>\n  </Design>',
    );
    const hits = runRules(xml, 'xml-any').filter(v => v.rule === 'XML009');
    expect(hits).toHaveLength(1);
  });
});

/**
 * Two rules that shipped in the compiler-verified wave and were still firing on
 * Microsoft's own code. The sweep found both; these tests keep them fixed.
 */
describe('regressions the shipped-source sweep found', () => {
  it('ATTR001 accepts an attribute argument that carries an inline comment', () => {
    // 11 error-severity hits in the first 3,000 files swept. The masker keeps the
    // opening /* and blanks the closing */, so the argument arrives unterminated
    // and a "strip closed comments" fix matches nothing.
    const code = `
    [SysSetupConfig(true /*ContinueOnError*/, 600 /*10 minutes*/)]
    public void setup()
    {
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('ATTR001');
  });

  it('ATTR001 still rejects a genuinely non-literal argument', () => {
    const code = `
    [MyAttribute(someVariable)]
    public void setup()
    {
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).toContain('ATTR001');
  });

  it('SEL008 does not read across a macro boundary', () => {
    // A select inside a #localmacro is a FRAGMENT with no terminating semicolon,
    // so the statement matcher ran past #endmacro and picked up the next macro's
    // where — reporting "order by after where" on DocuRefSearch, where each macro
    // on its own is in the correct order.
    const code = `
    #localmacro.whereClause
        where docuRef.RefCompanyId == common.DataAreaId
    #endmacro

    #localmacro.querySortByCreatedDateTime
        select noFetch docuRef
            order by CreatedDateTime desc
            where docuRef.RefRecId == common.RecId
    #endmacro`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('SEL008');
  });

  it('SEL008 still catches a real ordering mistake', () => {
    const code = `
    public void m()
    {
        CustTable custTable;

        select custTable
            where custTable.CustGroup == '10'
            order by AccountNum;
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).toContain('SEL008');
  });
  it('FN001 does not read a constructor as a call to the predefined function', () => {
    // `new Info()` builds the Info class; `info` is also a predefined function.
    const code = `
    public void m()
    {
        Info info = new Info();
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('FN001');
  });

  it('FN001 yields to a local function that shadows a predefined name', () => {
    // The compiler resolves "…nor a previously defined local function" last, so a
    // local one wins and its arity is the one that counts. BatchRun does exactly
    // this: void info() { … } and then info();
    const code = `
    public void run()
    {
        void info()
        {
            this.doSomething();
        }

        info();
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('FN001');
  });

  it('FN001 still catches a genuine arity mistake', () => {
    const code = `
    public void m()
    {
        str s = subStr('abc');
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).toContain('FN001');
  });

  it('SEL010 leaves the SysDa method named validTimeState alone', () => {
    const code = `
    public SysDaFindObject validTimeState(SysDaValidTimeState _validTimeState = null)
    {
        return this;
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('SEL010');
  });

  it('SEL010 still catches an expression in the select CLAUSE', () => {
    const code = `
    public void m()
    {
        MyRateTable rate;

        select validTimeState(DateTimeUtil::utcNow()) rate;
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).toContain('SEL010');
  });

  it('CS001 accepts a C#-looking type name the file aliases with using', () => {
    // 448 shipped files open with `using string = System.String;` and then declare
    // `public string ConstructGroupKey(...)`, which compiles.
    const code = `
using string = System.String;
using decimal = System.Decimal;

public class MyPricingConfigurer
{
}`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('CS001');
  });

  it('CS001 still rejects the C# type when nothing aliased it', () => {
    const code = `
    public void m()
    {
        string groupKey = 'x';
    }`;
    expect(runRules(code, 'xpp').map(v => v.rule)).toContain('CS001');
  });

  it('COC003 accepts the lower-case _extension suffix the platform ships', () => {
    const code = `
[ExtensionOf(classStr(JournalCheckPost))]
internal final class MyJournalCheckPost_extension
{
}`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('COC003');
  });

  it('RPT001 leaves an abstract DP base class alone', () => {
    // The concrete subclasses carry [SRSReportParameterAttribute]; the shared base
    // legitimately does not.
    const code = `
abstract class MyAdvanceInvoiceDP extends SRSReportDataProviderBase
{
    public void processReport()
    {
        contract = this.parmDataContract();
    }
}`;
    expect(runRules(code, 'xpp').map(v => v.rule)).not.toContain('RPT001');
  });
});
