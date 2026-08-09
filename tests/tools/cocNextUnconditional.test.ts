/**
 * COC004 — the CoC mistake that only a build used to catch.
 *
 * Benchmark run f2e7b71a (9.8.) skipped build_d365fo_project, ran run_bp_check
 * instead, was told "✅ BP Check passed — 0 with findings", and shipped a
 * validateWrite whose `next` sat inside `if (ret) { ... }`. xppbp does not diagnose
 * SYS10028 and every symbol in the method resolved, so nothing else objected. The
 * previous run hit the same shape, but only because it built.
 */

import { describe, it, expect } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';

const coc = (body: string): string =>
  `[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
${body}
}`;

const rules = (code: string): string[] =>
  runRules(code, 'xpp')
    .filter(v => v.rule === 'COC004')
    .map(v => v.fix);

describe('COC004 — next must be unconditional', () => {
  it('flags the exact shape run f2e7b71a shipped', () => {
    // Verbatim from AxClass/AslFinCore_TaxTransReportChangeLogAslFinSK_Extension.xml.
    const code = coc(`    public boolean validateWrite()
    {
        boolean ret = true;

        if (enum2int(this.AslFinSK_QualityTier) < enum2int(this.orig().AslFinSK_QualityTier))
        {
            ret = checkFailed("@AslFinSK:QualityTierDowngradeNotAllowed");
        }

        if (ret)
        {
            ret = next validateWrite();
        }

        return ret;
    }`);

    const found = rules(code);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('SYS10028');
  });

  it('accepts the corrected form the previous run arrived at', () => {
    const code = coc(`    public boolean validateWrite()
    {
        boolean ret;

        ret = next validateWrite();

        if (ret && enum2int(this.AslFinSK_QualityTier) < enum2int(this.orig().AslFinSK_QualityTier))
        {
            ret = checkFailed("@AslFinSK:QualityTierDowngradeNotAllowed");
        }

        return ret;
    }`);

    expect(rules(code)).toEqual([]);
  });

  it('flags a return that can skip the next below it', () => {
    const code = coc(`    public boolean validateWrite()
    {
        if (!this.RecId)
        {
            return false;
        }

        boolean ret = next validateWrite();
        return ret;
    }`);

    expect(rules(code)[0]).toContain('not unconditional');
  });

  it('flags next called twice in one method', () => {
    const code = coc(`    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        ret = next validateWrite();
        return ret;
    }`);

    expect(rules(code).some(f => f.includes('exactly one'))).toBe(true);
  });

  it('does not confuse a next in a sibling method with this one', () => {
    const code = coc(`    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        return ret;
    }

    public boolean validateDelete()
    {
        boolean ret = next validateDelete();
        return ret;
    }`);

    expect(rules(code)).toEqual([]);
  });

  it('is not fooled by a brace inside a string or a doc comment', () => {
    const code = coc(`    /// <summary>Guards { and } in prose.</summary>
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        info("a { brace } in a literal");
        return ret;
    }`);

    expect(rules(code)).toEqual([]);
  });

  it('flags enum2str in the downgrade message the run shipped (BP005)', () => {
    const code = coc(`    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        if (!ret)
        {
            ret = checkFailed(strFmt("@AslFinSK:Downgrade", enum2str(this.orig().AslFinSK_QualityTier)));
        }
        return ret;
    }`);

    const bp005 = runRules(code, 'xpp').filter(v => v.rule === 'BP005');
    expect(bp005).toHaveLength(1);
    expect(bp005[0].fix).toContain('value2Label');
  });

  it('leaves enum2str alone outside a user-facing message', () => {
    const code = coc(`    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        str key = enum2str(this.AslFinSK_QualityTier);
        return ret;
    }`);

    expect(runRules(code, 'xpp').filter(v => v.rule === 'BP005')).toEqual([]);
  });

  it('stays silent on a plain table method that is not a CoC extension', () => {
    const code = `public class SomeTable
{
    public boolean validateWrite()
    {
        boolean ret = true;
        if (ret)
        {
            ret = next validateWrite();
        }
        return ret;
    }
}`;

    expect(rules(code)).toEqual([]);
  });
});
