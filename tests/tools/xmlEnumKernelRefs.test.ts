/**
 * `validate_code(mode="references", codeType="xml-table")` reported
 * `<EnumType>NoYes</EnumType>` as a hard ERROR — "not found in the symbol
 * index" — under "Fix errors before writing — these will cause compiler
 * failures". NoYes appears 48 times in CustTable.xml alone and EDT NoYesId
 * resolves to it, so the validator was telling agents to edit correct metadata;
 * search then offers NoYesBlank / DefaultNoYes, which are real enums, so the
 * "fix" compiles clean and means something else. Confirmed live 2026-08-24.
 */

import { describe, it, expect } from 'vitest';
import { validateCodeTool } from '../../src/tools/analysis/validateCode';

/** An index that knows the AOT enums but, correctly, not the kernel ones. */
const KNOWN = new Set(['noyesblank', 'custaccount']);
const ctx = {
  symbolIndex: {
    getReadDb: () => ({
      // lookupSymbolsNocase probes twice: exact .all(name, ...types, limit) and an
      // FTS .all(matchExpr, name, ...). Answering on either arg covers both.
      prepare: () => ({
        all: (...args: unknown[]) => {
          const probe = [args[0], args[1]]
            .map(a => String(a ?? '').toLowerCase())
            .find(a => KNOWN.has(a));
          return probe ? [{ name: probe, type: 'enum', model: 'Test' }] : [];
        },
        get: () => undefined,
      }),
    }),
    getLabelById: () => [],
  },
} as any;

const call = (code: string) => validateCodeTool(
  { method: 'tools/call', params: { name: 'validate_code', arguments: { mode: 'references', codeType: 'xml-table', code, context: 'FmProbe' } } } as never,
  ctx,
);
const text = (r: any) => r.content.map((c: any) => c.text).join('');

const tableXml = (enumType: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxTable><Name>FmProbe</Name><Fields>
  <AxTableField><Name>IsActive</Name><EnumType>${enumType}</EnumType></AxTableField>
</Fields></AxTable>`;

describe('xml <EnumType> against kernel enums', () => {
  it('accepts NoYes instead of calling it a hallucinated symbol', async () => {
    const r: any = await call(tableXml('NoYes'));
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('not found');
  });

  it('accepts every kernel enum the runtime defines', async () => {
    for (const en of ['Exception', 'Types', 'TableScope', 'NoYes']) {
      const r: any = await call(tableXml(en));
      expect(r.isError, en + ' must not be an error').toBeFalsy();
    }
  });

  it('still verifies AOT enums against the index', async () => {
    const ok: any = await call(tableXml('NoYesBlank'));
    expect(ok.isError).toBeFalsy();
  });

  it('still reports an enum that really does not exist', async () => {
    // The check keeps its teeth — it just stops claiming certainty it cannot have.
    const bad: any = await call(tableXml('FmTotallyInventedEnum'));
    expect(text(bad)).toContain('FmTotallyInventedEnum');
    expect(text(bad)).toContain('warning');
  });

  it('does not fail the call over an enum the index merely cannot see', async () => {
    // On this installation 44 enum names that shipped Microsoft metadata references
    // cannot be resolved by it — TableGroup and AccessRight among them. An index-only check
    // cannot tell those from an invention, so it must not hard-error: the agent
    // obeys, swaps in a real-but-different enum from search, and the result
    // compiles clean meaning something else.
    for (const en of ['TableGroup', 'AccessRight', 'SortOrder', 'HRMApplicantType']) {
      const r: any = await call(tableXml(en));
      expect(r.isError, en + ' must not fail the call').toBeFalsy();
      expect(text(r), en + ' must still be reported').toContain(en);
    }
  });
});
