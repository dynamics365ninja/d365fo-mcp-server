/**
 * `report-design` — the first write path an AxReport has ever had.
 *
 * Every recipe used to end with "open the Report Designer", and for LAYOUT that
 * is still right. What this operation does instead is the bookkeeping the tool
 * already holds every input for: syncing a dataset with the temp table it reads,
 * and declaring a parameter in the two collections that must agree about it.
 *
 * The safety argument is a property of the OPERATION, not of the file, and these
 * tests are where it is pinned:
 *
 *  1. **The RDL is never touched.** It lives in a `<![CDATA[…]]>` block, a
 *     malformed one fails in the SSRS renderer at run time where no build and no
 *     test can see it, so the byte-for-byte survival of that block is asserted
 *     directly.
 *  2. **Additive only.** Adding a dataset field the design does not bind is
 *     inert; removing one it does bind breaks the render. So nothing is removed,
 *     and an existing field is left alone even when the table now disagrees.
 *
 * The parameter vocabulary is not invented either: across 1,057 shipped AxReport
 * documents and 13,833 parameters, `UserVisibility` holds only `Hidden` and
 * `Internal` — a visible parameter OMITS the element — and `AllowBlank`/`Nullable`
 * appear only as `true`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addReportParameter, refreshReportDataset } from '../../src/tools/write/reportDesignXml';

let root: string;
let reportPath: string;

/** A report whose RDL block contains markup that would fool a naive search. */
const REPORT_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoNoteReport</Name>
\t<DataSets>
\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>ConDemoNoteReportTmp</Name>
\t\t\t<DataSourceType>ReportDataProvider</DataSourceType>
\t\t\t<Query>SELECT * FROM ConDemoNoteReportDP.ConDemoNoteReportTmp</Query>
\t\t\t<Fields>
\t\t\t\t<AxReportDataSetField>
\t\t\t\t\t<Name>NoteId</Name>
\t\t\t\t\t<Alias>ConDemoNoteReportTmp.1.NoteId</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t</AxReportDataSetField>
\t\t\t</Fields>
\t\t\t<Parameters>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t</Parameters>
\t\t</AxReportDataSet>
\t</DataSets>
\t<ReportParameterBases>
\t\t<AxReportParameterBase xmlns=""
\t\t\t\ti:type="AxReportParameter">
\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t</AxReportParameterBase>
\t</ReportParameterBases>
\t<Designs>
\t\t<AxReportDesign xmlns="" i:type="AxReportPrecisionDesign">
\t\t\t<Name>Report</Name>
\t\t\t<Text><![CDATA[<Report><DataSets><DataSet Name="ConDemoNoteReportTmp"><Fields>
  <Field Name="NoteId"><DataField>NoteId</DataField></Field>
</Fields></DataSet></DataSets></Report>]]></Text>
\t\t</AxReportDesign>
\t</Designs>
</AxReport>`;

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoNoteReportTmp</Name>
\t<Fields>
\t\t<AxTableField i:type="AxTableFieldString"><Name>NoteId</Name></AxTableField>
\t\t<AxTableField i:type="AxTableFieldString"><Name>Subject</Name></AxTableField>
\t\t<AxTableField i:type="AxTableFieldUtcDateTime"><Name>NoteDateTime</Name></AxTableField>
\t\t<AxTableField i:type="AxTableFieldEnum"><Name>Tier</Name><EnumType>NoYes</EnumType></AxTableField>
\t\t<AxTableField i:type="AxTableFieldReal"><Name>Amount</Name></AxTableField>
\t</Fields>
</AxTable>`;

/** The exact RDL payload, so its survival can be asserted rather than assumed. */
const rdlOf = (xml: string): string => /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml)?.[1] ?? '(no CDATA)';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'report-design-'));
  mkdirSync(join(root, 'MyPkg', 'MyPkg', 'AxTable'), { recursive: true });
  writeFileSync(join(root, 'MyPkg', 'MyPkg', 'AxTable', 'ConDemoNoteReportTmp.xml'), TABLE_XML, 'utf-8');
  reportPath = join(root, 'ConDemoNoteReport.xml');
  writeFileSync(reportPath, REPORT_XML, 'utf-8');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const roots = () => [root];

