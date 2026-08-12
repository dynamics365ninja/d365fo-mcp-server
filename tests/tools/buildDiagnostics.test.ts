/**
 * A build failed, the parser recognised none of its diagnostics, and the tool
 * printed "❌ Build FAILED" over "0 error(s), 1 warning(s)" — the warning
 * unrelated. With no stated cause the caller guessed one, then deleted the form
 * extension it had been asked to create; the next build passed, which made the
 * deletion look like a fix.
 *
 * Two smaller defects from the same run are pinned here as well.
 */

import { describe, it, expect } from 'vitest';
import {
  parseXppcDiagnostics,
  formatStructuredDiagnostics,
  renderUnexplainedFailure,
  xppcReportedErrorCount,
} from '../../src/tools/sdlc/buildProject';
import { runRules } from '../../src/tools/analysis/validateXpp';

/** Real xppc log shapes. Only the first of these five used to be recognised. */
const LOG = `AslFinanceSK compilation completed.
Elapsed time: 00:00:21

--- xppc compiler diagnostics ---
==================================
Compile Warning: Class Method dynamics://Class/LogisticsPostalAddressAslFinSK_Extension/Method/aslFinSK_makeStreet: [(7,5),(50,6)]: The 'Server'  keyword has been deprecated, please remove it from the method definition.
Metadata Warning: AxTableExtension/SalesOrderHeaderV2Staging.AslFinSKExtension: Referenced object 'SalesOrderHeaderV2Staging' is marked as obsolete.
FormPatternValidation Warning: AxFormExtension/ProjInvoiceJournalV2.AslFinSKExtension/Design/Controls/TabHeading/Overview: 'AxFormExtension/…/Overview' has not specified a pattern. Please apply one of the available patterns.
Metadata Error: AxFormExtension/AslFinCore_TaxTransReportChangeLog.AslFinSKExtension/Design/Controls/Identification/Identification_AslFinSK_QualityTier: Duplicate control name.
FormPatternValidation Error: AxFormExtension/AslFinCore_TaxTransReportChangeLog.AslFinSKExtension/Design/Controls/Identification: does not conform to pattern SimpleList.
==================================
Errors: 2
Warnings: 3
`;

describe('xppc diagnostics — the whole severity family, not five literals', () => {
  const diags = parseXppcDiagnostics(LOG);

  it('finds the errors the old parser reported as zero', () => {
    const errors = diags.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(2);
    expect(errors.map(e => e.kind).sort()).toEqual(['FormPatternValidation', 'Metadata']);
  });

  it('locates the object and the member from the path form', () => {
    const dup = diags.find(d => d.message === 'Duplicate control name.');
    expect(dup?.model).toBe('AxFormExtension');
    expect(dup?.object).toBe('AslFinCore_TaxTransReportChangeLog.AslFinSKExtension');
    expect(dup?.member).toContain('Identification_AslFinSK_QualityTier');
  });

  it('still parses the dynamics:// form with line and column', () => {
    const dep = diags.find(d => d.message.includes('Server'));
    expect(dep?.severity).toBe('warning');
    expect(dep?.object).toBe('LogisticsPostalAddressAslFinSK_Extension');
    expect(dep?.line).toBe(7);
    expect(dep?.column).toBe(5);
  });

  it('picks up the Metadata and FormPatternValidation warnings too', () => {
    expect(diags.filter(d => d.severity === 'warning')).toHaveLength(3);
  });

  it('reads xppc own error tally', () => {
    expect(xppcReportedErrorCount(LOG)).toBe(2);
    expect(xppcReportedErrorCount('no tally here')).toBeNull();
  });

  it('does not mistake the tally lines for diagnostics', () => {
    expect(parseXppcDiagnostics('Errors: 2\nWarnings: 3\n')).toHaveLength(0);
  });

  it('lists the errors before the warnings, with locations', () => {
    const block = formatStructuredDiagnostics(diags);
    expect(block).toContain('2 error(s), 3 warning(s)');
    expect(block.indexOf('Duplicate control name')).toBeLessThan(block.indexOf('Server'));
  });
});

describe('a failure this parser cannot explain must say so', () => {
  it('names the gap and forbids deleting work to clear it', () => {
    const note = renderUnexplainedFailure([], 'Errors: 1\nWarnings: 0\n');
    expect(note).toContain('no error diagnostic');
    expect(note).toContain('Errors: 1');
    expect(note).toContain('Do NOT delete, undo or unregister');
  });

  it('warns that listed warnings are not the failure', () => {
    // The trap: FAILED, plus one unrelated warning.
    const onlyWarning = parseXppcDiagnostics(
      "Compile Warning: Class Method dynamics://Class/X/Method/y: [(7,5)]: The 'Server' keyword has been deprecated.\n",
    );
    const note = renderUnexplainedFailure(onlyWarning, 'Errors: 1\nWarnings: 1\n');
    expect(note).toContain('are NOT the failure');
  });

  it('reports a shortfall when xppc counted more errors than were parsed', () => {
    const one = parseXppcDiagnostics('Compile Error: something went wrong\n');
    expect(renderUnexplainedFailure(one, 'Errors: 4\nWarnings: 0\n')).toContain('only 1 could be parsed');
  });

  it('stays silent when the parsed errors do explain the failure', () => {
    const diags = parseXppcDiagnostics(LOG);
    expect(renderUnexplainedFailure(diags, LOG)).toBe('');
  });
});

