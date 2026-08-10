/**
 * Four defects from one benchmark run: `this.checkFailed(...)` written into a
 * table CoC with nothing objecting until the build; replace-code turning
 * `this.checkFailed` into `this.this.checkFailed` and reporting only "✅ Code
 * replaced"; and a compiler error about a METHOD diagnosed as a missing FIELD.
 *
 * Inputs below are verbatim from that run.
 */

import { describe, it, expect } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';
import { validateWrittenXpp, extractDeclaration } from '../../src/tools/write/inlineXppValidation';
import { preflightReplaceCode, renderChangedLines } from '../../src/tools/write/modifyD365File';
import { lookupErrorFix, d365foErrorHelpTool } from '../../src/tools/knowledge/d365foErrorHelp';

/** A CoC wrapper as an agent actually wrote it. */
const SHIPPED_COC = `[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
    /// <summary>
    /// Prevents the <c>QualityTier</c> value from being downgraded on write.
    /// </summary>
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        if (ret && this.AslFinSK_QualityTier < this.orig().AslFinSK_QualityTier)
        {
            this.checkFailed(literalStr("@AslFinSK:QualityTierDowngradeNotAllowed"));
            ret = false;
        }

        return ret;
    }
}`;

/** The compiler error it produced. */
const BUILD_ERROR =
  "ClassDoesNotContainMethod: Table 'AslFinCore_TaxTransReportChangeLog' does not contain a " +
  "definition for method 'checkFailed' and no extension method 'checkFailed' accepting a first " +
  "argument of type 'AslFinCore_TaxTransReportChangeLog' is found on any extension class.";

describe('COC005 — Global functions are not members of a table buffer', () => {
  const coc005 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'COC005');

  it('flags the call that shipped', () => {
    const found = coc005(SHIPPED_COC);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].excerpt).toContain('this.checkFailed');
    expect(found[0].fix).toContain('unqualified');
  });

  it('accepts the corrected form', () => {
    expect(coc005(SHIPPED_COC.replace('this.checkFailed', 'ret = checkFailed'))).toHaveLength(0);
  });

  it('leaves genuine buffer members alone', () => {
    // this.orig() and this.validateWrite() ARE members of Common — only the Global
    // functions are not, and a rule that could not tell them apart would be noise.
    expect(coc005(SHIPPED_COC.replace('this.checkFailed', 'ret = checkFailed'))).toHaveLength(0);
    expect(SHIPPED_COC).toContain('this.orig()');
  });

  it('stays out of class CoC, where this.checkFailed() can be legal', () => {
    // On a RunBase descendant checkFailed IS an inherited member; flagging it there
    // would be wrong far more often than right.
    const classCoc = `[ExtensionOf(classStr(MyRunBaseThing))]
final class MyRunBaseThing_Ext_Extension
{
    public boolean validate()
    {
        boolean ret = next validate();
        this.checkFailed("@Sys:Nope");
        return ret;
    }
}`;
    expect(coc005(classCoc)).toHaveLength(0);
  });

  it('ignores the pattern inside a comment or a string', () => {
    const commented = SHIPPED_COC.replace(
      '            this.checkFailed(',
      '            // this.checkFailed(',
    );
    expect(coc005(commented)).toHaveLength(0);
  });
});

describe('inline validation on the write itself', () => {
  it('reports COC005 on a create, without anyone calling validate_code', () => {
    const note = validateWrittenXpp(SHIPPED_COC);
    expect(note).toContain('COC005');
    expect(note).toContain('will fail the build');
  });

  it('says nothing when the source is clean', () => {
    expect(validateWrittenXpp(SHIPPED_COC.replace('this.checkFailed', 'ret = checkFailed'))).toBe('');
  });

  it('recovers the class context so a bare method snippet is still checked', () => {
    // A modify sends the method alone; without the object's own <Declaration> the
    // class-scoped rules see no [ExtensionOf] and correctly find nothing.
    const snippet = `    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        this.checkFailed(literalStr("@AslFinSK:Nope"));
        return ret;
    }`;
    const declarationXml = `<?xml version="1.0" encoding="utf-8"?>
<AxClass>
  <Name>AslFinCore_TaxTransReportChangeLogAslFinSK_Extension</Name>
  <SourceCode>
    <Declaration><![CDATA[
[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
}
]]></Declaration>
  </SourceCode>
</AxClass>`;

    expect(validateWrittenXpp(snippet)).toBe('');
    const note = validateWrittenXpp(snippet, declarationXml);
    expect(note).toContain('COC005');
    // Line 4 of the snippet the caller sent — not line 7 of the synthetic wrapper.
    expect(note).toContain('line 4 of the code you sent');
  });

  it('reads the declaration out of AOT XML', () => {
    expect(extractDeclaration('<Declaration><![CDATA[\nfinal class X\n{\n}\n]]></Declaration>'))
      .toContain('final class X');
    expect(extractDeclaration('<AxEnum><Name>Foo</Name></AxEnum>')).toBeNull();
  });

  it('does not try to lint a table create\'s field JSON or raw XML', () => {
    expect(validateWrittenXpp('{"fields":[{"name":"Foo"}]}')).toBe('');
    expect(validateWrittenXpp('<AxTable><Name>Foo</Name></AxTable>')).toBe('');
    expect(validateWrittenXpp(undefined)).toBe('');
  });
});

