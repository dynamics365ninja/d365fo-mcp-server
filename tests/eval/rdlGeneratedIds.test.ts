/**
 * A report golden must survive being re-captured.
 *
 * An AxReport carries its RDL inside CDATA, and the RDL carries `rd:DataSourceID`,
 * `rd:DataSetID` and `rd:ReportID` — GUIDs the generator mints afresh on every
 * run. They say nothing about whether the report is right, and they made every
 * report golden unreproducible: re-running the case diffs on identifiers that
 * were always going to differ.
 *
 * The case `ignore` globs cannot reach them, because they are not nodes in the
 * compared document — they are text inside a payload. So they are masked in the
 * same comparison-time canonicalisation that already re-indents X++ source; the
 * stored artifact is never rewritten.
 *
 * Six committed goldens carry them (ssrs-report-advanced, -design-rdl,
 * -multidataset, -preprocess, -uibuilder, print-mgmt-doctype-extension), so
 * without this a re-capture of any of them reports a failure that is not one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { normalizeAotXml, renderNormalized } from '../../src/eval/oracle/normalize.js';

const GOLDEN = path.join(
  process.cwd(), 'eval', 'goldens', 'L4-ssrs-report-advanced', 'ConDemoNoteReportAdv.metadata.xml',
);

const withFreshIds = (xml: string) =>
  xml.replace(
    /(<rd:(?:DataSourceID|DataSetID|ReportID)>)[0-9a-fA-F-]{36}(<)/g,
    '$1ffffffff-1111-2222-3333-444444444444$2',
  );

describe('RDL identifiers regenerated per run do not fail a golden', () => {
  it('the fixture really contains such identifiers', () => {
    // Without this the test could pass by comparing a document that has none.
    const xml = fs.readFileSync(GOLDEN, 'utf8');
    expect(xml).toMatch(/<rd:(DataSourceID|DataSetID|ReportID)>/);
    expect(withFreshIds(xml)).not.toBe(xml);
  });

  it('two captures differing only in those identifiers normalize identically', async () => {
    const xml = fs.readFileSync(GOLDEN, 'utf8');
    const a = renderNormalized(await normalizeAotXml(xml));
    const b = renderNormalized(await normalizeAotXml(withFreshIds(xml)));
    expect(b).toBe(a);
  });

  it('still notices a REAL change to the design', async () => {
    // The masking must not blunt the comparison it exists to enable.
    const xml = fs.readFileSync(GOLDEN, 'utf8');
    const changed = xml.replace('=Fields!', '=Parameters!');
    const a = renderNormalized(await normalizeAotXml(xml));
    const b = renderNormalized(await normalizeAotXml(changed));
    expect(b).not.toBe(a);
  });
});
