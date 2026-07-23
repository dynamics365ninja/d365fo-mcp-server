/**
 * The bridge create path writes the XML skeleton with CRLF but leaves the X++
 * inside <![CDATA[ ]]> on bare LF, so a freshly created class is mixed-EOL while
 * every AxClass on disk is pure CRLF. It compiles, but the first `modify`
 * re-serialises the file to CRLF — the artifact changes with nobody editing it,
 * and a golden captured straight from a create churns on the next touch.
 *
 * Measured on the L2-collections-map-list-container run: 34 CRLF / 98 LF after
 * create, 132 CRLF / 0 LF after one modify.
 */

import { describe, it, expect } from 'vitest';
import { normalizeD365Xml } from '../../src/utils/d365XmlNormalizer';

const MIXED_EOL_CLASS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
  '\t<Name>ConDemoCollectionUtil</Name>',
  '\t<SourceCode>',
  '\t\t<Declaration><![CDATA[',
].join('\r\n')
  // the CDATA payload the bridge writes: bare LF, no CR
  + '\npublic class ConDemoCollectionUtil\n{\n}\n'
  + [']]></Declaration>', '\t</SourceCode>', '</AxClass>'].join('\r\n');

describe('created artifact line endings', () => {
  it('the bridge output really is mixed-EOL — the defect this guards', () => {
    const bareLf = MIXED_EOL_CLASS.split('\n').length - 1 - (MIXED_EOL_CLASS.split('\r\n').length - 1);
    expect(bareLf).toBeGreaterThan(0);
  });

  it('normalization leaves no bare LF anywhere, CDATA included', () => {
    const normalized = normalizeD365Xml(MIXED_EOL_CLASS);
    const crlf = normalized.split('\r\n').length - 1;
    const lf = normalized.split('\n').length - 1;
    expect(lf).toBe(crlf);
    expect(normalized).toContain('public class ConDemoCollectionUtil\r\n{\r\n}');
  });

  it('does not double up CRLF that is already correct', () => {
    const clean = ['<?xml version="1.0" encoding="utf-8"?>', '<AxClass>', '</AxClass>'].join('\r\n');
    expect(normalizeD365Xml(clean)).toBe(clean);
    expect(normalizeD365Xml(clean)).not.toContain('\r\r');
  });

  it('is idempotent — re-normalizing a normalized file changes nothing', () => {
    const once = normalizeD365Xml(MIXED_EOL_CLASS);
    expect(normalizeD365Xml(once)).toBe(once);
  });
});
