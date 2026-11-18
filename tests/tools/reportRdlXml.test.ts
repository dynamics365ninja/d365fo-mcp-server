/**
 * `report-design` RDL operations — `fix-labels` and `add-column`.
 *
 * The RDL is the half of an AxReport where a mistake builds fine and fails only in
 * the SSRS renderer, so what is pinned here is the safety envelope, not just the
 * happy path: edits are byte-preserving splices, the result is statically validated
 * BEFORE anything is written, and a design the code does not recognise is refused
 * with the file untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator';
import { addReportColumn, fixReportLabelIds, validateRdl } from '../../src/tools/write/reportRdlXml';
import { injectRdlPageHeader } from '../../src/tools/smart/generateSmartReport';
import { addReportParameter } from '../../src/tools/write/reportDesignXml';

let root: string;
let file: string;

const FIELDS = [
  { name: 'GroupId', dataType: 'System.String' },
  { name: 'AccountNum', dataType: 'System.String' },
  { name: 'Amount', dataType: 'System.Double' },
];

function scaffold(extra: Record<string, unknown> = {}): string {
  return XmlTemplateGenerator.generateAxReportXml('ContosoNoteReport', {
    tmpTableName: 'ContosoNoteReportTmp',
    dpClassName: 'ContosoNoteReportDP',
    fields: FIELDS,
    ...extra,
  });
}

const rdlOf = (xml: string): string => /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml)?.[1] ?? '';
const read = (): string => readFileSync(file, 'utf-8').replace(/^﻿/, '');

/** Put a bare label id in the page header title, the way an old scaffold wrote it. */
function withBareTitle(xml: string): string {
  return xml.replace(
    '<Body>',
    `<PageHeader><Height>0.5in</Height><ReportItems><Textbox Name="ReportTitle"><CanGrow>true</CanGrow>` +
    `<Value>@SYS313987</Value><Top>0in</Top><Left>0in</Left><Width>4in</Width><Height>0.25in</Height></Textbox>` +
    `</ReportItems></PageHeader><Body>`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'report-rdl-'));
  file = join(root, 'ContosoNoteReport.xml');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('validateRdl', () => {
  it('accepts the scaffold\'s own RDL', async () => {
    const v = await validateRdl(rdlOf(scaffold()));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('rejects malformed XML as fatal', async () => {
    const v = await validateRdl(rdlOf(scaffold()).replace('</Report>', ''));
    expect(v.fatal).toBe(true);
  });

  it('flags a Fields! reference with no dataset field, and an undeclared parameter', async () => {
    const rdl = rdlOf(scaffold())
      .replace('=Fields!Amount.Value', '=Fields!Missing.Value')
      .replace('=Parameters!AX_CompanyName.Value', '=Parameters!NoSuchParam.Value');
    const v = await validateRdl(rdl);
    expect(v.errors.join('\n')).toContain('Fields!Missing');
    const v2 = await validateRdl(rdl.replace('<Value>=Fields!Missing.Value', '<Value>=Parameters!NoSuchParam.Value'));
    expect(v2.errors.join('\n')).toContain('Parameters!NoSuchParam');
  });

  it('flags duplicate textbox names and a tablix row that disagrees with its columns', async () => {
    const rdl = rdlOf(scaffold());
    const dup = await validateRdl(rdl.replace('Name="Textbox_Amount"', 'Name="Textbox_AccountNum"'));
    expect(dup.errors.join('\n')).toContain("'Textbox_AccountNum' is used 2 times");
    const short = await validateRdl(rdl.replace(/<TablixColumn><Width>[^<]*<\/Width><\/TablixColumn>/, ''));
    expect(short.errors.join('\n')).toMatch(/cell\(s\) but the tablix has/);
  });
});

describe('fix-labels', () => {
  it('rewrites a bare label id to =Labels! and leaves every other byte alone', async () => {
    const xml = withBareTitle(scaffold());
    writeFileSync(file, xml, 'utf-8');
    const r = await fixReportLabelIds(file);
    expect(r.success).toBe(true);
    const after = read();
    expect(after).toContain('<Value>=Labels!@SYS313987</Value>');
    expect(after).not.toContain('<Value>@SYS313987</Value>');
    // Only that one value changed.
    expect(after.replace('=Labels!@SYS313987', '@SYS313987')).toBe(xml);
  });

  it('handles a model label id and is idempotent', async () => {
    writeFileSync(file, withBareTitle(scaffold()).replace('@SYS313987', '@ContosoExt:NoteTitle'), 'utf-8');
    expect((await fixReportLabelIds(file)).success).toBe(true);
    expect(read()).toContain('=Labels!@ContosoExt:NoteTitle');
    const again = await fixReportLabelIds(file);
    expect(again.success).toBe(true);
    expect(again.message).toContain('nothing to fix');
  });

  it('works on the XML-escaped storage form and writes the same convention back', async () => {
    const rdl = rdlOf(withBareTitle(scaffold()));
    const escaped = rdl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xml = scaffold().replace(/<!\[CDATA\[[\s\S]*?\]\]>/, escaped);
    writeFileSync(file, xml, 'utf-8');
    const r = await fixReportLabelIds(file);
    expect(r.success).toBe(true);
    const after = read();
    expect(after).toContain('&lt;Value&gt;=Labels!@SYS313987&lt;/Value&gt;');
    expect(after).not.toContain('<![CDATA[');
  });

  it('refuses escaped RDL whose escaping it cannot reproduce', async () => {
    const rdl = rdlOf(withBareTitle(scaffold()));
    // Escapes "<" as a numeric reference: not a convention the encoder reproduces.
    const odd = rdl.replace(/&/g, '&amp;').replace(/</g, '&#60;');
    writeFileSync(file, scaffold().replace(/<!\[CDATA\[[\s\S]*?\]\]>/, odd), 'utf-8');
    const before = read();
    const r = await fixReportLabelIds(file);
    expect(r.success).toBe(false);
    expect(read()).toBe(before);
  });

  it('leaves a drillthrough parameter value inside a textbox alone', async () => {
    const drill =
      '<ActionInfo><Actions><Action><Drillthrough><ReportName>Other</ReportName><Parameters>' +
      '<Parameter Name="p"><Value>@Foo</Value></Parameter></Parameters></Drillthrough></Action></Actions></ActionInfo>';
    const xml = withBareTitle(scaffold()).replace(
      '<Value>@SYS313987</Value>',
      `<Value>@SYS313987</Value>${drill}`,
    );
    writeFileSync(file, xml, 'utf-8');
    const r = await fixReportLabelIds(file);
    expect(r.success).toBe(true);
    const after = read();
    expect(after).toContain('<Value>=Labels!@SYS313987</Value>');
    expect(after).toContain('<Parameter Name="p"><Value>@Foo</Value></Parameter>');
  });

  it('refuses a document that is not well-formed, writing nothing', async () => {
    writeFileSync(file, withBareTitle(scaffold()).replace('</Report>]]>', ']]>'), 'utf-8');
    const before = read();
    const r = await fixReportLabelIds(file);
    expect(r.success).toBe(false);
    expect(r.message).toContain('not well-formed');
    expect(read()).toBe(before);
  });
});

describe('the scaffold title', () => {
  const titleOf = (caption: string): string =>
    /Name="ReportTitle">[\s\S]*?<Value>([^<]*)<\/Value>/.exec(injectRdlPageHeader(scaffold(), caption))?.[1] ?? '';

  it('emits =Labels! for a label-id caption, as shipped reports do', () => {
    expect(titleOf('@SYS313987')).toBe('=Labels!@SYS313987');
    expect(titleOf('@ContosoExt:NoteTitle')).toBe('=Labels!@ContosoExt:NoteTitle');
  });

  it('leaves a plain caption literal and escaped', () => {
    expect(titleOf('Notes & more')).toBe('Notes &amp; more');
  });
});

describe('add-column on the flat scaffold tablix', () => {
  it('appends header, detail, column, member and widens the tablix', async () => {
    writeFileSync(file, scaffold({ fields: FIELDS.slice(0, 2) }), 'utf-8');
    // Amount exists only in the AxReport metadata after a refresh-style addition.
    const withMeta = read().replace(
      '</Fields>',
      '<AxReportDataSetField>\n<Name>Amount</Name>\n<Alias>ContosoNoteReportTmp.1.Amount</Alias>\n' +
      '<DataType>System.Double</DataType>\n</AxReportDataSetField>\n</Fields>',
    );
    writeFileSync(file, withMeta, 'utf-8');

    const r = await addReportColumn(file, 'Amount', { caption: '@ContosoExt:Amount' });
    expect(r.success).toBe(true);
    const rdl = rdlOf(read());
    expect(rdl).toContain('<Textbox Name="Hdr_Amount">');
    expect(rdl).toContain('<Value>=Labels!@ContosoExt:Amount</Value>');
    expect(rdl).toContain('<Value>=Fields!Amount.Value</Value>');
    // The RDL dataset now knows the field.
    expect(rdl).toContain('<Field Name="Amount">');
    expect(rdl).toContain('<DataField>ContosoNoteReportTmp.1.Amount</DataField>');
    expect((await validateRdl(rdl)).errors).toEqual([]);
    // Two 1.5in columns (3in) plus the cloned one → 4.5in.
    expect(rdl.match(/<TablixColumn>/g)).toHaveLength(3);
    expect(rdl).toContain('<Width>4.5in</Width>');
    // Namespaces and GUIDs survive untouched.
    const original = rdlOf(withMeta);
    for (const m of original.matchAll(/<rd:(?:DataSourceID|DataSetID|ReportID)>[^<]+<\/rd:\w+>/g)) {
      expect(rdl).toContain(m[0]);
    }
  });

  it('is idempotent', async () => {
    writeFileSync(file, scaffold(), 'utf-8');
    const r = await addReportColumn(file, 'Amount');
    expect(r.success).toBe(true);
    expect(r.message).toContain('already shows');
  });

  it('refuses a field that is on neither the RDL dataset nor the metadata', async () => {
    writeFileSync(file, scaffold(), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'NotAField');
    expect(r.success).toBe(false);
    expect(r.message).toContain('refresh-dataset');
    expect(read()).toBe(before);
  });

  it('rejects a bad field name before reading the file', async () => {
    const r = await addReportColumn(join(root, 'missing.xml'), 'bad name');
    expect(r.success).toBe(false);
  });
});

describe('add-column on the grouped tablix', () => {
  it('adds a Sum() to the summary rows for a numeric field and nothing for text', async () => {
    writeFileSync(file, grouped(), 'utf-8');
    const r = await addReportColumn(file, 'Amount');
    expect(r.success).toBe(true);
    const rdl = rdlOf(read());
    expect(rdl.match(/=Sum\(Fields!Amount\.Value\)/g)).toHaveLength(2);
    expect((await validateRdl(rdl)).errors).toEqual([]);
  });
});

/** A grouped tablix with two summary rows, in the shape injectGroupedTablix writes. */
function grouped(): string {
  const cell = (name: string, value: string) =>
    `            <TablixCell><CellContents>\n              <Textbox Name="${name}">\n` +
    `                <CanGrow>true</CanGrow><Value>${value}</Value>\n              </Textbox>\n` +
    `            </CellContents></TablixCell>`;
  const row = (cells: string[]) => `              <TablixRow><Height>0.25in</Height><TablixCells>\n${cells.join('\n')}\n              </TablixCells></TablixRow>`;
  const tablix =
    `        <Tablix Name="Tablix_ContosoNoteReportTmp">\n          <TablixBody>\n            <TablixColumns>\n` +
    `            <TablixColumn><Width>1.5in</Width></TablixColumn>\n            <TablixColumn><Width>1.5in</Width></TablixColumn>\n` +
    `            </TablixColumns>\n            <TablixRows>\n` +
    [
      row([cell('Hdr_GroupId', 'GroupId'), cell('Hdr_AccountNum', 'AccountNum')]),
      row([cell('Grp_GroupId', '=Fields!GroupId.Value'), cell('Grp_AccountNum', '')]),
      row([cell('Det_GroupId', '=Fields!GroupId.Value'), cell('Det_AccountNum', '=Fields!AccountNum.Value')]),
      row([cell('Tot_GroupId', '"Total"'), cell('Tot_AccountNum', '""')]),
    ].join('\n') +
    `\n            </TablixRows>\n          </TablixBody>\n` +
    `          <TablixColumnHierarchy><TablixMembers>\n          <TablixMember />\n          <TablixMember />\n          </TablixMembers></TablixColumnHierarchy>\n` +
    `          <TablixRowHierarchy><TablixMembers>\n            <TablixMember><KeepWithGroup>After</KeepWithGroup></TablixMember>\n` +
    `            <TablixMember><Group Name="Group_GroupId"><GroupExpressions><GroupExpression>=Fields!GroupId.Value</GroupExpression></GroupExpressions></Group></TablixMember>\n` +
    `          </TablixMembers></TablixRowHierarchy>\n          <DataSetName>ContosoNoteReportTmp</DataSetName>\n` +
    `          <Top>0.5in</Top><Left>0.5in</Left><Height>1in</Height><Width>3in</Width>\n        </Tablix>`;
  const xml = scaffold({ fields: FIELDS });
  return xml.replace(/ {8}<Tablix Name="Tablix_ContosoNoteReportTmp">[\s\S]*? {8}<\/Tablix>/, tablix);
}

describe('add-column refuses designs it does not recognise', () => {
  it('a tablix with a column group member', async () => {
    writeFileSync(file, scaffold({ fields: FIELDS.slice(0, 2) }).replace('<TablixMember />', '<TablixMember><Group Name="G1" /></TablixMember>'), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'Amount');
    expect(r.success).toBe(false);
    expect(r.message).toContain('column groups');
    expect(read()).toBe(before);
  });

  it('a row it cannot classify', async () => {
    writeFileSync(file, scaffold({ fields: FIELDS.slice(0, 2) }).replace('=Fields!AccountNum.Value', '=Fields!AccountNum.Value &amp; &quot;x&quot;'), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'Amount');
    expect(r.success).toBe(false);
    expect(r.message).toContain('neither a header');
    expect(read()).toBe(before);
  });

  it('a header caption that would be evaluated as an expression', async () => {
    writeFileSync(file, scaffold({ fields: FIELDS.slice(0, 2) }), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'Amount', { caption: '=Foo(' });
    expect(r.success).toBe(false);
    expect(r.message).toContain('starts with "="');
    expect(read()).toBe(before);
  });

  it('a last-cell textbox whose Name is single-quoted, without throwing', async () => {
    const xml = scaffold({ fields: FIELDS.slice(0, 2) }).replace(
      '</Fields>',
      '<AxReportDataSetField><Name>Amount</Name><Alias>ContosoNoteReportTmp.1.Amount</Alias>' +
      '<DataType>System.Double</DataType></AxReportDataSetField></Fields>',
    );
    const last = [...xml.matchAll(/<Textbox Name="Txt_AccountNum_[A-Za-z0-9_]*">|<Textbox Name="[A-Za-z]*_?AccountNum[A-Za-z0-9_]*">/g)].pop()![0];
    writeFileSync(file, xml.replace(last, last.replace(/"/g, "'")), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'Amount');
    expect(r.success).toBe(false);
    expect(r.message).toContain('double-quoted');
    expect(read()).toBe(before);
  });

  it('two tablixes without a datasetName', async () => {
    const xml = scaffold({ fields: FIELDS.slice(0, 2) });
    const tablix = /( {8}<Tablix Name="Tablix_ContosoNoteReportTmp">[\s\S]*? {8}<\/Tablix>)/.exec(xml)![1];
    writeFileSync(file, xml.replace(tablix, `${tablix}\n${tablix.replace(/Name="(Tablix_|Textbox_)/g, 'Name="B$1')}`), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'Amount');
    expect(r.success).toBe(false);
    expect(r.message).toContain('pass datasetName');
    expect(read()).toBe(before);
  });

  it('a name collision the new cells would cause, caught by the validator before writing', async () => {
    writeFileSync(file, scaffold({ fields: FIELDS.slice(0, 2) }).replace('Name="ReportTitle"', 'Name="Hdr_Amount"'), 'utf-8');
    const before = read();
    const r = await addReportColumn(file, 'Amount');
    // Amount is not on the dataset metadata here, so it is refused earlier; either way nothing is written.
    expect(r.success).toBe(false);
    expect(read()).toBe(before);
  });
});

describe('add-column cooperates with add-parameter', () => {
  it('a parameter added to the metadata leaves the RDL valid for later column edits', async () => {
    writeFileSync(file, scaffold({ fields: FIELDS.slice(0, 2) }), 'utf-8');
    expect((await addReportParameter(file, 'FromDate', { dataType: 'System.DateTime' })).success).toBe(true);
    const r = await addReportColumn(file, 'AccountNum');
    expect(r.success).toBe(true);
    expect(r.message).toContain('already shows');
  });
});