describe('BP005 spans the whole call, not one line', () => {
  const bp005 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'BP005');

  it('flags a wrapped strFmt that a per-line scan reported clean', () => {
    const code = `[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        if (ret && this.AslFinSK_QualityTier < this.orig().AslFinSK_QualityTier)
        {
            ret = checkFailed(strFmt("@AslFinSK:QualityTierDowngradeNotAllowed",
                enum2Symbol(enumNum(AslFinSK_QualityTier), enum2int(this.orig().AslFinSK_QualityTier)),
                enum2Symbol(enumNum(AslFinSK_QualityTier), enum2int(this.AslFinSK_QualityTier))));
        }

        return ret;
    }
}`;
    const found = bp005(code);
    expect(found).toHaveLength(2);
    expect(found.map(v => v.line)).toEqual([11, 12]);
  });

  it('still flags the single-line form, and the DictEnum method too', () => {
    expect(bp005('info(strFmt("@X:Y", enum2Symbol(enumNum(Tier), i)));')).toHaveLength(1);
    expect(bp005('info(strFmt("@X:Y", dictEnum.value2Symbol(i)));')).toHaveLength(1);
  });

  it('leaves a symbol outside a message alone', () => {
    // The symbol is the ONLY safe thing to persist for an extensible enum.
    expect(bp005('str key = enum2Symbol(enumNum(Tier), i);')).toHaveLength(0);
    expect(bp005('fileName = dictEnum.value2Symbol(i) + ".txt";')).toHaveLength(0);
  });

  it('leaves enum2str in a message alone — it resolves the label', () => {
    // The rule used to flag exactly this and send callers to DictEnum instead.
    // Microsoft ships enum2str inside checkFailed, throw error and control captions.
    expect(bp005('info(strFmt("@X:Y", enum2str(tier)));')).toHaveLength(0);
    expect(bp005('ret = checkFailed(strFmt("@X:Y", enum2str(a), enum2str(b)));')).toHaveLength(0);
  });

  it('ignores it inside a comment', () => {
    expect(bp005('// info(strFmt("@X:Y", enum2Symbol(enumNum(Tier), i)));')).toHaveLength(0);
  });
});

/**
 * Run 7b8de4ba wrote enum2Str with enum2Symbol's two arguments. xppc caught it,
 * but only after a 76 s compile — then a repair call and two more builds, ~9 AIU
 * and 130 s for a mistake that is visible in the source as written.
 */
describe('FN001 — fixed-arity built-ins', () => {
  const fn001 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'FN001');

  it('flags the 2-argument enum2Str that failed the build', () => {
    const code = `ret = checkFailed(strFmt("@AslFinSK:QualityTierDowngradeError",
                enum2Str(enumNum(AslFinSK_QualityTier), this.orig().AslFinSK_QualityTier),
                enum2Str(enumNum(AslFinSK_QualityTier), this.AslFinSK_QualityTier)));`;
    const found = fn001(code);
    expect(found).toHaveLength(2);
    expect(found.map(v => v.line)).toEqual([2, 3]);
    expect(found[0].severity).toBe('error');
    // The compiler's own wording, so the finding and the build log read alike.
    expect(found[0].fix).toContain("'enum2Str' expects 1 argument(s), but 2 specified");
  });

  it('says nothing about the correct arities', () => {
    expect(fn001('ret = checkFailed(strFmt("@X:Y", enum2Str(a), enum2Str(b)));')).toHaveLength(0);
    expect(fn001('str key = enum2Symbol(enumNum(Tier), i);')).toHaveLength(0);
    expect(fn001('Tier t = symbol2Enum(enumNum(Tier), s);')).toHaveLength(0);
  });

  it('flags the mirrored mistake — a neighbour called with one argument', () => {
    const found = fn001('str key = enum2Symbol(this.Tier);');
    expect(found).toHaveLength(1);
    expect(found[0].fix).toContain('enum2Symbol(enumNum(MyEnum), value)');
  });

  it('counts nested calls and string commas as one argument each', () => {
    // enum2Str's single argument is itself a call; the comma inside the literal
    // is masked. Neither is a top-level separator.
    expect(fn001('info(enum2Str(this.orig().Tier));')).toHaveLength(0);
    expect(fn001('info(strFmt("a, b, c", enum2Str(t)));')).toHaveLength(0);
  });

  it('leaves a same-named method on another object alone', () => {
    expect(fn001('s = converter.enum2Str(id, value);')).toHaveLength(0);
  });

  it('ignores comments, strings and a call cut off mid-snippet', () => {
    expect(fn001('// enum2Str(enumNum(Tier), v)')).toHaveLength(0);
    expect(fn001('str doc = "call enum2Str(enumNum(Tier), v) here";')).toHaveLength(0);
    expect(fn001('ret = enum2Str(enumNum(Tier), v')).toHaveLength(0);
  });
});
