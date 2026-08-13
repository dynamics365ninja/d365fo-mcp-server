/**
 * A table CoC that re-reads the record it already holds instead of reading
 * `this.orig()`: COC006 flags it, and the two readers that answered "not found"
 * for an inherited table method now answer with the signature and the contract.
 */

import { describe, it, expect, vi } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';
import { validateWrittenXpp } from '../../src/tools/write/inlineXppValidation';
import { prepareChangeTool } from '../../src/tools/prepare/prepareChange';
import { getMethodSignatureTool } from '../../src/tools/knowledge/methodSignature';
import {
  hasTableDataMethods,
  lookupTableDataMethod,
} from '../../src/knowledge/tableDataMethods';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

/** A wrapper that fetches its own row again. */
const SHIPPED = `[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        if (ret)
        {
            AslFinCore_TaxTransReportChangeLog oldRecord;

            select firstonly AslFinSK_QualityTier from oldRecord
                where oldRecord.RecId == this.RecId;

            if (oldRecord.RecId && this.AslFinSK_QualityTier < oldRecord.AslFinSK_QualityTier)
            {
                ret = checkFailed(strFmt("@AslFinSK:QualityTierDowngradeNotAllowed",
                    enum2str(oldRecord.AslFinSK_QualityTier),
                    enum2str(this.AslFinSK_QualityTier)));
            }
        }

        return ret;
    }
}`;

/** The same guard written against the pre-image. */
const WITH_ORIG = `[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        if (ret
            && this.RecId
            && this.AslFinSK_QualityTier < this.orig().AslFinSK_QualityTier)
        {
            ret = checkFailed(strFmt(literalStr("@AslFinSK:QualityTierDowngradeNotAllowed"),
                enum2str(this.orig().AslFinSK_QualityTier),
                enum2str(this.AslFinSK_QualityTier)));
        }

        return ret;
    }
}`;

describe('COC006 — the record is already in hand', () => {
  const coc006 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'COC006');

  it('flags a select that fetches the buffer\'s own row', () => {
    const found = coc006(SHIPPED);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].fix).toContain('this.orig()');
    // The where clause is on its own line — a per-line scan would miss it.
    expect(found[0].excerpt).toContain('oldRecord.RecId == this.RecId');
  });

  it('accepts the same guard written against the pre-image', () => {
    expect(coc006(WITH_ORIG)).toHaveLength(0);
  });

  it('flags the same fetch spelled as a static find', () => {
    const viaFind = SHIPPED.replace(
      `select firstonly AslFinSK_QualityTier from oldRecord
                where oldRecord.RecId == this.RecId;`,
      'oldRecord = AslFinCore_TaxTransReportChangeLog::findRecId(this.RecId);',
    );
    const found = coc006(viaFind);
    expect(found).toHaveLength(1);
    expect(found[0].excerpt).toContain('findRecId(this.RecId)');
  });

  it('leaves a select of a genuinely different record alone', () => {
    // A related record fetched by a foreign key is not the buffer you hold.
    const related = SHIPPED.replace(
      'where oldRecord.RecId == this.RecId;',
      'where oldRecord.Voucher == this.Voucher;',
    );
    expect(coc006(related)).toHaveLength(0);
  });

  it('leaves the insert/update guard alone', () => {
    // `this.RecId` on its own says "am I an update" — only the comparison to
    // ANOTHER buffer's RecId means a re-read.
    expect(coc006(WITH_ORIG.replace('&& this.RecId', '&& this.RecId != 0'))).toHaveLength(0);
  });

  it('stays out of class CoC, where this is not a table buffer', () => {
    expect(coc006(SHIPPED.replace('tableStr(', 'classStr('))).toHaveLength(0);
  });

  it('ignores the pattern inside a comment', () => {
    expect(coc006(SHIPPED.replace(
      '                where oldRecord.RecId == this.RecId;',
      '                // where oldRecord.RecId == this.RecId;',
    ))).toHaveLength(0);
  });

  it('rides along with the write, as a warning and not a build failure', () => {
    const note = validateWrittenXpp(SHIPPED);
    expect(note).toContain('COC006');
    expect(note).toContain('warning(s)');
    expect(note).not.toContain('error(s)');
  });

  it('says nothing about the pre-image version', () => {
    expect(validateWrittenXpp(WITH_ORIG)).toBe('');
  });
});

