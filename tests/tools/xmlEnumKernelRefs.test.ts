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

  it('still catches an enum that really does not exist', async () => {
    // The check has to keep its teeth — this is the case it exists for.
    const bad: any = await call(tableXml('FmTotallyInventedEnum'));
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('FmTotallyInventedEnum');
  });
});
