/**
 * find_references, name-based fallback: a table target lists the forms that bind it as
 * a datasource, from the index's form_datasources.
 *
 * The fallback used to say form data sources were "recorded only in the cross-reference
 * database" although the index holds exactly that relation. What these guard:
 *   - the match is NOCASE (some rows store a mis-cased table_name) and counts FORMS,
 *     not datasource rows (a form can bind a table twice);
 *   - the cap and the "N more" line count forms;
 *   - an empty form_datasources reads "not indexed", never as a confident zero;
 *   - when only forms match, the "no references" line says X++ code, not everything;
 *   - a class target gets no such section.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

let index: XppSymbolIndex;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
});
afterEach(() => index.close());

const addTable = (name: string) =>
  index.addSymbol({ name, type: 'table', filePath: `K:\\x\\AxTable\\${name}.xml`, model: 'Foundation' } as any);

const addForm = (name: string, dataSources: Array<{ name: string; table: string }>, model = 'Foundation') =>
  index.writeFormSymbols({ name, dataSources }, model, `K:\\x\\AxForm\\${name}.xml`);

const run = async (args: Record<string, unknown>): Promise<string> =>
  (await findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: index } as any,
  )).content[0].text as string;

describe('find_references — forms using a table', () => {
  it('lists forms with their datasources, matching a mis-cased table_name too', async () => {
    addTable('InventDim');
    addForm('InventDimSetup', [{ name: 'InventDim', table: 'InventDim' }]);
    // The form XML spelled the table differently from its declaration.
    addForm('BOMDesigner', [{ name: 'InventDim', table: 'InventDIm' }]);
    // One form binding the table twice is one form, with both datasources named.
    addForm('Twice', [{ name: 'A', table: 'InventDim' }, { name: 'B', table: 'InventDim' }]);
    addForm('Unrelated', [{ name: 'X', table: 'CustTable' }]);

    const text = await run({ targetName: 'InventDim', targetType: 'table' });

    expect(text).toContain('Forms using `InventDim` as a datasource');
    expect(text).toContain('are listed below');
    expect(text).toContain('**Forms:** 3');
    expect(text).toContain('`InventDimSetup` (Foundation)');
    expect(text).toContain('`BOMDesigner` (Foundation)');
    expect(text).toMatch(/`Twice` \(Foundation\) — datasources: A, B/);
    expect(text).not.toContain('Unrelated');
  });

  it('caps at the limit and counts the rest in forms, not datasource rows', async () => {
    addTable('SalesTable');
    addForm('F1', [{ name: 'a', table: 'SalesTable' }, { name: 'b', table: 'SalesTable' }]);
    addForm('F2', [{ name: 'a', table: 'SalesTable' }]);
    addForm('F3', [{ name: 'a', table: 'SalesTable' }]);
    addForm('F4', [{ name: 'a', table: 'SalesTable' }]);

    const text = await run({ targetName: 'SalesTable', targetType: 'table', limit: 2 });

    expect(text).toContain('**Forms:** 4');
    expect(text).toContain('`F1`');
    expect(text).toContain('`F2`');
    expect(text).not.toContain('`F3`');
    expect(text).toContain('and 2 more');
  });

  it('says nothing is indexed, rather than "no forms", when form_datasources is empty', async () => {
    addTable('SalesTable');

    const text = await run({ targetName: 'SalesTable', targetType: 'table' });

    expect(text).toContain('No form datasources indexed');
    expect(text).not.toContain('No base forms use this table');
    // The warning must not promise a list the section then cannot give.
    expect(text).not.toContain('are listed below');
  });

  it('says no base form uses it when the table is indexed but unused', async () => {
    addTable('LonelyTable');
    addForm('F1', [{ name: 'a', table: 'SalesTable' }]);

    const text = await run({ targetName: 'LonelyTable', targetType: 'table' });

    expect(text).toContain('No base forms use this table as a datasource (form extensions are not indexed)');
  });

  it('words the empty code result as X++ code only when forms matched', async () => {
    addTable('SalesTable');
    addForm('F1', [{ name: 'a', table: 'SalesTable' }]);

    const withForms = await run({ targetName: 'SalesTable', targetType: 'table' });
    expect(withForms).toContain('No X++ code references found');
    expect(withForms).toContain('**Total References Found:** 0');

    addTable('Other');
    const withoutForms = await run({ targetName: 'Other', targetType: 'table' });
    expect(withoutForms).toContain('No references found for `Other`');
    expect(withoutForms).not.toContain('No X++ code references found');
  });

  it('keeps the table warning phrases the fallback is asserted on', async () => {
    addTable('SalesTable');
    const text = await run({ targetName: 'SalesTable', targetType: 'table' });
    expect(text).toContain('For a table this counts X++ code only');
    expect(text).toContain('form data sources');
  });

  it('adds no forms section for a class', async () => {
    index.addSymbol({ name: 'MyCalc', type: 'class', filePath: 'K:\\x\\AxClass\\MyCalc.xml', model: 'Foundation' } as any);
    addForm('F1', [{ name: 'a', table: 'MyCalc' }]);

    const text = await run({ targetName: 'MyCalc', targetType: 'class' });

    expect(text).not.toContain('as a datasource');
  });
});
