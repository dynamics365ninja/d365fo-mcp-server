/**
 * Form Design property upsert — finding #37 (forms half).
 *
 * The bridge rejects modify-property for AxForm outright, so the Design
 * annotations object_patterns(action="spec") prescribes (Pattern / PatternVersion
 * / Style) had no grounded path at all and the emitted form carried no Pattern
 * declaration. Corpus: 2026-07-22T04__L2-form-over-view.
 *
 * Shape/order ground truth: eval/goldens/L1-form-listpage (VM-captured, clean build).
 */

import { describe, it, expect } from 'vitest';
import { upsertAxFormDesignProperty } from '../../src/utils/axFormDesignProperties';

const FORM = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoActiveList</Name>
\t<SourceCode>
\t\t<Methods />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource>
\t\t\t<Name>ConDemoActiveView</Name>
\t\t\t<Table>ConDemoActiveView</Table>
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
\t\t<Caption xmlns="">@Contoso:List</Caption>
\t\t<DataSource xmlns="">ConDemoActiveView</DataSource>
\t\t<TitleDataSource xmlns="">ConDemoActiveView</TitleDataSource>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns="" i:type="AxFormGridControl">
\t\t\t\t<Name>Grid</Name>
\t\t\t\t<Caption>@Contoso:GridCaption</Caption>
\t\t\t\t<Style>Tabular</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
</AxForm>`;

describe('upsertAxFormDesignProperty (#37 forms half)', () => {
  it('inserts Pattern in alphabetical order among Design properties', () => {
    const out = upsertAxFormDesignProperty(FORM, 'Pattern', 'ListPage')!;
    expect(out).toBeTruthy();
    expect(out).toMatch(
      /<DataSource xmlns="">ConDemoActiveView<\/DataSource>\s*\n\s*<Pattern xmlns="">ListPage<\/Pattern>\s*\n\s*<TitleDataSource/,
    );
  });

  it('inserts Style after Pattern/PatternVersion and before TitleDataSource', () => {
    let out = upsertAxFormDesignProperty(FORM, 'Pattern', 'ListPage')!;
    out = upsertAxFormDesignProperty(out, 'PatternVersion', 'UX7 1.0')!;
    out = upsertAxFormDesignProperty(out, 'Style', 'ListPage')!;
    const design = /<Design>([\s\S]*?)<Controls/.exec(out)![1];
    const order = [...design.matchAll(/<([A-Za-z]+) xmlns="">/g)].map(m => m[1]);
    expect(order).toEqual(['Caption', 'DataSource', 'Pattern', 'PatternVersion', 'Style', 'TitleDataSource']);
  });

  it('never touches a control that carries the same property name', () => {
    const out = upsertAxFormDesignProperty(FORM, 'Style', 'ListPage')!;
    // The grid's own Style survives untouched — this is exactly what made the
    // generic single-match fallback refuse to act.
    expect(out).toContain('<Style>Tabular</Style>');
    expect(out).toContain('<Style xmlns="">ListPage</Style>');
  });

  it('replaces an existing Design property in place', () => {
    const out = upsertAxFormDesignProperty(FORM, 'Caption', '@Contoso:Renamed')!;
    expect(out).toContain('<Caption xmlns="">@Contoso:Renamed</Caption>');
    expect(out).not.toContain('<Caption xmlns="">@Contoso:List</Caption>');
    // No duplicate.
    expect((out.match(/<Caption xmlns="">/g) ?? []).length).toBe(1);
  });

  it('appends when nothing sorts after it', () => {
    const out = upsertAxFormDesignProperty(FORM, 'WindowType', 'Popup')!;
    expect(out).toMatch(/<TitleDataSource xmlns="">[^<]*<\/TitleDataSource>\s*\n\s*<WindowType xmlns="">Popup<\/WindowType>\s*\n\s*<Controls/);
  });

  it('returns null for a non-Design property rather than inventing one', () => {
    expect(upsertAxFormDesignProperty(FORM, 'TableGroup', 'Main')).toBeNull();
  });

  it('returns null for a non-form document', () => {
    expect(upsertAxFormDesignProperty('<AxTable><Name>T</Name></AxTable>', 'Pattern', 'ListPage')).toBeNull();
  });
});
