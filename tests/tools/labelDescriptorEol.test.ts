/**
 * AxLabelFile descriptors are written the way Visual Studio writes them: CRLF
 * line endings and no newline after the closing tag. An LF descriptor turns
 * into a whole-file line-ending diff the first time VS saves it.
 */

import { describe, it, expect } from 'vitest';
import { buildAxLabelFileXml } from '../../src/tools/write/createLabel';

describe('buildAxLabelFileXml', () => {
  it('uses CRLF throughout, with no bare LF', () => {
    const xml = buildAxLabelFileXml('ContosoExt', 'cs', 'ContosoExt', 'ContosoExt');
    expect(xml).toContain('\r\n');
    expect(xml.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('ends at the closing tag, as VS-created descriptors do', () => {
    const xml = buildAxLabelFileXml('ContosoExt', 'en-US', 'ContosoExt', 'ContosoExt');
    expect(xml.endsWith('</AxLabelFile>')).toBe(true);
  });

  it('matches a VS-created descriptor byte for byte', () => {
    expect(buildAxLabelFileXml('CNX', 'cs', 'ContosoPackage', 'ContosoExt')).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\r\n' +
      '<AxLabelFile xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\r\n' +
      '\t<Name>CNX_cs</Name>\r\n' +
      '\t<LabelContentFileName>CNX.cs.label.txt</LabelContentFileName>\r\n' +
      '\t<LabelFileId>CNX</LabelFileId>\r\n' +
      '\t<Language>cs</Language>\r\n' +
      '\t<RelativeUriInModelStore>ContosoPackage\\ContosoExt\\AxLabelFile\\LabelResources\\cs\\CNX.cs.label.txt</RelativeUriInModelStore>\r\n' +
      '</AxLabelFile>',
    );
  });
});