describe('refresh-dataset', () => {
  it('adds the fields the table has and the dataset does not', async () => {
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(r.success).toBe(true);
    const xml = readFileSync(reportPath, 'utf-8');
    for (const f of ['Subject', 'NoteDateTime', 'Tier', 'Amount']) {
      expect(xml, `${f} should have been added`).toContain(`<Name>${f}</Name>`);
    }
  });

  it('maps X++ field types to the .NET types a dataset carries', async () => {
    // The X++ type and the .NET type drifting apart is a hard build error, so
    // this uses the same mapping the report scaffold does.
    await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    const xml = readFileSync(reportPath, 'utf-8');
    expect(xml).toMatch(/<Name>NoteDateTime<\/Name>[\s\S]*?<DataType>System\.DateTime<\/DataType>/);
    expect(xml).toMatch(/<Name>Amount<\/Name>[\s\S]*?<DataType>System\.Double<\/DataType>/);
    // An enum field is an int in the dataset, not a string.
    expect(xml).toMatch(/<Name>Tier<\/Name>[\s\S]*?<DataType>System\.Int32<\/DataType>/);
  });

  it('leaves the RDL byte-for-byte untouched', async () => {
    const before = rdlOf(readFileSync(reportPath, 'utf-8'));
    await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(rdlOf(readFileSync(reportPath, 'utf-8'))).toBe(before);
  });

  it('does not mistake the RDL\'s own <Fields> for the dataset\'s', async () => {
    // The CDATA contains `<Fields>` and a `<Field Name="NoteId">`. A search that
    // did not blank it could insert the new fields inside the RDL document.
    await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(rdlOf(readFileSync(reportPath, 'utf-8'))).not.toContain('Subject');
  });

  it('is idempotent — a second run adds nothing', async () => {
    await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    const after = readFileSync(reportPath, 'utf-8');
    const second = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(second.success).toBe(true);
    expect(second.message).toContain('nothing to add');
    expect(readFileSync(reportPath, 'utf-8')).toBe(after);
  });

  it('never removes a field the table no longer has', async () => {
    // Removing a field the RDL binds breaks the render, and this code cannot see
    // the RDL — so removal is not offered at all.
    writeFileSync(
      join(root, 'MyPkg', 'MyPkg', 'AxTable', 'ConDemoNoteReportTmp.xml'),
      TABLE_XML.replace(/<AxTableField i:type="AxTableFieldString"><Name>NoteId<\/Name><\/AxTableField>\s*/, ''),
      'utf-8',
    );
    await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(readFileSync(reportPath, 'utf-8')).toContain('<Name>NoteId</Name>');
  });

  it('refuses a table it cannot read rather than inventing fields', async () => {
    const r = await refreshReportDataset(reportPath, 'NoSuchTable', undefined, roots());
    expect(r.success).toBe(false);
    expect(r.message).toContain('was not found on disk');
  });

  it('refuses a document that is not an AxReport', async () => {
    const other = join(root, 'NotAReport.xml');
    writeFileSync(other, '<?xml version="1.0"?><AxTable><Name>X</Name></AxTable>', 'utf-8');
    const r = await refreshReportDataset(other, 'ConDemoNoteReportTmp', undefined, roots());
    expect(r.success).toBe(false);
    expect(r.message).toContain('is not an AxReport');
  });
});

/**
 * Isolate ONE parameter's `<AxReportParameterBase>` block.
 *
 * Two traps here, and the operation under test creates the second one itself.
 *
 * The obvious regex — open tag, lazy body, the name, lazy body, close tag —
 * starts at the FIRST `<AxReportParameterBase` in the document and stretches to
 * whichever name you asked for, so the "block" carries every parameter before
 * it, `UserVisibility` included.
 *
 * Narrowing to chunks split on the closing tag is still not enough, because a
 * parameter name appears TWICE in a correct document BY DESIGN: once in
 * `<ReportParameterBases>` and once in the dataset's `<Parameters>`. The dataset
 * comes first, so a name-only search lands in the chunk that ends with the
 * PREVIOUS parameter base — and reports a correct write as broken.
 *
 * So: narrow to the collection, then to the block. The same
 * first-match-over-a-nesting-collection shape the XML writers have been bitten
 * by; here it bit the test twice before the test was right.
 */
