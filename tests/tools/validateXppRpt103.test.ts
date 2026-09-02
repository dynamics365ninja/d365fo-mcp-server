/**
 * RPT103 — a report parameter's `UserVisibility` carrying a value the platform
 * does not know.
 *
 * The evidence, and the reason this rule exists where RPT003 was rejected on the
 * same day: a census of **all 1,057 AxReport documents** on a complete install
 * found exactly two values across **8,977 parameters** — `Hidden` (8,972) and
 * `Internal` (5). There is no `Visible`; a parameter the user should see simply
 * omits the element. Running the finished rule back over those same 1,057
 * documents produces **0 findings**, so it agrees with the measurement that
 * justified it rather than with its author's memory of it.
 *
 * Why it matters at all: an unrecognised value in a metadata element is dropped
 * by the deserializer without a word — the failure shape XML006 and XML010 exist
 * for. A parameter written `<UserVisibility>True</UserVisibility>` to hide it
 * stays visible, the build is green, and an internal parameter is shown to the
 * user. Nothing else in the toolchain reads this file.
 *
 * Severity is WARNING on purpose. The census proves those are the only values
 * SHIPPED, which is not the same as proving the platform rejects a third, and a
 * warning is what that evidence supports.
 */

import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';

const rpt103 = (xml: string) => runRules(xml, 'xml-report').filter(v => v.rule === 'RPT103');

const parameter = (visibility: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxReport>
  <Name>MyReport</Name>
  <ReportParameterBases>
    <AxReportParameterBase xmlns="" i:type="AxReportParameter">
      <Name>MyDateFrom</Name>
      <UserVisibility>${visibility}</UserVisibility>
    </AxReportParameterBase>
  </ReportParameterBases>
</AxReport>`;

describe('RPT103 accepts what the platform ships', () => {
  it('accepts Hidden — 8,972 of 8,977 shipped parameters', () => {
    expect(rpt103(parameter('Hidden'))).toEqual([]);
  });

  it('accepts Internal — the other five', () => {
    expect(rpt103(parameter('Internal'))).toEqual([]);
  });

  it('is case-insensitive, as XML metadata comparisons are elsewhere', () => {
    expect(rpt103(parameter('hidden'))).toEqual([]);
  });

  it('says nothing about a VISIBLE parameter, which omits the element', () => {
    const xml = `<?xml version="1.0"?>
<AxReport>
  <ReportParameterBases>
    <AxReportParameterBase xmlns="" i:type="AxReportParameter">
      <Name>MyDateFrom</Name>
      <AllowBlank>true</AllowBlank>
      <PromptString>@MyModel:FromDate</PromptString>
    </AxReportParameterBase>
  </ReportParameterBases>
</AxReport>`;
    expect(rpt103(xml)).toEqual([]);
  });
});

describe('RPT103 catches the silent ones', () => {
  it('catches "Visible", the value a developer would reach for', () => {
    // It reads as the obvious opposite of Hidden and does not exist.
    const v = rpt103(parameter('Visible'));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('warning');
    expect(v[0].fix).toContain('omits the element entirely');
  });

  it('catches a boolean written where an enum belongs', () => {
    // The dangerous direction: meant to HIDE, silently shown.
    expect(rpt103(parameter('True'))).toHaveLength(1);
    expect(rpt103(parameter('Yes'))).toHaveLength(1);
  });

  it('reports one finding per offending parameter', () => {
    const xml = `<?xml version="1.0"?>
<AxReport>
  <ReportParameterBases>
    <AxReportParameterBase xmlns="" i:type="AxReportParameter">
      <Name>A</Name><UserVisibility>Visible</UserVisibility>
    </AxReportParameterBase>
    <AxReportParameterBase xmlns="" i:type="AxReportParameter">
      <Name>B</Name><UserVisibility>Hidden</UserVisibility>
    </AxReportParameterBase>
    <AxReportParameterBase xmlns="" i:type="AxReportParameter">
      <Name>C</Name><UserVisibility>Shown</UserVisibility>
    </AxReportParameterBase>
  </ReportParameterBases>
</AxReport>`;
    expect(rpt103(xml)).toHaveLength(2);
  });
});

describe('RPT103 stays in its own lane', () => {
  it('does not run on X++ — this is a metadata rule', () => {
    // `runRules(code, 'xpp')` must not carry report XML rules; a class that
    // happens to contain the string would otherwise be reported.
    const xpp = `class MyThing
{
    public void run()
    {
        str s = '<UserVisibility>Visible</UserVisibility>';
        info(s);
    }
}`;
    expect(runRules(xpp, 'xpp').filter(v => v.rule === 'RPT103')).toEqual([]);
  });
});
