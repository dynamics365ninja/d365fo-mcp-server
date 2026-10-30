/**
 * The extractor attaches a form's original XML to its JSON as `raw`, and the index
 * build turns that into a form_source row.
 *
 * extractForms -> JSON -> XppSymbolIndex.indexMetadataDirectory is the real build
 * path, run here end to end on a one-form model. JSON written before `raw` existed has
 * none: such a form still gets its symbol, datasources and patterns, just no stored
 * source, until it is re-extracted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'node:zlib';

const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AxForm">
\t<Name>RawDemoForm</Name>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>Main</Name>
\t\t\t<Table>SalesTable</Table>
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
\t\t<Pattern xmlns="">SimpleList</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Controls />
\t</Design>
</AxForm>`;

let root: string;
let prevMetadataPath: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-forms-raw-'));
  prevMetadataPath = process.env.METADATA_PATH;
  // OUTPUT_PATH is read from the environment when the script is imported.
  process.env.METADATA_PATH = path.join(root, 'out');
});
afterEach(() => {
  if (prevMetadataPath === undefined) delete process.env.METADATA_PATH;
  else process.env.METADATA_PATH = prevMetadataPath;
  fs.rmSync(root, { recursive: true, force: true });
});

async function extractOneForm() {
  vi.resetModules();
  const { extractForms } = await import('../../scripts/extract-metadata');
  const { XppMetadataParser } = await import('../../src/metadata/xmlParser');

  const formsDir = path.join(root, 'aot', 'DemoPkg', 'DemoPkg', 'AxForm');
  fs.mkdirSync(formsDir, { recursive: true });
  fs.writeFileSync(path.join(formsDir, 'RawDemoForm.xml'), FORM_XML);

  const stats: any = { totalFiles: 0, forms: 0, errors: 0 };
  await extractForms(new XppMetadataParser(), formsDir, 'DemoPkg', stats, false);
  expect(stats.errors).toBe(0);
  return path.join(root, 'out', 'DemoPkg', 'forms', 'RawDemoForm.json');
}

describe('extractForms', () => {
  it('writes the original XML as `raw` next to the parsed structure', async () => {
    const jsonFile = await extractOneForm();

    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    expect(json.raw).toBe(FORM_XML);
    expect(json.name).toBe('RawDemoForm');
    expect(json.dataSources).toHaveLength(1);
  });
});

describe('index build from the extracted JSON', () => {
  it('stores the XML as form_source when the JSON carries raw', async () => {
    await extractOneForm();
    const { XppSymbolIndex } = await import('../../src/metadata/symbolIndex');
    const index = new XppSymbolIndex(':memory:', ':memory:');
    try {
      await index.indexMetadataDirectory(path.join(root, 'out'), 'DemoPkg');

      const row = index.db.prepare(`SELECT xml_gz FROM form_source WHERE form_name = 'RawDemoForm'`).get() as any;
      expect(gunzipSync(row.xml_gz).toString('utf-8')).toBe(FORM_XML);
      expect((index.db.prepare('SELECT COUNT(*) AS n FROM form_datasources').get() as any).n).toBe(1);
    } finally {
      index.close();
    }
  });

  it('still indexes a form from JSON written before raw existed, without a stored copy', async () => {
    const jsonFile = await extractOneForm();
    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    delete json.raw;
    fs.writeFileSync(jsonFile, JSON.stringify(json));

    const { XppSymbolIndex } = await import('../../src/metadata/symbolIndex');
    const index = new XppSymbolIndex(':memory:', ':memory:');
    try {
      await index.indexMetadataDirectory(path.join(root, 'out'), 'DemoPkg');

      expect((index.db.prepare(`SELECT COUNT(*) AS n FROM symbols WHERE type = 'form'`).get() as any).n).toBe(1);
      expect((index.db.prepare('SELECT COUNT(*) AS n FROM form_datasources').get() as any).n).toBe(1);
      expect((index.db.prepare('SELECT COUNT(*) AS n FROM form_patterns').get() as any).n).toBeGreaterThan(0);
      expect((index.db.prepare('SELECT COUNT(*) AS n FROM form_source').get() as any).n).toBe(0);
    } finally {
      index.close();
    }
  });
});