describe('the inherited table data methods', () => {
  it('knows validateWrite, and answers case-insensitively as X++ does', () => {
    expect(lookupTableDataMethod('validateWrite')?.signature).toBe('public boolean validateWrite()');
    expect(lookupTableDataMethod('VALIDATEWRITE')?.name).toBe('validateWrite');
  });

  it('carries the pre-image rule on every method that has a pre-image', () => {
    for (const name of ['validateWrite', 'validateField', 'update', 'modifiedField']) {
      const contract = lookupTableDataMethod(name)!.contract.join(' ');
      expect(contract).toContain('this.orig()');
      expect(contract).toMatch(/do NOT re-read/i);
    }
  });

  it('does not claim a pre-image on insert, where there is none', () => {
    const insert = lookupTableDataMethod('insert')!.contract.join(' ');
    expect(insert).toMatch(/no pre-image/i);
  });

  it('speaks for tables only', () => {
    expect(hasTableDataMethods('table')).toBe(true);
    expect(hasTableDataMethods('class')).toBe(false);
    expect(hasTableDataMethods(undefined)).toBe(false);
  });

  it('has nothing to say about a method it does not know', () => {
    expect(lookupTableDataMethod('promptAndRun')).toBeUndefined();
  });
});

// ─── The two readers that answered "not found" ───────────────────────────────

const emptyDb = () => ({
  prepare: vi.fn(() => ({
    all: vi.fn(() => []),
    get: vi.fn(() => undefined),
    run: vi.fn(),
  })),
});

const prepareContext = (): XppServerContext => ({
  symbolIndex: {
    db: emptyDb(),
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  } as any,
  parser: {} as any,
  cache: {} as any,
  workspaceScanner: {} as any,
  hybridSearch: {} as any,
  bridge: undefined,
} as any);

describe('prepare(mode="change") on a table method the index cannot hold', () => {
  const call = async (methodName: string, objectType = 'table') => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'prepare_change',
        arguments: {
          goal: 'Block a QualityTier downgrade on write',
          objectName: 'AslFinCore_TaxTransReportChangeLog',
          objectType,
          methodName,
        },
      },
    };
    const result: any = await prepareChangeTool(request, prepareContext());
    return result.content?.[0]?.text ?? '';
  };

  it('answers with the signature instead of "(not found in symbol index)"', async () => {
    const text = await call('validateWrite');
    expect(text).toContain('public boolean validateWrite()');
    expect(text).not.toContain('(not found in symbol index)');
  });

  it('answers eligibility instead of "could not determine"', async () => {
    const text = await call('validateWrite');
    expect(text).toContain('CoC-eligible');
    expect(text).not.toContain('could not determine');
  });

  it('states the pre-image rule where the wrapper gets written', async () => {
    const text = await call('validateWrite');
    expect(text).toContain('this.orig()');
    expect(text).toMatch(/do NOT re-read/i);
  });

  it('still says "not found" for a method nothing knows', async () => {
    const text = await call('someBespokeMethod');
    expect(text).toContain('(not found in symbol index)');
  });

  it('does not answer for a class, whose methods the index really does hold', async () => {
    const text = await call('validateWrite', 'class');
    expect(text).toContain('(not found in symbol index)');
  });
});

describe('get_method(include="signature") on an inherited table method', () => {
  const tableOwnerDb = () => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => []),
      get: vi.fn(() =>
        sql.includes('file_path, model, name, type')
          ? {
              file_path: 'K:/AosService/.../AslFinCore_TaxTransReportChangeLog.xml',
              model: 'AslFinanceCore',
              name: 'AslFinCore_TaxTransReportChangeLog',
              type: 'table',
            }
          : undefined,
      ),
      run: vi.fn(),
    })),
  });

  const context = () => ({
    symbolIndex: {
      db: tableOwnerDb(),
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    },
    parser: { parseClassFile: vi.fn(async () => ({ success: false })) },
    bridge: undefined,
  } as any as XppServerContext);

  const call = async (methodName: string) => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: { className: 'AslFinCore_TaxTransReportChangeLog', methodName },
      },
    };
    return (await getMethodSignatureTool(request, context())) as any;
  };

  it('returns the signature and the contract, not a "not found" error', async () => {
    const result = await call('validateWrite');
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('public boolean validateWrite()');
    expect(text).toContain('this.orig()');
    expect(text).toContain('xRecord');
  });

  it('leaves a genuinely missing method reporting missing', async () => {
    const result = await call('someBespokeMethod');
    expect(result.isError).toBe(true);
  });
});
