/**
 * Regression (audit finding 7, CRITICAL): almost no XML builder escaped the
 * free text it interpolated.
 *
 * `label: "Purchases & Sales"` wrote a bare `&` into PackagesLocalDirectory,
 * and the create path adds the file to the .rnrproj BEFORE anything parses it —
 * so the malformed XML surfaced much later as an unexplained build break rather
 * than as a rejected call. Only smartXmlBuilder and four extension builders
 * escaped anything, each with its own private copy of the escaper.
 *
 * Every builder below is asserted by PARSING its output: an unescaped `&` or
 * `<` makes the document unparseable, which is the actual failure.
 */

import { describe, it, expect } from 'vitest';
import { parseStringPromise } from 'xml2js';
import { escapeXml, escapeXmlAttr } from '../../src/utils/xmlEscape';
import { buildAxSecurityPrivilegeXml } from '../../src/tools/securityPrivilegeXml';
import { buildAxQueryXml, buildAxViewXml } from '../../src/tools/queryViewXml';
import { buildAxDataEntityXml } from '../../src/tools/dataEntityXml';
import { buildAxServiceXml, buildAxServiceGroupXml } from '../../src/tools/serviceXml';
import { buildAxMapXml } from '../../src/tools/mapXml';
import { SmartXmlBuilder } from '../../src/utils/smartXmlBuilder';

/** The value that used to corrupt every generated file. */
const NASTY = 'Purchases & Sales <Ltd> "quoted"';

const parses = async (xml: string) => {
  await expect(parseStringPromise(xml)).resolves.toBeDefined();
};

describe('escapeXml', () => {
  it('escapes the three text-content metacharacters', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes `&` first so nothing is double-encoded', () => {
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves quotes alone in text content but escapes them in attributes', () => {
    // The Microsoft serializer does not escape quotes in text nodes; matching it
    // keeps generated files byte-comparable with shipped ones.
    expect(escapeXml('say "hi"')).toBe('say "hi"');
    expect(escapeXmlAttr('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('renders null/undefined as empty rather than the string "null"', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

describe('builders emit parseable XML for free text containing & and <', () => {
  it('AxSecurityPrivilege', async () => {
    const xml = buildAxSecurityPrivilegeXml('ContosoXyzPrivilege', {
      label: NASTY,
      targetObject: 'ContosoXyzMenuItem',
    });
    await parses(xml);
    expect(xml).toContain('Purchases &amp; Sales &lt;Ltd&gt;');
  });

  it('AxQuery title', async () => {
    const xml = buildAxQueryXml('ContosoXyzQuery', { title: NASTY, dataSource: 'CustTable' });
    await parses(xml);
  });

  it('AxQuery range value (an X++ expression, commonly with < or &&)', async () => {
    const xml = buildAxQueryXml('ContosoXyzQuery', {
      dataSource: 'CustTable',
      ranges: [{ field: 'AccountNum', value: '<(currentUserId())' }],
    });
    await parses(xml);
  });

  it('AxView', async () => {
    const xml = buildAxViewXml('ContosoXyzView', { label: NASTY, query: 'ContosoXyzQuery' });
    await parses(xml);
  });

  it('AxDataEntityView', async () => {
    const xml = buildAxDataEntityXml('ContosoXyzEntity', {
      label: NASTY,
      primaryTable: 'CustTable',
      fields: [{ name: 'AccountNum' }],
    });
    await parses(xml);
  });

  it('AxService description', async () => {
    const xml = buildAxServiceXml('ContosoXyzService', {
      serviceClass: 'ContosoXyzServiceClass',
      description: NASTY,
    });
    await parses(xml);
  });

  it('AxServiceGroup description', async () => {
    const xml = buildAxServiceGroupXml('ContosoXyzServiceGroup', { description: NASTY });
    await parses(xml);
  });

  it('AxMap label and developer documentation', async () => {
    const xml = buildAxMapXml('ContosoXyzMap', {
      label: NASTY,
      developerDocumentation: NASTY,
      fields: [{ name: 'AccountNum', type: 'String' }],
    });
    await parses(xml);
  });

  it('SmartXmlBuilder table with a nasty field label', async () => {
    const xml = new SmartXmlBuilder().buildTableXml({
      name: 'ContosoXyzTable',
      label: NASTY,
      fields: [{ name: 'AccountNum', type: 'String', label: NASTY }],
    });
    await parses(xml);
  });
});
