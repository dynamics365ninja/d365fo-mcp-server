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
