/**
 * writeFormSymbols and the cleanup around it: the index keeps, per form, its `form`
 * symbol, datasources, mined patterns and the gzipped original XML in form_source,
 * so a host with only the database can show a form.
 *
 * Both writers (the full build's indexForms and update_symbol_index) go through
 * writeFormSymbols, so one set of tests covers the two. What these guard:
 *   - a re-index never duplicates datasource rows (form_datasources has no unique key);
 *   - removing a form's file removes all four kinds of row;
 *   - a table file named like a form never removes the form's rows;
 *   - clear()/clearModels() empty form_source with the other form tables.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'node:zlib';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

const FORM_FILE = 'K:\\AosService\\PackagesLocalDirectory\\Pkg\\Model\\AxForm\\SalesTable.xml';
const OTHER_SPELLING = 'Pkg/Model/AxForm/SalesTable.xml';
const XML = '<?xml version="1.0" encoding="utf-8"?>\n<AxForm><Name>SalesTable</Name></AxForm>\n';

const formData = (overrides: Record<string, unknown> = {}) => ({
  name: 'SalesTable',
  caption: '@SYS1',
  dataSources: [
    { name: 'SalesTable', table: 'SalesTable', allowEdit: true, allowCreate: true, allowDelete: false },
    { name: 'SalesLine', table: 'SalesLine', allowEdit: true, allowCreate: true, allowDelete: true },
  ],
  patternNodes: [
    { nodePath: 'Design', controlName: 'Design', controlType: 'Form', pattern: 'SimpleList', patternVersion: '1.1', childSequence: [] },
  ],
  ...overrides,
});

let index: XppSymbolIndex;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
});
afterEach(() => index.close());

const count = (table: string, where = '', ...params: unknown[]): number =>
  (index.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as any).n;

describe('writeFormSymbols', () => {
  it('writes the form symbol with its caption, datasources, patterns and stored XML', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);

    const sym = index.db.prepare(`SELECT description, file_path FROM symbols WHERE name = 'SalesTable' AND type = 'form'`).get() as any;
    expect(sym.description).toBe('@SYS1');
    expect(sym.file_path).toBe(FORM_FILE);
    expect(count('form_datasources', `WHERE form_name = 'SalesTable'`)).toBe(2);
    expect(count('form_patterns', `WHERE form_name = 'SalesTable'`)).toBe(1);

    const row = index.db.prepare(`SELECT xml_gz, indexed_at FROM form_source WHERE form_name = 'SalesTable' AND model = 'Model'`).get() as any;
    expect(gunzipSync(row.xml_gz).toString('utf-8')).toBe(XML);
    expect(Number.isNaN(Date.parse(row.indexed_at))).toBe(false);
  });

  it('writes no form_source row when no XML is given', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE);
    expect(count('form_source')).toBe(0);
    expect(count('form_datasources')).toBe(2); // everything else is still written
  });

  it('replaces on re-index: no duplicate datasources, patterns or source rows', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML.replace('SalesTable', 'SalesTable2'));

    expect(count('form_datasources')).toBe(2);
    expect(count('form_patterns')).toBe(1);
    expect(count('form_source')).toBe(1);
    const row = index.db.prepare(`SELECT xml_gz FROM form_source`).get() as any;
    expect(gunzipSync(row.xml_gz).toString('utf-8')).toContain('SalesTable2');
  });

  it('does not duplicate datasources when the stored path spelling differs from the new one', () => {
    // removeSymbolsByFile cannot map a build-agent spelling onto a local path, so the
    // incremental write finds the old rows under a spelling it does not recognise. The
    // helper's own delete-by-(form, model) is what keeps the where-used list honest.
    index.writeFormSymbols(formData(), 'Model', OTHER_SPELLING, XML);
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);

    expect(count('form_datasources')).toBe(2);
  });

  it('replaces the datasource set, not merges it, when a datasource was removed', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
    index.writeFormSymbols(formData({ dataSources: [{ name: 'SalesTable', table: 'SalesTable' }] }), 'Model', FORM_FILE, XML);

    expect(count('form_datasources')).toBe(1);
  });

  it('replaces rows written under a differently-cased model name', () => {
    // The reader matches model NOCASE, so the delete has to as well, or the old rows stay.
    index.writeFormSymbols(formData(), 'FOUNDATION', FORM_FILE, XML);
    index.writeFormSymbols(formData({ dataSources: [{ name: 'SalesTable', table: 'SalesTable' }] }), 'Foundation', FORM_FILE, XML);

    expect(count('form_datasources')).toBe(1);
    expect(count('form_source')).toBe(1);
  });

  it('keeps a same-named form in another model apart', () => {
    index.writeFormSymbols(formData(), 'ModelA', FORM_FILE, XML);
    index.writeFormSymbols(formData(), 'ModelB', 'K:\\x\\AxForm\\SalesTable.xml', XML);
    index.writeFormSymbols(formData({ dataSources: [] }), 'ModelB', 'K:\\x\\AxForm\\SalesTable.xml', XML);

    expect(count('form_datasources', `WHERE model = 'ModelA'`)).toBe(2);
    expect(count('form_datasources', `WHERE model = 'ModelB'`)).toBe(0);
    expect(count('form_source')).toBe(2);
  });

  it('rolls the whole form back when a write fails midway', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
    // A datasource with a throwing getter makes the write fail after the delete.
    const bad = formData({
      dataSources: [{ name: 'X', get table(): string { throw new Error('boom'); } }],
    });
    expect(() => index.writeFormSymbols(bad, 'Model', FORM_FILE, XML)).toThrow('boom');

    // The previous state is intact: nothing half-written, nothing half-deleted.
    expect(count('form_datasources')).toBe(2);
    expect(count('form_source')).toBe(1);
  });
});

describe('removeSymbolsByFile and form_source', () => {
  it('removes the form symbol, datasources, patterns and stored XML with the file', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);

    const { objectNames } = index.removeSymbolsByFile(FORM_FILE);

    expect(objectNames).toEqual(['SalesTable']);
    expect(count('symbols', `WHERE type = 'form'`)).toBe(0);
    expect(count('form_datasources')).toBe(0);
    expect(count('form_patterns')).toBe(0);
    expect(count('form_source')).toBe(0);
  });

  it('removes them when called with another spelling of the stored path', () => {
    index.writeFormSymbols(formData(), 'Model', OTHER_SPELLING, XML);
    index.removeSymbolsByFile(FORM_FILE);
    expect(count('form_source')).toBe(0);
    expect(count('form_datasources')).toBe(0);
  });

  it('leaves a form alone when a TABLE of the same name has its file removed', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
    const tableFile = 'K:\\AosService\\PackagesLocalDirectory\\Pkg\\Model\\AxTable\\SalesTable.xml';
    index.addSymbol({ name: 'SalesTable', type: 'table', filePath: tableFile, model: 'Model' } as any);

    const { objectNames } = index.removeSymbolsByFile(tableFile);

    expect(objectNames).toEqual(['SalesTable']);
    expect(count('symbols', `WHERE type = 'form'`)).toBe(1);
    expect(count('form_datasources')).toBe(2);
    expect(count('form_patterns')).toBe(1);
    expect(count('form_source')).toBe(1);
  });

  it('returns every top-level name, forms and non-forms', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
    index.addSymbol({ name: 'Helper', type: 'class', filePath: FORM_FILE, model: 'Model' } as any);

    const { objectNames } = index.removeSymbolsByFile(FORM_FILE);

    expect(objectNames.sort()).toEqual(['Helper', 'SalesTable']);
  });
});

describe('clear and clearModels', () => {
  it('clear() empties form_source', () => {
    index.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
    index.clear();
    expect(count('form_source')).toBe(0);
  });

  it('clearModels() removes only the named model\'s stored forms', () => {
    index.writeFormSymbols(formData(), 'ModelA', FORM_FILE, XML);
    index.writeFormSymbols(formData(), 'ModelB', 'K:\\y\\AxForm\\SalesTable.xml', XML);

    index.clearModels(['ModelA']);

    expect(count('form_source', `WHERE model = 'ModelA'`)).toBe(0);
    expect(count('form_source', `WHERE model = 'ModelB'`)).toBe(1);
  });
});

describe('schema', () => {
  it('adds form_source to an existing database that never had it, keeping its rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-source-'));
    const dbPath = path.join(dir, 'm.db');
    const labelsPath = path.join(dir, 'l.db');
    try {
      const first = new XppSymbolIndex(dbPath, labelsPath);
      first.writeFormSymbols(formData(), 'Model', FORM_FILE, XML);
      first.db.exec('DROP TABLE form_source'); // what a database built before this change looks like
      first.close();

      const reopened = new XppSymbolIndex(dbPath, labelsPath);
      try {
        const n = (reopened.db.prepare('SELECT COUNT(*) AS n FROM form_source').get() as any).n;
        expect(n).toBe(0);
        const forms = (reopened.db.prepare(`SELECT COUNT(*) AS n FROM symbols WHERE type = 'form'`).get() as any).n;
        expect(forms).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
