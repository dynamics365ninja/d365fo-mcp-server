/**
 * Unit tests for XmlTemplateGenerator.sanitizeReportXml()
 *
 * These tests guard against regressions where AxReport XML written by
 * create_d365fo_file is missing structural elements required by the
 * D365FO Visual Studio Designer metadata loader.
 *
 * Required invariants:
 *  1. xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> root
 *  2. <DataMethods /> directly after <Name>…</Name>
 *  3. xmlns="" on every <AxReportDataSet> element
 *  4. </AxReport> closing tag present
 */

import { describe, it, expect } from 'vitest';
import { XmlTemplateGenerator } from '../../src/tools/createD365File';

// Minimal well-formed report XML produced by the current template generator
const CORRECT_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
\t<Name>MyReport</Name>
\t<DataMethods />
\t<DataSets>
\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>MyReportTmp</Name>
\t\t</AxReportDataSet>
\t</DataSets>
\t<Designs />
\t<EmbeddedImages />
</AxReport>`;

// Broken XML simulating a pre-fix manually-created or old-generator file
const BROKEN_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>MyReport</Name>
\t<DataSets>
\t\t<AxReportDataSet>
\t\t\t<Name>MyReportTmp</Name>
\t\t</AxReportDataSet>
\t</DataSets>
\t<Designs />
\t<EmbeddedImages />
</AxReport>`;

// Truncated XML — closing tag missing
const TRUNCATED_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
\t<Name>MyReport</Name>
\t<DataMethods />
\t<DataSets>
\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>MyReportTmp</Name>
\t\t</AxReportDataSet>
\t</DataSets>`;

describe('XmlTemplateGenerator.sanitizeReportXml()', () => {
  // ─────────────────────────────────────────────────────────────
  // Idempotency — correct XML must not be changed
  // ─────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('should not modify already-correct XML', () => {
      const result = XmlTemplateGenerator.sanitizeReportXml(CORRECT_XML);
      expect(result).toBe(CORRECT_XML);
    });

    it('should be idempotent — applying twice gives same result as once', () => {
      const once = XmlTemplateGenerator.sanitizeReportXml(BROKEN_XML);
      const twice = XmlTemplateGenerator.sanitizeReportXml(once);
      expect(twice).toBe(once);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Fix 1 — xmlns="Microsoft.Dynamics.AX.Metadata.V2"
  // ─────────────────────────────────────────────────────────────
  describe('fix 1: xmlns on <AxReport>', () => {
    it('should add xmlns="Microsoft.Dynamics.AX.Metadata.V2" when missing', () => {
      const xml = `<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n\t<Name>X</Name>\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      expect(result).toContain('xmlns="Microsoft.Dynamics.AX.Metadata.V2"');
    });

    it('should not duplicate xmlns when already present', () => {
      const xml = `<AxReport xmlns:i="..." xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>X</Name>\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      const count = (result.match(/xmlns="Microsoft\.Dynamics\.AX\.Metadata\.V2"/g) || []).length;
      expect(count).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Fix 2 — <DataMethods />
  // ─────────────────────────────────────────────────────────────
  describe('fix 2: <DataMethods />', () => {
    it('should insert <DataMethods /> after top-level <Name> when missing', () => {
      const xml = `<AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>MyReport</Name>\n\t<DataSets />\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      expect(result).toContain('<DataMethods');
      // Must appear after <Name>
      const nameIdx = result.indexOf('<Name>MyReport</Name>');
      const dmIdx = result.indexOf('<DataMethods');
      expect(dmIdx).toBeGreaterThan(nameIdx);
    });

    it('should not add duplicate <DataMethods />', () => {
      const xml = `<AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>X</Name>\n\t<DataMethods />\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      const count = (result.match(/<DataMethods/g) || []).length;
      expect(count).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Fix 3 — xmlns="" on <AxReportDataSet>
  // ─────────────────────────────────────────────────────────────
  describe('fix 3: xmlns="" on <AxReportDataSet>', () => {
    it('should add xmlns="" to bare <AxReportDataSet>', () => {
      const xml = `<AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>X</Name>\n\t<DataMethods />\n\t<DataSets>\n\t\t<AxReportDataSet>\n\t\t</AxReportDataSet>\n\t</DataSets>\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      expect(result).toContain('<AxReportDataSet xmlns="">');
      expect(result).not.toContain('<AxReportDataSet>');
    });

    it('should not duplicate xmlns="" when already present', () => {
      const xml = `<AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>X</Name>\n\t<DataMethods />\n\t<DataSets>\n\t\t<AxReportDataSet xmlns="">\n\t\t</AxReportDataSet>\n\t</DataSets>\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      const count = (result.match(/<AxReportDataSet/g) || []).length;
      const withNs = (result.match(/<AxReportDataSet xmlns=""/g) || []).length;
      expect(count).toBe(withNs);
    });

    it('should fix multiple <AxReportDataSet> elements in one pass', () => {
      const xml = `<AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>X</Name>\n\t<DataMethods />\n\t<DataSets>\n\t\t<AxReportDataSet>\n\t\t</AxReportDataSet>\n\t\t<AxReportDataSet>\n\t\t</AxReportDataSet>\n\t</DataSets>\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      const count = (result.match(/<AxReportDataSet xmlns=""/g) || []).length;
      expect(count).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Fix 4 — </AxReport> closing tag
  // ─────────────────────────────────────────────────────────────
  describe('fix 4: </AxReport> closing tag', () => {
    it('should append </AxReport> when missing', () => {
      const result = XmlTemplateGenerator.sanitizeReportXml(TRUNCATED_XML);
      expect(result.trimEnd()).toMatch(/<\/AxReport>$/);
    });

    it('should not add extra closing tag when already present', () => {
      const xml = `<AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">\n\t<Name>X</Name>\n\t<DataMethods />\n</AxReport>`;
      const result = XmlTemplateGenerator.sanitizeReportXml(xml);
      const count = (result.match(/<\/AxReport>/g) || []).length;
      expect(count).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Full broken XML — all 4 fixes applied together
  // ─────────────────────────────────────────────────────────────
  describe('combined fix on fully broken XML', () => {
    it('should fix all 4 issues in BROKEN_XML in one call', () => {
      const result = XmlTemplateGenerator.sanitizeReportXml(BROKEN_XML);
      expect(result).toContain('xmlns="Microsoft.Dynamics.AX.Metadata.V2"');
      expect(result).toContain('<DataMethods');
      expect(result).toContain('<AxReportDataSet xmlns="">');
      expect(result.trimEnd()).toMatch(/<\/AxReport>$/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Template generator output — verify it's already correct
  // ─────────────────────────────────────────────────────────────
  describe('template generator output', () => {
    it('generateAxReportXml() output passes sanitize without any changes', () => {
      const generated = XmlTemplateGenerator.generateAxReportXml('TestReport', {
        tmpTableName: 'TestReportTmp',
        dpClassName: 'TestReportDP',
        datasetName: 'TestReportTmp',
      });
      const sanitized = XmlTemplateGenerator.sanitizeReportXml(generated);
      expect(sanitized).toBe(generated);
    });
  });
});
