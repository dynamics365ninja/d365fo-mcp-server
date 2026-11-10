import { describe, it, expect } from 'vitest';
import {
  findDesignControls,
  scanDirectChildren,
  planInsertions,
  repairFormXml,
} from '../../src/utils/formControlRepair';
import { resolvePatternExact } from '../../src/knowledge/formPatterns/index';
import { validateFormPatternXml } from '../../src/validation/formPatternValidator';

// A SimpleList form that is MISSING the required ActionPane (only a Grid).
const simpleListMissingActionPane = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>TestRepairForm</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method><Name>classDeclaration</Name><Source><![CDATA[
[Form]
public class TestRepairForm extends FormRun
{
}
]]></Source></Method>
\t\t</Methods>
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>MyTable</Name>
\t\t\t<Table>MyTable</Table>
\t\t\t<Fields />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
\t\t<DataSource xmlns="">MyTable</DataSource>
\t\t<Pattern xmlns="">SimpleList</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Style xmlns="">SimpleList</Style>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns="" i:type="AxFormGridControl">
\t\t\t\t<Name>Grid</Name>
\t\t\t\t<Type>Grid</Type>
\t\t\t\t<FormControlExtension i:nil="true" />
\t\t\t\t<Controls />
\t\t\t\t<DataSource>MyTable</DataSource>
\t\t\t\t<Style>Tabular</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>`;

describe('findDesignControls', () => {
  it('finds the Design-level Controls inner span (not SourceCode/nested)', () => {
    const loc = findDesignControls(simpleListMissingActionPane);
    expect(loc).not.toBeNull();
    expect(loc!.selfClosed).toBe(false);
    const inner = simpleListMissingActionPane.slice(loc!.innerStart, loc!.innerEnd);
    expect(inner).toContain('AxFormGridControl');
    expect(inner).not.toContain('<Pattern'); // Pattern is a Design sibling, not inside Controls
  });

  it('flags a self-closed Controls element', () => {
    const loc = findDesignControls('<Design>\n<Pattern xmlns="">X</Pattern>\n<Controls xmlns="" />\n</Design>');
    expect(loc?.selfClosed).toBe(true);
  });
});

describe('scanDirectChildren', () => {
  it('counts only top-level controls, ignoring nested ones', () => {
    const inner = `
      <AxFormControl i:type="AxFormActionPaneControl"><Name>AP</Name><Type>ActionPane</Type>
        <Controls>
          <AxFormControl i:type="AxFormButtonGroupControl"><Name>BG</Name><Type>ButtonGroup</Type><Controls /></AxFormControl>
        </Controls>
      </AxFormControl>
      <AxFormControl i:type="AxFormGridControl"><Name>Grid</Name><Type>Grid</Type><Controls /></AxFormControl>`;
    const children = scanDirectChildren(inner);
    expect(children.map((c) => c.type)).toEqual(['ActionPane', 'Grid']);
  });
});

describe('planInsertions', () => {
  it('marks a missing required control and anchors it correctly', () => {
    const spec = resolvePatternExact('SimpleList')!;
    const existing = [{ type: 'Grid', start: 0, end: 10 }];
    const { missing } = planInsertions(spec.root, existing);
    const ids = missing.map((m) => m.spec.id);
    expect(ids).toContain('ActionPane');
    // ActionPane is first in spec order and Grid hasn't been consumed before it → prepend
    expect(missing.find((m) => m.spec.id === 'ActionPane')!.anchorIndex).toBe(-1);
  });
});

describe('repairFormXml — end to end', () => {
  it('adds the missing ActionPane and drives pattern errors to zero', async () => {
    const before = await validateFormPatternXml(simpleListMissingActionPane);
    const beforeErrors = before.violations.filter((v) => v.severity === 'error');
    expect(beforeErrors.some((v) => v.rule === 'FP003')).toBe(true); // ActionPane missing

    const spec = resolvePatternExact('SimpleList')!;
    const result = repairFormXml(simpleListMissingActionPane, spec, {
      formName: 'TestRepairForm',
      dsName: 'MyTable',
      dsTable: 'MyTable',
    });

    expect(result.changed).toBe(true);
    expect(result.added.map((a) => a.type)).toContain('ActionPane');

    const after = await validateFormPatternXml(result.xml);
    const afterErrors = after.violations.filter((v) => v.severity === 'error');
    expect(afterErrors).toEqual([]);

    // existing Grid preserved verbatim
    expect(result.xml).toContain('<Name>Grid</Name>');
    // ActionPane inserted before the Grid (spec order)
    expect(result.xml.indexOf('AxFormActionPaneControl')).toBeLessThan(result.xml.indexOf('AxFormGridControl'));
  });

  it('is a no-op when nothing required is missing', async () => {
    const spec = resolvePatternExact('SimpleList')!;
    const repaired = repairFormXml(simpleListMissingActionPane, spec, { formName: 'TestRepairForm', dsName: 'MyTable', dsTable: 'MyTable' });
    // run repair again on the already-repaired XML → no further change
    const second = repairFormXml(repaired.xml, spec, { formName: 'TestRepairForm', dsName: 'MyTable', dsTable: 'MyTable' });
    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
  });
});
