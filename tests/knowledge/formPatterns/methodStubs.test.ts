/**
 * Regression: generate_object(mode="scaffold", objectType="form",
 * includeMethodStubs=true) injected the requested per-datasource method stubs
 * (e.g. active/validateWrite/initValue) directly inside the TOP-LEVEL
 * <DataSources><AxFormDataSource> element, immediately after <Name> and
 * BEFORE <Table> — a location no shipped D365FO form ever populates (verified
 * byte-for-byte against real standard forms, e.g. CustParameters/
 * BankParameters, by a prior improver run). Real datasource method overrides
 * live exclusively in the SourceCode mirror section
 * (SourceCode/DataSources/DataSource/Methods/Method).
 *
 * Injecting a <Methods> element ahead of <Table> inside AxFormDataSource
 * desyncs xppc's positional schema binding for that element, so <Table>
 * (present and byte-correct in the file) deserializes as an empty table
 * reference — "datasource 'X' refers to table '' which does not exist" — a
 * BUILD FAILURE, even though object_patterns(domain=form, action=validate)
 * reports zero errors on the broken file.
 *
 * Confirmed across three form patterns (TableOfContents, DetailsTransaction,
 * DetailsMaster) in the corpus:
 *   eval/corpus/runs/2026-07-07T12__L3-numberseq-module-slice__cb1b73d.json
 *   eval/corpus/runs/2026-07-07T15__L4-master-security-slice__cb1b73d.json
 * (both cite an identical prior finding on DetailsTransaction).
 */

import { describe, it, expect } from 'vitest';
import { FormPatternTemplates } from '../../../src/utils/formPatternTemplates';
import { injectMethodStubs, methodStubsForPattern } from '../../../src/knowledge/formPatterns/methodStubs';

/** Byte-offset span of a top-level element by tag name (first occurrence). */
function spanOf(xml: string, openTag: string, closeTag: string): { start: number; end: number } {
  const start = xml.indexOf(openTag);
  if (start < 0) throw new Error(`${openTag} not found`);
  const end = xml.indexOf(closeTag, start);
  if (end < 0) throw new Error(`${closeTag} not found (unclosed ${openTag})`);
  return { start, end: end + closeTag.length };
}

