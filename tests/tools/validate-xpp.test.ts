/**
 * validate_xpp tool tests — offline BP validator
 */

import { describe, it, expect } from 'vitest';
import { validateXppTool } from '../../src/tools/analysis/validateXpp';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'validate_xpp', arguments: args },
});

const getText = (result: any): string => result.content?.[0]?.text ?? '';

// ─── Input validation ────────────────────────────────────────────────────────

describe('validate_xpp input validation', () => {
  it('returns error on missing code', async () => {
    const result = await validateXppTool(req({}));
    expect(result.isError).toBe(true);
  });

  it('returns no violations for empty code', async () => {
    const result = await validateXppTool(req({ code: '' }));
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toMatch(/no violation|0 violation/i);
  });
});

// ─── SEL rules ───────────────────────────────────────────────────────────────

describe('SEL rules', () => {
  it('SEL001: flags today() usage', async () => {
    const code = `
      QueryDate d = today();
      select firstOnly CustTable where CustTable.CreatedDate == today();
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    expect(text).toContain('SEL001');
    expect(text).toMatch(/today\(\)/);
  });

  it('SEL001: clean code passes', async () => {
    const code = `
      QueryDate d = DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone());
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    expect(text).not.toContain('SEL001');
  });

  it('SEL002: flags forceLiterals', async () => {
    const code = `
      select forceLiterals firstOnly CustTable where CustTable.AccountNum == '1000';
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('SEL002');
  });

  it('SEL004: flags nested while select', async () => {
    const code = `
      while select CustTable {
        while select SalesTable where SalesTable.CustAccount == CustTable.AccountNum {
          info(SalesTable.SalesId);
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('SEL004');
  });

  it('SEL005: flags a genuine function call inside a where clause', async () => {
    const code = `
      void run()
      {
          CustTable custTable;
          select firstOnly custTable where custTable.AccountNum == someFunc(1);
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('SEL005');
  });

  it('SEL005: does NOT flag statements after the where-clause terminates on the same line', async () => {
    // Regression (eval L4-vendor-cert-compliance): `select count(x) from t where ...).RecId;`
    // followed by an unrelated info() call was misattributed as "inside where clause" —
    // the scanner never closed the where-clause state because it only reset on `{`,
    // never on the statement-terminating `;`.
    const code = `
      class TestSelectCountValidator
      {
          public void run()
          {
              CustTable custTable;
              int c;

              c = (select count(RecId) from custTable
                  where custTable.AccountNum != '').RecId;

              info(strFmt("%1", c));
          }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('SEL005');
  });

  it('SEL005: does NOT bleed into unrelated later methods in the same class', async () => {
    // Even more pathological form of the same bug: a where-clause on an early
    // line left `inWhere` stuck true for the rest of the file, so a completely
    // unrelated method DECLARATION several lines later ("run2(") was flagged.
    const code = `
      class TestSelectCountValidator2
      {
          public void run()
          {
              CustTable custTable;
              int c;

              c = (select count(RecId) from custTable
                  where custTable.AccountNum != '').RecId;
          }

          public void run2()
          {
              info(strFmt("%1", 1));
          }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('SEL005');
  });

  it('SEL005: does not flag an aggregate function in the select list before "where" on the same line', async () => {
    const code = `
      void run()
      {
          CustTable custTable;
          int c;
          c = (select count(RecId) from custTable where custTable.AccountNum != '').RecId;
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('SEL005');
  });
});

// ─── COC rules ───────────────────────────────────────────────────────────────

describe('COC rules', () => {
  it('COC001: flags copied default param value in CoC wrapper', async () => {
    const code = `
      [ExtensionOf(classStr(SalesFormLetter))]
      final class SalesFormLetter_MyExt_Extension {
        public void run(boolean _validate = false) {
          next run(_validate);
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC001');
  });

  // Access modifiers are optional in X++ (members default to public), and
  // get_method's CoC template deliberately omits them — so the modifier-anchored
  // form of this rule missed the single most likely source of the defect: an
  // agent pasting that template verbatim.
  it('COC001: flags a default param on a wrapper with no access modifier', async () => {
    const code = `
[ExtensionOf(classStr(SalesFormLetter))]
final class SalesFormLetter_MyExt_Extension
{
    void run(boolean _validate = false)
    {
        next run(_validate);
    }
}
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC001');
  });

  // A call statement whose arguments contain '=' inside a string is not a
  // declaration. Guarding the widened regex against that false positive.
  it('COC001: does not flag a call statement containing "=" inside parens', async () => {
    const code = `
[ExtensionOf(classStr(SalesFormLetter))]
final class SalesFormLetter_MyExt_Extension
{
    void run()
    {
        next run();
        info(strFmt("count = %1", this.count()));
    }
}
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('COC001');
  });

  it('COC002: flags [ExtensionOf] class that is not final', async () => {
    const code = `
      [ExtensionOf(classStr(SalesFormLetter))]
      class SalesFormLetter_MyExt_Extension {
        public void run() {
          next run();
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC002');
  });

  it('COC003: flags extension class not ending in _Extension', async () => {
    const code = `
      [ExtensionOf(classStr(SalesFormLetter))]
      final class MySalesFormLetterExt {
        public void run() {
          next run();
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC003');
  });
});

// ─── BP rules ────────────────────────────────────────────────────────────────

describe('BP rules', () => {
  it('BP001: flags hardcoded string in info()', async () => {
    const code = `info("Record saved successfully.");`;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('BP001');
  });

  it('BP002: flags doInsert()', async () => {
    const code = `custTable.doInsert();`;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('BP002');
  });

  it('BP003: flags generic doc-comment', async () => {
    const code = `
      /// MyHelper class.
      class MyHelper {}
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('BP003');
  });
});

// ─── XML rules ───────────────────────────────────────────────────────────────

describe('XML rules', () => {
  it('XML001: flags missing AlternateKey on index', async () => {
    const xml = `
      <AxTable>
        <Indexes>
          <AxTableIndex>
            <Name>CustIdx</Name>
            <AlternateKey>No</AlternateKey>
          </AxTableIndex>
        </Indexes>
      </AxTable>
    `;
    const result = await validateXppTool(req({ code: xml, codeType: 'xml-table' }));
    expect(getText(result)).toContain('XML001');
  });

  it('XML001: is a warning, not a hard error (eval #7)', async () => {
    // xppbp reports BPCheckAlternateKeyAbsent as a warning and the table builds.
    // As an error, a case that legitimately mandates one index could never pass.
    const xml = `
      <AxTable>
        <Name>ConDemoAsset</Name>
        <Label>@Contoso:AssetLabel</Label>
        <TableGroup>Main</TableGroup>
        <Indexes>
          <AxTableIndex>
            <Name>AssetIdx</Name>
            <AlternateKey>No</AlternateKey>
          </AxTableIndex>
        </Indexes>
      </AxTable>
    `;
    const result = await validateXppTool(req({ code: xml, codeType: 'xml-table' }));
    expect(getText(result)).toContain('XML001');
    expect(getText(result)).toContain('[XML001] — WARNING');
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain('0 error(s)');
  });

  it('XML001: passes when AlternateKey is Yes', async () => {
    const xml = `
      <AxTable>
        <Indexes>
          <AxTableIndex>
            <Name>CustIdx</Name>
            <AlternateKey>Yes</AlternateKey>
          </AxTableIndex>
        </Indexes>
      </AxTable>
    `;
    const result = await validateXppTool(req({ code: xml, codeType: 'xml-table' }));
    expect(getText(result)).not.toContain('XML001');
  });

  it('XML001: does NOT fire on a table EXTENSION (inherits base alternate key)', async () => {
    // Regression (eval L2-table-extension): an AxTableExtension adding a field has
    // no index of its own and must not be required to declare an alternate key —
    // the base table already has one.
    const xml = `
      <AxTableExtension>
        <Name>CustGroup.ContosoExtension</Name>
        <Fields>
          <AxTableField i:type="AxTableFieldInt">
            <Name>NotePriority</Name>
            <ExtendedDataType>Counter</ExtendedDataType>
          </AxTableField>
        </Fields>
      </AxTableExtension>
    `;
    const result = await validateXppTool(req({ code: xml, codeType: 'xml-table' }));
    expect(getText(result)).not.toContain('XML001');
  });
});

// ─── Data-driven property rules (XML002–XML005) ──────────────────────────────

const COMPLETE_TABLE_XML = `
<AxTable>
  <Name>ContosoTable</Name>
  <Label>@Contoso:ContosoTable</Label>
  <TableGroup>Main</TableGroup>
  <ClusteredIndex>ContosoIdx</ClusteredIndex>
  <Fields>
    <AxTableField>
      <Name>ContosoId</Name>
      <ExtendedDataType>CustAccount</ExtendedDataType>
    </AxTableField>
  </Fields>
  <Indexes>
    <AxTableIndex>
      <Name>ContosoIdx</Name>
      <AlternateKey>Yes</AlternateKey>
    </AxTableIndex>
  </Indexes>
</AxTable>`;

const BARE_TABLE_XML = `
<AxTable>
  <Name>ContosoTable</Name>
  <Fields>
    <AxTableField>
      <Name>ContosoId</Name>
    </AxTableField>
  </Fields>
  <Indexes>
    <AxTableIndex>
      <Name>ContosoIdx</Name>
      <AlternateKey>Yes</AlternateKey>
    </AxTableIndex>
  </Indexes>
</AxTable>`;

/** Stats provider stub with configurable ratios. */
const statsProvider = (ratios: Record<string, number>, totals = 1000) => ({
  getPropertyPresenceRatio: (nodeType: string, property: string) => {
    const ratio = ratios[`${nodeType}.${property}`];
    return ratio === undefined
      ? { present: 0, total: 0, ratio: 0 }
      : { present: Math.round(ratio * totals), total: totals, ratio };
  },
  getPropertyValueDistribution: () => [
    { value: 'Main', count: 600 },
    { value: 'Transaction', count: 400 },
  ],
});

describe('XML property rules — static defaults (no stats)', () => {
  it('flags missing Label, TableGroup and field EDT on a bare table', async () => {
    const result = await validateXppTool(req({ code: BARE_TABLE_XML, codeType: 'xml-table' }));
    const text = getText(result);
    expect(text).toContain('XML002');
    expect(text).toContain('XML003');
    expect(text).toContain('XML004');
    expect(text).not.toContain('XML005'); // static default off without stats
  });

  it('passes a complete table XML', async () => {
    const result = await validateXppTool(req({ code: COMPLETE_TABLE_XML, codeType: 'xml-table' }));
    const text = getText(result);
    for (const rule of ['XML002', 'XML003', 'XML004', 'XML005']) {
      expect(text).not.toContain(rule);
    }
  });
});

describe('TTS001 / BP004 + comment-string masking', () => {
  it('flags unbalanced ttsbegin/ttscommit (TTS001)', async () => {
    const code = `void run()\n{\n    ttsbegin;\n    this.doWork();\n}`;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('TTS001');
  });

  it('does not flag balanced ttsbegin/ttscommit', async () => {
    const code = `void run()\n{\n    ttsbegin;\n    this.doWork();\n    ttscommit;\n}`;
    expect(getText(await validateXppTool(req({ code, codeType: 'xpp' })))).not.toContain('TTS001');
  });

  it('flags developer-only print/pause statements (BP004)', async () => {
    const code = `void run()\n{\n    print "x";\n}`;
    expect(getText(await validateXppTool(req({ code, codeType: 'xpp' })))).toContain('BP004');
  });

  it('does not flag keywords that appear only inside comments or strings', async () => {
    const code = `void run()\n{\n    // ttsbegin here is just a comment\n    str s = "remember to print this";\n}`;
    const text = getText(await validateXppTool(req({ code, codeType: 'xpp' })));
    expect(text).not.toContain('TTS001');
    expect(text).not.toContain('BP004');
  });
});

describe('XML property rules — mined statistics', () => {
  it('includes mined evidence and value distribution in violations', async () => {
    const context = {
      symbolIndex: statsProvider({
        'AxTable.Label': 0.97,
        'AxTable.TableGroup': 0.95,
        'AxTableField.ExtendedDataType': 0.92,
      }),
    } as any;
    const result = await validateXppTool(req({ code: BARE_TABLE_XML, codeType: 'xml-table' }), context);
    const text = getText(result);
    expect(text).toContain('97% of 1,000 standard AxTable nodes');
    expect(text).toContain('Main (60%)');
  });

  it('disables a rule when standard usage is below the threshold', async () => {
    const context = {
      symbolIndex: statsProvider({
        'AxTable.Label': 0.3, // standard models rarely set it → rule off
        'AxTable.TableGroup': 0.95,
        'AxTableField.ExtendedDataType': 0.92,
      }),
    } as any;
    const result = await validateXppTool(req({ code: BARE_TABLE_XML, codeType: 'xml-table' }), context);
    const text = getText(result);
    expect(text).not.toContain('XML002');
    expect(text).toContain('XML003');
  });

  it('enables XML005 only when stats prove standard usage', async () => {
    const context = {
      symbolIndex: statsProvider({ 'AxTable.ClusteredIndex': 0.9 }),
    } as any;
    const result = await validateXppTool(req({ code: BARE_TABLE_XML, codeType: 'xml-table' }), context);
    expect(getText(result)).toContain('XML005');
  });
});

// ─── Phase C rules (CS001 / TTS002 / TTS003 / SEL006 / SEL007 / RPT / FN001 ext) ─

describe('CS001 — C# constructs', () => {
  it('flags string interpolation, lambda, foreach, ?? and string type', async () => {
    const code = `
      string name = custTable.Name;
      str greeting = $"hello";
      list.ForEach(x => x.run());
      foreach (var item in items) {}
      str fallback = a ?? b;
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    const hits = (text.match(/\[CS001\]/g) ?? []).length;
    expect(hits).toBeGreaterThanOrEqual(5);
    expect(result.isError).toBe(true);
  });

  it('stays quiet on plain X++ (>= is not =>, quotes mask $")', async () => {
    const code = `
      if (qty >= minQty)
      {
          info(strFmt("@MyModel:Msg", qty));
      }
      str note = "uses => and foreach in prose";
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('CS001');
  });
});

describe('TTS002 — dead catch inside tts', () => {
  it('flags a catch-all inside an open tts scope', async () => {
    const code = `
      ttsbegin;
      try
      {
          custTable.update();
      }
      catch
      {
          info("never reached");
      }
      ttscommit;
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('TTS002');
  });

  it('allows catch (Exception::UpdateConflict) inside tts and any catch outside', async () => {
    const code = `
      try
      {
          ttsbegin;
          custTable.update();
          ttscommit;
      }
      catch (Exception::Deadlock)
      {
          info("outside tts - fine");
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('TTS002');
  });
});

describe('TTS003 — unguarded retry', () => {
  it('flags retry with no counter or condition in its catch', async () => {
    const code = `
      try
      {
          this.run();
      }
      catch (Exception::Deadlock)
      {
          retry;
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('TTS003');
  });

  it('accepts a counter-guarded retry', async () => {
    const code = `
      try
      {
          this.run();
      }
      catch (Exception::Deadlock)
      {
          retryCount++;
          if (retryCount > 5)
          {
              throw error("@MyModel:TooManyRetries");
          }
          retry;
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('TTS003');
  });
});

describe('SEL006 / SEL007 — index hint and foreign join syntax', () => {
  it('SEL006: flags index hint without allowIndexHint(true)', async () => {
    const code = `select firstOnly custTable index hint AccountIdx where custTable.AccountNum == acc;`;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('SEL006');
  });

  it('SEL006: quiet when allowIndexHint(true) is present', async () => {
    const code = `
      custTable.allowIndexHint(true);
      select firstOnly custTable index hint AccountIdx where custTable.AccountNum == acc;
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('SEL006');
  });

  it('SEL007: flags left join and join…on', async () => {
    const code = `
      select custTable
          left join custTrans on custTrans.AccountNum == custTable.AccountNum;
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    expect(text).toContain('SEL007');
    expect(result.isError).toBe(true);
  });

  it('SEL007: quiet on valid X++ joins', async () => {
    const code = `
      select custTable
          outer join custTrans where custTrans.AccountNum == custTable.AccountNum
          notexists join custBlocked where custBlocked.AccountNum == custTable.AccountNum;
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('SEL007');
  });
});

describe('RPT001/RPT002 — DP class shape', () => {
  it('RPT001: DP reads parmDataContract() without SRSReportParameterAttribute', async () => {
    const code = `
      public class MyReportDP extends SRSReportDataProviderBase
      {
          public void processReport()
          {
              MyReportContract contract = this.parmDataContract() as MyReportContract;
          }

          [SRSReportDataSetAttribute(tableStr(MyReportTmp))]
          public MyReportTmp getMyReportTmp()
          {
              select * from tmpTable;
              return tmpTable;
          }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('RPT001');
  });

  it('RPT002: processReport without any dataset getter', async () => {
    const code = `
      [SRSReportParameterAttribute(classStr(MyReportContract))]
      public class MyReportDP extends SRSReportDataProviderBase
      {
          public void processReport()
          {
          }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('RPT002');
  });

  it('quiet on a well-formed DP', async () => {
    const code = `
      [SRSReportParameterAttribute(classStr(MyReportContract))]
      public class MyReportDP extends SRSReportDataProviderBase
      {
          [SRSReportDataSetAttribute(tableStr(MyReportTmp))]
          public MyReportTmp getMyReportTmp()
          {
              select * from tmpTable;
              return tmpTable;
          }

          public void processReport()
          {
              MyReportContract contract = this.parmDataContract() as MyReportContract;
          }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    expect(text).not.toContain('RPT001');
    expect(text).not.toContain('RPT002');
  });
});

describe('codeType xml-report — RPT101/RPT102', () => {
  it('RPT101: AxReport without a design', async () => {
    const code = `<?xml version="1.0" encoding="utf-8"?>
<AxReport>
  <Name>MyReport</Name>
  <Datasets>
    <AxReportDataSet>
      <Name>MyReportTmp</Name>
      <Query>SELECT * FROM MyReportDP.MyReportTmp</Query>
    </AxReportDataSet>
  </Datasets>
</AxReport>`;
    const result = await validateXppTool(req({ code, codeType: 'xml-report' }));
    expect(getText(result)).toContain('RPT101');
  });

  it('RPT102: dataset without Query', async () => {
    const code = `<?xml version="1.0" encoding="utf-8"?>
<AxReport>
  <Name>MyReport</Name>
  <Datasets>
    <AxReportDataSet>
      <Name>MyReportTmp</Name>
    </AxReportDataSet>
  </Datasets>
  <Designs>
    <AxReportDesign>
      <Name>Report</Name>
    </AxReportDesign>
  </Designs>
</AxReport>`;
    const result = await validateXppTool(req({ code, codeType: 'xml-report' }));
    const text = getText(result);
    expect(text).toContain('RPT102');
    expect(text).not.toContain('RPT101');
  });

  it('X++ keyword rules do NOT run over the RDL CDATA', async () => {
    const code = `<?xml version="1.0" encoding="utf-8"?>
<AxReport>
  <Name>MyReport</Name>
  <Designs>
    <AxReportDesign>
      <Name>Report</Name>
      <Text><![CDATA[ print this; pause; select * from x; ]]></Text>
    </AxReportDesign>
  </Designs>
</AxReport>`;
    const result = await validateXppTool(req({ code, codeType: 'xml-report' }));
    expect(getText(result)).toMatch(/no violations/i);
  });
});

describe('FN001 — extended fixed-arity set', () => {
  it('flags subStr with 2 arguments and ssrsReportStr with 1', async () => {
    const code = `
      str part = subStr(fullName, 3);
      controller.parmReportName(ssrsReportStr(MyReport));
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    const hits = (text.match(/\[FN001\]/g) ?? []).length;
    expect(hits).toBe(2);
  });

  it('does not flag conIns — xppc accepts it with 2 and 4 arguments (variadic, Phase F probe)', async () => {
    const code = `
      container c1 = conIns(values, 1, 'a', 'b');
      container c2 = conIns(values, 1);
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('FN001');
  });

  it('accepts correct arities (subStr 3, conPeek 2, mkDate 3, ssrsReportStr 2)', async () => {
    const code = `
      str part = subStr(fullName, 3, 5);
      str first = conPeek(values, 1);
      date d = mkDate(1, 7, 2026);
      controller.parmReportName(ssrsReportStr(MyReport, Report));
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).not.toContain('FN001');
  });
});
