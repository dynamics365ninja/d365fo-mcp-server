/**
 * index.storeObjectSource (STORE_OBJECT_SOURCE=false) turns off the copy of every object's
 * original XML: no `raw` in the extracted JSON (enums keep theirs, it is their whole
 * record) and no object_source rows, in the build and in update_symbol_index alike.
 * Everything else the index keeps for an object is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { storeObjectSourceEnabled } from '../../src/metadata/objectSourceSetting';

const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AxForm">
\t<Name>ContosoSourceDemoForm</Name>
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
let prevStore: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-object-source-'));
  prevMetadataPath = process.env.METADATA_PATH;
  prevStore = process.env.STORE_OBJECT_SOURCE;
  // Both are read when the extract script is imported.
  process.env.METADATA_PATH = path.join(root, 'out');
});
afterEach(() => {
  if (prevMetadataPath === undefined) delete process.env.METADATA_PATH;
  else process.env.METADATA_PATH = prevMetadataPath;
  if (prevStore === undefined) delete process.env.STORE_OBJECT_SOURCE;
  else process.env.STORE_OBJECT_SOURCE = prevStore;
  fs.rmSync(root, { recursive: true, force: true });
});

async function extractOneForm(): Promise<string> {
  vi.resetModules();
  const { extractForms } = await import('../../scripts/extract-metadata');
  const { XppMetadataParser } = await import('../../src/metadata/xmlParser');

  const formsDir = path.join(root, 'aot', 'ContosoPkg', 'ContosoPkg', 'AxForm');
  fs.mkdirSync(formsDir, { recursive: true });
  fs.writeFileSync(path.join(formsDir, 'ContosoSourceDemoForm.xml'), FORM_XML);

  const stats: any = { totalFiles: 0, forms: 0, errors: 0 };
  await extractForms(new XppMetadataParser(), formsDir, 'ContosoPkg', stats, false);
  expect(stats.errors).toBe(0);
  return path.join(root, 'out', 'ContosoPkg', 'forms', 'ContosoSourceDemoForm.json');
}

function count(index: any, sql: string): number {
  return (index.db.prepare(sql).get() as any).n;
}

describe('storeObjectSourceEnabled', () => {
  it('is on unless STORE_OBJECT_SOURCE is "false"', () => {
    expect(storeObjectSourceEnabled({})).toBe(true);
    expect(storeObjectSourceEnabled({ STORE_OBJECT_SOURCE: 'true' })).toBe(true);
    expect(storeObjectSourceEnabled({ STORE_OBJECT_SOURCE: '' })).toBe(true);
    expect(storeObjectSourceEnabled({ STORE_OBJECT_SOURCE: 'false' })).toBe(false);
  });
});

describe('extraction with STORE_OBJECT_SOURCE=false', () => {
  it('writes the parsed form without its XML', async () => {
    process.env.STORE_OBJECT_SOURCE = 'false';
    const json = JSON.parse(fs.readFileSync(await extractOneForm(), 'utf-8'));

    expect(json.raw).toBeUndefined();
    expect(json.name).toBe('ContosoSourceDemoForm');
    expect(json.dataSources).toHaveLength(1);
  });

  it('keeps the XML by default', async () => {
    delete process.env.STORE_OBJECT_SOURCE;
    const json = JSON.parse(fs.readFileSync(await extractOneForm(), 'utf-8'));

    expect(json.raw).toBe(FORM_XML);
  });
});

describe('index build with object_source turned off', () => {
  it('stores no copy even when the JSON carries raw, and indexes the form as usual', async () => {
    delete process.env.STORE_OBJECT_SOURCE;
    await extractOneForm(); // with raw, as an extract made before the setting was turned off
    const { XppSymbolIndex } = await import('../../src/metadata/symbolIndex');
    const index = new XppSymbolIndex(':memory:', ':memory:', { storeObjectSource: false });
    try {
      await index.indexMetadataDirectory(path.join(root, 'out'), 'ContosoPkg');

      expect(count(index, `SELECT COUNT(*) AS n FROM symbols WHERE type = 'form'`)).toBe(1);
      expect(count(index, 'SELECT COUNT(*) AS n FROM form_datasources')).toBe(1);
      expect(count(index, 'SELECT COUNT(*) AS n FROM form_patterns')).toBeGreaterThan(0);
      expect(count(index, 'SELECT COUNT(*) AS n FROM object_source')).toBe(0);
    } finally {
      index.close();
    }
  });

  it('takes the default from STORE_OBJECT_SOURCE, which update_symbol_index shares', async () => {
    process.env.STORE_OBJECT_SOURCE = 'false';
    vi.resetModules();
    const { XppSymbolIndex } = await import('../../src/metadata/symbolIndex');
    const index = new XppSymbolIndex(':memory:', ':memory:');
    try {
      index.writeObjectSource('class', 'ContosoSourceDemoClass', 'ContosoPkg', '<AxClass />');
      expect(count(index, 'SELECT COUNT(*) AS n FROM object_source')).toBe(0);
    } finally {
      index.close();
    }
  });

  it('still stores the copy by default', async () => {
    delete process.env.STORE_OBJECT_SOURCE;
    vi.resetModules();
    const { XppSymbolIndex } = await import('../../src/metadata/symbolIndex');
    const index = new XppSymbolIndex(':memory:', ':memory:');
    try {
      index.writeObjectSource('class', 'ContosoSourceDemoClass', 'ContosoPkg', '<AxClass />');
      expect(count(index, 'SELECT COUNT(*) AS n FROM object_source')).toBe(1);
    } finally {
      index.close();
    }
  });
});