describe('injectMethodStubs — datasource method placement', () => {
  it('places datasource method stubs in SourceCode/DataSources/DataSource, NOT the top-level AxFormDataSource', () => {
    const stubs = methodStubsForPattern('DetailsMaster', 'CustTable');
    const xml = FormPatternTemplates.buildDetailsMaster({
      formName: 'MyForm',
      dsName: 'CustTable',
      dsTable: 'CustTable',
      gridFields: ['AccountNum'],
    });
    const result = injectMethodStubs(xml, stubs, 'CustTable');

    // The top-level <DataSources><AxFormDataSource> element must be untouched:
    // Name immediately followed by Table, no <Methods> in between (this is the
    // exact desync that broke xppc's positional schema binding).
    const topLevelDs = spanOf(result.xml, '\t<DataSources>', '\n\t</DataSources>');
    const topLevelDsXml = result.xml.slice(topLevelDs.start, topLevelDs.end);
    expect(topLevelDsXml).not.toContain('<Methods>');
    expect(topLevelDsXml.indexOf('<Name>CustTable</Name>'))
      .toBeLessThan(topLevelDsXml.indexOf('<Table>CustTable</Table>'));
    // Table must immediately follow Name (no injected element between them).
    expect(topLevelDsXml).toMatch(/<Name>CustTable<\/Name>\s*<Table>CustTable<\/Table>/);

    // The SourceCode mirror section must carry the injected methods instead.
    const sourceCodeSpan = spanOf(result.xml, '<SourceCode>', '</SourceCode>');
    const sourceCodeXml = result.xml.slice(sourceCodeSpan.start, sourceCodeSpan.end);
    expect(sourceCodeXml).toContain('<DataSource>');
    expect(sourceCodeXml).toContain('<Name>CustTable</Name>');
    expect(sourceCodeXml).toContain('public int active()');
    expect(sourceCodeXml).toContain('public boolean validateWrite()');

    // And they must be nested DataSources > DataSource > Methods > Method, not
    // a bare Methods sibling.
    expect(sourceCodeXml).toMatch(
      /<DataSources[^>]*>\s*<DataSource>\s*<Name>CustTable<\/Name>\s*<Methods>/,
    );
  });

  it('still reports the injected datasource methods by name', () => {
    const stubs = methodStubsForPattern('DetailsMaster', 'CustTable');
    const xml = FormPatternTemplates.buildDetailsMaster({
      formName: 'MyForm',
      dsName: 'CustTable',
      dsTable: 'CustTable',
      gridFields: ['AccountNum'],
    });
    const result = injectMethodStubs(xml, stubs, 'CustTable');
    expect(result.injected).toContain('CustTable.active');
    expect(result.injected).toContain('CustTable.validateWrite');
  });

  it('handles BOTH a header and a lines datasource (DetailsTransaction) without corrupting the top-level DataSources collection', () => {
    const stubs = methodStubsForPattern('DetailsTransaction', 'Header', 'Lines');
    const xml = FormPatternTemplates.buildDetailsTransaction({
      formName: 'MyForm',
      dsName: 'Header',
      dsTable: 'Header',
      linesDsName: 'Lines',
      linesDsTable: 'Lines',
      gridFields: ['LineNum'],
    });
    const result = injectMethodStubs(xml, stubs, 'Header', 'Lines');

    const topLevelDs = spanOf(result.xml, '\t<DataSources>', '\n\t</DataSources>');
    const topLevelDsXml = result.xml.slice(topLevelDs.start, topLevelDs.end);
    expect(topLevelDsXml).not.toContain('<Methods>');

    const sourceCodeSpan = spanOf(result.xml, '<SourceCode>', '</SourceCode>');
    const sourceCodeXml = result.xml.slice(sourceCodeSpan.start, sourceCodeSpan.end);
    // Both datasources' stubs land in the SourceCode mirror, each under its own <DataSource>.
    expect(sourceCodeXml.match(/<DataSource>/g)?.length).toBe(2);
    expect(result.injected).toContain('Header.active');
    expect(result.injected).toContain('Lines.initValue');
  });

  it('the datasource-stub-injected XML still passes the pattern validator (no new errors)', async () => {
    const { validateFormPatternXml } = await import('../../../src/validation/formPatternValidator');
    const stubs = methodStubsForPattern('SimpleList', 'TestDS');
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'MyForm',
      dsName: 'TestDS',
      dsTable: 'TestTable',
      gridFields: ['F1'],
    });
    const result = injectMethodStubs(xml, stubs, 'TestDS');
    const report = await validateFormPatternXml(result.xml);
    expect(report.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('merges into an existing SourceCode/DataSource entry (clone-from-real-form scenario) rather than duplicating <DataSource>', () => {
    // Simulate a form whose SourceCode mirror already carries an entry for
    // the datasource (e.g. cloned from a real shipped form that already
    // overrides a different method on it).
    const baseStubs = methodStubsForPattern('DetailsMaster', 'CustTable');
    const xml = FormPatternTemplates.buildDetailsMaster({
      formName: 'MyForm',
      dsName: 'CustTable',
      dsTable: 'CustTable',
      gridFields: ['AccountNum'],
    });
    const first = injectMethodStubs(xml, { formMethods: [], dataSourceMethods: [baseStubs.dataSourceMethods[0]] }, 'CustTable');

    // A second injection targeting the SAME datasource must land inside the
    // existing <DataSource><Name>CustTable</Name> entry's <Methods>, not
    // create a second sibling <DataSource>.
    const second = injectMethodStubs(
      first.xml,
      { formMethods: [], dataSourceMethods: [baseStubs.dataSourceMethods[1]] },
      'CustTable',
    );

    const sourceCodeSpan = second.xml.slice(
      second.xml.indexOf('<SourceCode>'),
      second.xml.indexOf('</SourceCode>'),
    );
    expect(sourceCodeSpan.match(/<DataSource>/g)?.length).toBe(1);
    expect(sourceCodeSpan.match(/<Methods>/g)?.length).toBe(1);
    expect(sourceCodeSpan).toContain('public int active()');
    expect(sourceCodeSpan).toContain('public boolean validateWrite()');
  });
});