describe('replace-code preflight', () => {
  /** The method source the edits below were issued against. */
  const FILE = `        boolean ret = next validateWrite();

        if (ret && this.AslFinSK_QualityTier < this.orig().AslFinSK_QualityTier)
        {
            this.checkFailed(literalStr("@AslFinSK:QualityTierDowngradeNotAllowed"));
            ret = false;
        }`;

  it('stops the edit that produced this.this.checkFailed', () => {
    const verdict = preflightReplaceCode(FILE, 'checkFailed', 'this.checkFailed');
    expect(verdict?.kind).toBe('noop');
    expect(verdict?.message).toContain('already applied');
    expect(verdict?.message).toContain('this.this.checkFailed');
  });

  it('refuses an oldCode that matches more than once, naming the lines', () => {
    const twice = `${FILE}\n        this.checkFailed(literalStr("@AslFinSK:Other"));`;
    const verdict = preflightReplaceCode(twice, 'this.checkFailed', 'checkFailed');
    expect(verdict?.kind).toBe('refuse');
    expect(verdict?.message).toContain('matches 2 times');
    expect(verdict?.message).toContain('lines 5, 8');
  });

  it('reports an already-applied edit as done, not as "oldCode not found"', () => {
    // Once the repair has landed, a retry told "oldCode must match the exact
    // source" reads as "the file is still wrong".
    const fixed = FILE.replace('this.checkFailed', 'checkFailed');
    expect(preflightReplaceCode(fixed, 'this.this.checkFailed(x);', 'checkFailed(x);')).toBeNull();

    const applied = preflightReplaceCode(fixed, 'this.checkFailed', 'checkFailed');
    expect(applied?.kind).toBe('noop');
    expect(applied?.message).toContain('Nothing to do');
  });

  it('lets an unambiguous edit through', () => {
    expect(preflightReplaceCode(FILE, 'ret = false;', 'ret = checkFailed("@X:Y");')).toBeNull();
  });
});

describe('the reply shows what changed', () => {
  it('renders the edited line with context', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng';
    const after = 'a\nb\nc\nCHANGED\ne\nf\ng';
    const note = renderChangedLines(before, after, 1);
    expect(note).toContain('› ');
    expect(note).toContain('CHANGED');
    expect(note).toContain('Result on disk');
  });

  it('stays silent when nothing moved', () => {
    expect(renderChangedLines('a\nb', 'a\nb')).toBe('');
  });
});

describe('error help does not answer questions it cannot answer', () => {
  it('no longer diagnoses a missing METHOD as a missing FIELD', () => {
    const hit = lookupErrorFix(BUILD_ERROR);
    expect(hit?.title).not.toBe('Field Does Not Exist on Table');
  });

  it('recognises ClassDoesNotContainMethod and points at the Global function', () => {
    const hit = lookupErrorFix(BUILD_ERROR);
    expect(hit?.title).toBe('Method Does Not Exist on That Type');
    expect(hit?.fix.join(' ')).toContain('checkFailed');
  });

  it('still resolves the errors it always did', () => {
    expect(lookupErrorFix('Field does not exist on table CustTable')?.title)
      .toBe('Field Does Not Exist on Table');
  });

  it('says "no match" rather than presenting a weak guess as the answer', () => {
    const res: any = d365foErrorHelpTool({
      method: 'tools/call',
      params: { name: 'get_knowledge', arguments: { errorText: 'the widget sprocket table found nothing' } },
    } as any);
    const text = res.content[0].text as string;
    if (text.startsWith('❌ No matching error pattern')) {
      expect(text).not.toContain('**What happened:**');
    } else {
      // A confident match is fine — it just has to be a real one, not word overlap.
      expect(text).toContain('**What happened:**');
    }
  });

  it('matches whole words, so a table NAME cannot vote for a field entry', () => {
    // 'table' inside "MyTableExtension" used to count as a hit for the pattern
    // 'field not found on table'.
    const hit = lookupErrorFix("Object 'MyTableExtension' could not be created here");
    expect(hit?.title).not.toBe('Field Does Not Exist on Table');
  });
});

describe('the shipped CoC still carries an untranslated message', () => {
  // next is unconditional, checkFailed is unqualified, the label takes %1/%2 —
  // every hard rule satisfied. enum2str is what remains: the two values render
  // as "Gold"/"Silver" in every locale, whatever the enum's labels say.
  const SHIPPED = `[ExtensionOf(tableStr(AslFinCore_TaxTransReportChangeLog))]
final class AslFinCore_TaxTransReportChangeLogAslFinSK_Extension
{
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        if (ret && this.RecId)
        {
            AslFinSK_QualityTier orig = this.orig().AslFinSK_QualityTier;

            if (enum2int(this.AslFinSK_QualityTier) < enum2int(orig))
            {
                ret = checkFailed(strFmt("@AslFinSK:QualityTierDowngradeError", enum2str(orig), enum2str(this.AslFinSK_QualityTier)));
            }
        }

        return ret;
    }
}`;

  it('reports BP005 and nothing more severe', () => {
    const note = validateWrittenXpp(SHIPPED);
    expect(note).toContain('BP005');
    expect(note).toContain('DictEnum');
    expect(note).not.toContain('error(s)');
  });

  it('is clean once the enum labels are resolved properly', () => {
    expect(validateWrittenXpp(SHIPPED.replace(
      'enum2str(orig), enum2str(this.AslFinSK_QualityTier)',
      'dictEnum.value2Label(enum2int(orig)), dictEnum.value2Label(enum2int(this.AslFinSK_QualityTier))',
    ))).toBe('');
  });
});