const parameterBlock = (xml: string, name: string): string => {
  // Attribute-tolerant for the same reason the writer is: the scaffold emits
  // `<ReportParameterBases xmlns="">`, and a literal-tag search matches the
  // committed goldens and nothing the tool itself produces. This helper had the
  // identical bug, one commit apart.
  const from = xml.search(/<ReportParameterBases\b[^>]*>/);
  const to = xml.indexOf('</ReportParameterBases>', from);
  if (from < 0 || to < 0) return '';
  const bases = xml.slice(from, to);
  const hit = bases.split('</AxReportParameterBase>').find(b => b.includes(`<Name>${name}</Name>`)) ?? '';
  const open = hit.lastIndexOf('<AxReportParameterBase');
  return open >= 0 ? hit.slice(open) : '';
};

describe('add-parameter', () => {
  it('declares the parameter AND binds it to the dataset', async () => {
    // Two elements in two collections. Writing one is the mistake this prevents.
    const r = await addReportParameter(reportPath, 'MyDateFrom', { dataType: 'System.DateTime' });
    expect(r.success).toBe(true);
    const xml = readFileSync(reportPath, 'utf-8');
    expect(xml).toMatch(/<AxReportParameterBase[\s\S]*?<Name>MyDateFrom<\/Name>/);
    expect(xml).toMatch(/<AxReportDataSetParameter>[\s\S]*?<Name>MyDateFrom<\/Name>/);
    expect(r.message).toContain("dataset 'ConDemoNoteReportTmp'");
  });

  it('omits UserVisibility for a visible parameter', async () => {
    // There is no "Visible" value in any of the 8,977 shipped parameters — a
    // visible one omits the element, and an unknown value is dropped silently.
    await addReportParameter(reportPath, 'MyVisible', {});
    const block = parameterBlock(readFileSync(reportPath, 'utf-8'), 'MyVisible');
    expect(block).not.toContain('UserVisibility');
    expect(block).toContain('<AllowBlank>true</AllowBlank>');
  });

  it('writes Hidden when asked, and only then', async () => {
    await addReportParameter(reportPath, 'MyHidden', { hidden: true });
    const block = parameterBlock(readFileSync(reportPath, 'utf-8'), 'MyHidden');
    expect(block).toContain('<UserVisibility>Hidden</UserVisibility>');
  });

  it('defaults the type to System.String', async () => {
    await addReportParameter(reportPath, 'MyText', {});
    expect(readFileSync(reportPath, 'utf-8'))
      .toMatch(/<Name>MyText<\/Name>[\s\S]*?<DataType>System\.String<\/DataType>/);
  });

  it('leaves the RDL byte-for-byte untouched', async () => {
    const before = rdlOf(readFileSync(reportPath, 'utf-8'));
    await addReportParameter(reportPath, 'MyDateFrom', {});
    expect(rdlOf(readFileSync(reportPath, 'utf-8'))).toBe(before);
  });

  it('is idempotent', async () => {
    await addReportParameter(reportPath, 'MyDateFrom', {});
    const after = readFileSync(reportPath, 'utf-8');
    const second = await addReportParameter(reportPath, 'MyDateFrom', {});
    expect(second.success).toBe(true);
    expect(second.message).toContain('already declared');
    expect(readFileSync(reportPath, 'utf-8')).toBe(after);
  });

  it('refuses a name that is not an AOT identifier', async () => {
    const r = await addReportParameter(reportPath, 'My-Date From', {});
    expect(r.success).toBe(false);
    expect(r.message).toContain('not a valid AOT name');
  });
});

describe('choosing a dataset', () => {
  const TWO_DATASETS = REPORT_XML.replace(
    '\t</DataSets>',
    `\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>ConDemoNoteReportLinesTmp</Name>
\t\t\t<Fields>
\t\t\t</Fields>
\t\t</AxReportDataSet>
\t</DataSets>`,
  );

  it('refuses to guess when the report has several datasets', async () => {
    // Guessing is what puts the field on the wrong dataset.
    writeFileSync(reportPath, TWO_DATASETS, 'utf-8');
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(r.success).toBe(false);
    expect(r.message).toContain('datasetName is required');
    expect(r.message).toContain('ConDemoNoteReportLinesTmp');
  });

  it('acts on the named one', async () => {
    writeFileSync(reportPath, TWO_DATASETS, 'utf-8');
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', 'ConDemoNoteReportTmp', roots());
    expect(r.success).toBe(true);
  });

  it('names what is available when the dataset does not exist', async () => {
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', 'NoSuchDataSet', roots());
    expect(r.success).toBe(false);
    expect(r.message).toContain('ConDemoNoteReportTmp');
  });
});

