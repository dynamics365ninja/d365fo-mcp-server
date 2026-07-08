/**
 * validate_xpp tool tests — offline BP validator
 */

import { describe, it, expect } from 'vitest';
import { validateXppTool } from '../../src/tools/validateXpp';
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
