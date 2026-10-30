/**
 * update_symbol_index on a real form file: the incremental path keeps everything the
 * full build keeps for a form, so a changed, created or deleted form updates the
 * database without a rebuild.
 *
 * It used to write the `form` symbol only: a changed form's datasources stayed as the
 * last full build left them, and a removed form's datasource and pattern rows stayed
 * behind. Real files and a real index on purpose — the point is that the pieces agree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'node:zlib';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { indexOneFile } from '../../src/tools/sdlc/updateSymbolIndex';

const formXml = (table: string, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AxForm">
\t<Name>IncrementalDemoForm</Name>
\t<Caption>@DemoCaption</Caption>
\t<SourceCode>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[public class FormRun extends FormRun {}]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>Main</Name>
\t\t\t<Table>${table}</Table>
\t\t</AxFormDataSource>${extra}
\t</DataSources>
\t<Design>
\t\t<Caption>Demo</Caption>
\t\t<Pattern xmlns="">SimpleList</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Controls />
\t</Design>
</AxForm>`;

let index: XppSymbolIndex;
let root: string;
let file: string;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-form-'));
  const dir = path.join(root, 'PackagesLocalDirectory', 'DemoPkg', 'DemoPkg', 'AxForm');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'IncrementalDemoForm.xml');
});
afterEach(() => {
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const ctx = () => ({ symbolIndex: index } as any);
const rows = (sql: string) => index.db.prepare(sql).all() as any[];

describe('indexOneFile — a form', () => {
  it('writes the form symbol, datasources, patterns and stored XML for a new form', async () => {
    fs.writeFileSync(file, formXml('SalesTable'));

    const res = await indexOneFile(file, ctx());

    expect(res.isError).toBe(false);
    expect(rows(`SELECT description FROM symbols WHERE name = 'IncrementalDemoForm' AND type = 'form'`)[0]?.description).toBe('@DemoCaption');
    expect(rows(`SELECT datasource_name, table_name FROM form_datasources`)).toEqual([
      { datasource_name: 'Main', table_name: 'SalesTable' },
    ]);
    expect(rows(`SELECT pattern FROM form_patterns`).map(r => r.pattern)).toContain('SimpleList');
    const src = rows(`SELECT xml_gz FROM form_source WHERE form_name = 'IncrementalDemoForm'`)[0];
    expect(gunzipSync(src.xml_gz).toString('utf-8')).toBe(formXml('SalesTable'));
  });

  it('follows an edit: the datasource set and stored XML are replaced, not accumulated', async () => {
    fs.writeFileSync(file, formXml('SalesTable'));
    await indexOneFile(file, ctx());

    const edited = formXml('CustTable', `
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>Lines</Name>
\t\t\t<Table>SalesLine</Table>
\t\t</AxFormDataSource>`);
    fs.writeFileSync(file, edited);
    await indexOneFile(file, ctx());

    expect(rows(`SELECT table_name FROM form_datasources ORDER BY table_name`).map(r => r.table_name))
      .toEqual(['CustTable', 'SalesLine']);
    expect(rows(`SELECT COUNT(*) AS n FROM form_source`)[0].n).toBe(1);
    const src = rows(`SELECT xml_gz FROM form_source`)[0];
    expect(gunzipSync(src.xml_gz).toString('utf-8')).toBe(edited);
  });

  it('removes every kind of row when the form file is deleted', async () => {
    fs.writeFileSync(file, formXml('SalesTable'));
    await indexOneFile(file, ctx());
    fs.rmSync(file);

    await indexOneFile(file, ctx());

    expect(rows(`SELECT COUNT(*) AS n FROM symbols WHERE type = 'form'`)[0].n).toBe(0);
    expect(rows(`SELECT COUNT(*) AS n FROM form_datasources`)[0].n).toBe(0);
    expect(rows(`SELECT COUNT(*) AS n FROM form_patterns`)[0].n).toBe(0);
    expect(rows(`SELECT COUNT(*) AS n FROM form_source`)[0].n).toBe(0);
  });
});
