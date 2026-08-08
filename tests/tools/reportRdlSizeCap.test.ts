/**
 * get_object_info(report, options:{includeRdl:true}) — size check on the embedded RDL.
 *
 * A production AxReport design carries 1–2 MB of RDL inside <Text><![CDATA[…]]>
 * and the reader emitted all of it with no size check at all: one call costing
 * more than a whole session of metadata reads, re-billed on every later round
 * trip. It is now cut at a ceiling, on an element boundary, and paired with the
 * structural summary so the truncated answer is still usable.
 */

import { describe, it, expect, vi } from 'vitest';

const indexed = { xml: '', ref: { name: 'MyReport', model: 'MyModel', localPath: 'K:\\p\\MyReport.xml' } };

vi.mock('../../src/utils/indexedXmlLookup', () => ({
  readIndexedXml: vi.fn(async () => indexed),
  bridgeUnavailableNote: vi.fn(() => ''),
}));

import { getReportInfoTool } from '../../src/tools/readers/reportInfo';

/** An AxReport whose single design embeds `elementCount` RDL elements. */
function reportXml(elementCount: number): string {
  const rdl =
    `<Report><Body>\n` +
    Array.from({ length: elementCount }, (_, i) =>
      `  <Textbox Name="TextboxWithAFairlyLongName${i}"><Value>=Fields!Field${i}.Value</Value></Textbox>`,
    ).join('\n') +
    `\n</Body><Language>en-US</Language></Report>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<AxReport>
  <Name>MyReport</Name>
  <DataSets />
  <Designs>
    <AxReportDesign>
      <Name>Report</Name>
      <Text><![CDATA[${rdl}]]></Text>
    </AxReportDesign>
  </Designs>
</AxReport>`;
}

const call = async (xml: string, includeRdl: boolean) => {
  indexed.xml = xml;
  const res = await getReportInfoTool(
    { method: 'tools/call', params: { name: 'get_object_info', arguments: { reportName: 'MyReport', includeRdl } } } as any,
    { symbolIndex: { getReadDb: () => ({}) } } as any,
  );
  return res.content[0].text as string;
};

describe('includeRdl size check', () => {
  it('does not dump a huge RDL — it truncates, says by how much, and keeps the summary', async () => {
    const text = await call(reportXml(2000), true);

    expect(text.length).toBeLessThan(70_000);
    expect(text).toContain('RDL truncated at 60,000 chars');
    expect(text).toContain('chars omitted');
    expect(text).toContain('RDL summary:'); // structure survives the cut
    expect(text).toContain('Language: en-US');
    // Cut on an element boundary: no dangling `<Textbox Nam` in the code block.
    const body = text.split('```xml\n')[1].split('\n```')[0];
    expect(body.lastIndexOf('<')).toBeLessThanOrEqual(body.lastIndexOf('>'));
  });

  it('still returns a small RDL in full, unchanged', async () => {
    const text = await call(reportXml(5), true);
    expect(text).toContain('<details><summary>Full RDL</summary>');
    expect(text).toContain('TextboxWithAFairlyLongName4');
    expect(text).not.toContain('RDL truncated');
  });

  it('leaves the default (includeRdl:false) summary path alone', async () => {
    const text = await call(reportXml(2000), false);
    expect(text).toContain('Use `includeRdl: true` to retrieve the full RDL content.');
    expect(text).not.toContain('```xml');
  });
});
