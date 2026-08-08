/**
 * Golden quality-gate tests (plan pillar 7).
 *
 * Locks the offline quality chain end-to-end:
 *   resolve_references (semantic grounding) → validate_xpp (BP rules)
 *
 * Two directions are asserted:
 *   1. Realistic, correct artifacts MUST pass both gates cleanly — the gates
 *      must never block legitimate code (false positives break the workflow).
 *   2. Hallucinated / BP-violating variants MUST be rejected — regressions in
 *      any rule or in the resolver surface here immediately.
 *
 * generate_code templates are additionally locked against validate_xpp so the
 * "/// Foo class." class of template regressions (fixed in fbc2f76) cannot
 * return.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { resolveXppReferences, type ResolverDeps } from '../../src/tools/write/resolveReferences';
import { validateXppTool } from '../../src/tools/analysis/validateXpp';
import { codeGenTool } from '../../src/tools/smart/codeGen';

// ─── Index fixture (real in-memory index — production schema incl. FTS) ──────

let index: XppSymbolIndex;
let deps: ResolverDeps;

const LABELS: Record<string, string[]> = {
  Contoso: ['BlockedCustomer', 'ImportParameters'],
  SYS: ['SYS12345'],
};

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (
    name: string,
    type: string,
    parentName?: string,
    signature?: string,
    extendsClass?: string,
  ) => index.addSymbol({
    name, type, parentName, signature, extendsClass,
    filePath: '/x.xml', model: 'Test',
  } as any);

  // Standard tables
  sym('CustTable', 'table');
  sym('AccountNum', 'field', 'CustTable', 'CustAccount');
  sym('Blocked', 'field', 'CustTable', 'CustVendorBlocked');
  sym('CreditMax', 'field', 'CustTable', 'AmountMST');
  sym('validateWrite', 'method', 'CustTable', 'public boolean validateWrite()');
  sym('find', 'method', 'CustTable',
    'public static CustTable find(CustAccount _custAccount, boolean _forUpdate = false)');
  sym('SalesTable', 'table');
  sym('SalesId', 'field', 'SalesTable', 'SalesIdBase');
  sym('CustAccount', 'field', 'SalesTable', 'CustAccount');
  // Standard enums (incl. platform event enums used in handler attributes)
  sym('CustVendorBlocked', 'enum');
  sym('NoYes', 'enum');
  sym('DataEventType', 'enum');
  // EDTs
  sym('CustAccount', 'edt', undefined, 'AccountNum');
  sym('AmountMST', 'edt', undefined, 'AmountMSTBase');

  deps = {
    db: index.getReadDb(),
    getLabelById: (labelId: string, labelFileId?: string) => {
      const hit = (f: string) => (LABELS[f] ?? []).includes(labelId) ? [{ labelId, labelFileId: f }] : [];
      return labelFileId ? hit(labelFileId) : Object.keys(LABELS).flatMap(hit);
    },
    getLabelFileIds: () => Object.keys(LABELS).map(labelFileId => ({ labelFileId })),
  };
});

afterAll(() => index.close());

// ─── Helpers ─────────────────────────────────────────────────────────────────

const resolveErrors = (code: string) =>
  resolveXppReferences(code, deps).violations.filter(v => v.severity === 'error');

const validate = async (code: string, codeType: 'xpp' | 'xml-table' = 'xpp') => {
  const result = await validateXppTool({
    params: { name: 'validate_xpp', arguments: { code, codeType } },
  });
  return { text: result.content?.[0]?.text ?? '', isError: !!result.isError };
};

const generate = async (args: Record<string, unknown>): Promise<string> => {
  const result = await codeGenTool({
    method: 'tools/call',
    params: { name: 'generate_code', arguments: args },
  } as any);
  const text = result.content?.[0]?.text ?? '';
  const fence = /```(?:xpp|x\+\+|xml)?\r?\n([\s\S]*?)```/.exec(text);
  return fence ? fence[1] : text;
};

// ─── Golden: correct artifacts pass the full gate ────────────────────────────

describe('golden — correct artifacts pass both gates', () => {
  const COC_WRAPPER = `
/// <summary>
/// Blocks writing customers that exceed the Contoso credit policy.
/// </summary>
[ExtensionOf(tableStr(CustTable))]
final class CustTableContoso_Extension
{
    /// <summary>
    /// Validates the customer record against the Contoso credit policy before write.
    /// </summary>
    /// <returns>true when the record passes validation; otherwise, false.</returns>
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        CustTable custTable;

        if (custTable.Blocked == CustVendorBlocked::All)
        {
            ret = checkFailed("@Contoso:BlockedCustomer");
        }
        return ret;
    }
}`;

  it('CoC table-method wrapper resolves and validates cleanly', async () => {
    expect(resolveErrors(COC_WRAPPER)).toEqual([]);
    const v = await validate(COC_WRAPPER);
    expect(v.isError).toBe(false);
  });

  const EVENT_HANDLER = `
/// <summary>
/// Reacts to customer inserts for the Contoso integration feed.
/// </summary>
final class ContosoCustTableEventHandler
{
    /// <summary>
    /// Publishes the inserted customer to the Contoso integration feed.
    /// </summary>
    /// <param name = "_sender">The customer record that was inserted.</param>
    /// <param name = "_e">The data event arguments.</param>
    [DataEventHandler(tableStr(CustTable), DataEventType::Inserted)]
    public static void custTable_onInserted(Common _sender, DataEventArgs _e)
    {
        CustTable custTable = _sender as CustTable;
        if (custTable.AccountNum)
        {
            // integration publish intentionally omitted in the golden fixture
        }
    }
}`;

  it('data event handler resolves and validates cleanly', async () => {
    expect(resolveErrors(EVENT_HANDLER)).toEqual([]);
    const v = await validate(EVENT_HANDLER);
    expect(v.isError).toBe(false);
  });

  const TABLE_XML = `
<AxTable>
  <Name>ContosoImportParameters</Name>
  <Label>@Contoso:ImportParameters</Label>
  <TableGroup>Parameter</TableGroup>
  <ClusteredIndex>KeyIdx</ClusteredIndex>
  <Fields>
    <AxTableField>
      <Name>Key</Name>
      <ExtendedDataType>ParametersKey</ExtendedDataType>
    </AxTableField>
  </Fields>
  <Indexes>
    <AxTableIndex>
      <Name>KeyIdx</Name>
      <AlternateKey>Yes</AlternateKey>
    </AxTableIndex>
  </Indexes>
</AxTable>`;

  it('complete table XML passes all XML property rules', async () => {
    const v = await validate(TABLE_XML, 'xml-table');
    expect(v.isError).toBe(false);
    expect(v.text).not.toMatch(/XML00[1-5]/);
  });
});

// ─── Golden: hallucinated / BP-violating variants are rejected ───────────────

describe('golden — hallucinated and BP-violating artifacts are rejected', () => {
  it('rejects a wrapper touching a non-existent field', () => {
    const errors = resolveErrors(`
      CustTable custTable;
      custTable.LoyaltyTier = 5;`);
    expect(errors.map(e => e.kind)).toContain('unknown-field');
  });

  it('rejects a call to a non-existent static method', () => {
    const errors = resolveErrors('CustTable::findByLoyalty("gold");');
    expect(errors.map(e => e.kind)).toContain('unknown-static-member');
  });

  it('rejects a call with wrong arity against the indexed signature', () => {
    const errors = resolveErrors('CustTable::find("c1", true, 42);');
    expect(errors.map(e => e.kind)).toContain('arity-mismatch');
  });

  it('rejects an extension of a misspelled table', () => {
    const errors = resolveErrors('[ExtensionOf(tableStr(CusTable))]');
    expect(errors.map(e => e.kind)).toContain('unknown-intrinsic-target');
  });

  it('rejects a label that does not exist in a known label file', () => {
    const errors = resolveErrors('info("@Contoso:NoSuchLabel");');
    expect(errors.map(e => e.kind)).toContain('unknown-label');
  });

  it('flags today() and hardcoded strings in the BP gate', async () => {
    const v = await validate(`
      void run()
      {
          if (systemDateGet() > today())
          {
              error("Date is in the past");
          }
      }`);
    expect(v.text).toContain('SEL001');
    expect(v.text).toContain('BP001');
  });

  it('flags a bare table XML missing Label, TableGroup and AlternateKey', async () => {
    const v = await validate(`
<AxTable>
  <Name>ContosoBare</Name>
  <Fields>
    <AxTableField><Name>Value</Name></AxTableField>
  </Fields>
</AxTable>`, 'xml-table');
    expect(v.isError).toBe(true);
    expect(v.text).toContain('XML001');
    expect(v.text).toContain('XML002');
    expect(v.text).toContain('XML003');
    expect(v.text).toContain('XML004');
  });
});

// ─── Golden: generate_code templates stay BP-clean ───────────────────────────

describe('golden — generate_code templates pass validate_xpp', () => {
  const NEW_OBJECT_PATTERNS = ['class', 'runnable', 'batch-job', 'sysoperation'];

  for (const pattern of NEW_OBJECT_PATTERNS) {
    it(`template "${pattern}" generates BP-clean code`, async () => {
      const code = await generate({ pattern, name: 'ContosoGoldenProbe', modelName: 'Contoso' });
      expect(code.trim().length).toBeGreaterThan(0);
      const v = await validate(code);
      // No errors, and specifically no generic doc-comment regression (BP003)
      expect(v.isError).toBe(false);
      expect(v.text).not.toContain('BP003');
    });
  }

  it('template "class-extension" generates BP-clean CoC skeleton', async () => {
    const code = await generate({
      pattern: 'class-extension',
      name: 'SalesFormLetter',
      modelName: 'Contoso',
    });
    expect(code).toContain('[ExtensionOf(');
    const v = await validate(code);
    expect(v.isError).toBe(false);
    expect(v.text).not.toContain('BP003');
    expect(v.text).not.toContain('COC002'); // must be final
    expect(v.text).not.toContain('COC003'); // must end _Extension
  });
});