/**
 * The regression a LIVE run found and no unit test could.
 *
 * Every test above uses a report I wrote, so they proved the writer agreed with
 * my idea of the document. Run against what the SCAFFOLD actually emits, both
 * operations were refused: the generator writes `<ReportParameterBases xmlns="">`
 * and `<Fields xmlns="">`, and a literal `<Fields>` search matches the committed
 * goldens and nothing the tool itself produces.
 *
 * Attributes on these containers are the norm, not the exception.
 */
describe('containers carry attributes, and the goldens hide that', () => {
  const withAttributes = REPORT_XML
    .replace('<Fields>', '<Fields xmlns="">')
    .replace('<Parameters>', '<Parameters xmlns="">')
    .replace('<ReportParameterBases>', '<ReportParameterBases xmlns="">');

  beforeEach(() => writeFileSync(reportPath, withAttributes, 'utf-8'));

  it('refreshes a dataset whose <Fields> carries xmlns', async () => {
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(r.success, r.message).toBe(true);
    expect(readFileSync(reportPath, 'utf-8')).toContain('<Name>Subject</Name>');
  });

  it('adds a parameter when <ReportParameterBases> carries xmlns', async () => {
    const r = await addReportParameter(reportPath, 'MyDateFrom', {});
    expect(r.success, r.message).toBe(true);
    expect(parameterBlock(readFileSync(reportPath, 'utf-8'), 'MyDateFrom')).toContain('<DataType>');
  });

  it('binds to the dataset when <Parameters> carries xmlns', async () => {
    const r = await addReportParameter(reportPath, 'MyDateFrom', {});
    expect(r.message).toContain("dataset 'ConDemoNoteReportTmp'");
  });

  it('refuses rather than silently doing nothing when <Fields /> is self-closing', async () => {
    // A dataset with no fields yet is a real shape and not one this can insert
    // into. Reporting it beats returning success over an unchanged file.
    writeFileSync(reportPath, REPORT_XML.replace(/<Fields>[\s\S]*?<\/Fields>/, '<Fields />'), 'utf-8');
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(r.success).toBe(false);
    expect(r.message).toContain('no <Fields> collection');
  });
});

/**
 * The other storage form.
 *
 * Shipped reports do not use CDATA at all — zero of the 1,057 on a full install.
 * They put XML-escaped text in `<Text>`, which is inert by construction here:
 * `&lt;Fields&gt;` cannot match a search for `<Fields>`. Masking is what makes
 * OUR documents safe; escaping is what makes Microsoft's. Both are asserted, so
 * a future change that starts un-escaping has to break a test to do it.
 */
describe('an escaped RDL is left alone too', () => {
  const ESCAPED = REPORT_XML.replace(
    /<Text><!\[CDATA\[[\s\S]*?\]\]><\/Text>/,
    '<Text>&lt;Report&gt;&lt;DataSets&gt;&lt;DataSet Name="ConDemoNoteReportTmp"&gt;'
    + '&lt;Fields&gt;&lt;Field Name="NoteId" /&gt;&lt;/Fields&gt;&lt;/DataSet&gt;&lt;/DataSets&gt;&lt;/Report&gt;</Text>',
  );

  beforeEach(() => writeFileSync(reportPath, ESCAPED, 'utf-8'));

  it('adds the dataset fields without touching the escaped design', async () => {
    const before = /<Text>([\s\S]*?)<\/Text>/.exec(readFileSync(reportPath, 'utf-8'))?.[1];
    const r = await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    expect(r.success, r.message).toBe(true);
    const after = readFileSync(reportPath, 'utf-8');
    expect(after).toContain('<Name>Subject</Name>');
    expect(/<Text>([\s\S]*?)<\/Text>/.exec(after)?.[1]).toBe(before);
  });

  it('does not treat the escaped <Fields> as the dataset\'s own', async () => {
    await refreshReportDataset(reportPath, 'ConDemoNoteReportTmp', undefined, roots());
    const design = /<Text>([\s\S]*?)<\/Text>/.exec(readFileSync(reportPath, 'utf-8'))?.[1] ?? '';
    expect(design).not.toContain('Subject');
  });
});
