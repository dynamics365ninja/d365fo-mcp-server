/**
 * readIndexedXml falls back to the copy the index stored (form_source) for a FORM whose
 * file this host cannot reach — a database-only host, such as the Azure read-only instance — and
 * nowhere else:
 *   - a file that is here wins, and is labelled 'file';
 *   - a stored copy is labelled 'stored' with its write time;
 *   - a file this machine can tell was deleted is NOT answered from a leftover row;
 *   - only forms ever consult the table (queries and reports are unchanged);
 *   - a missing table, row or garbage blob is a miss, never a throw;
 *   - the lookup keys on the symbol row's model, never another model's row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'node:zlib';

// The remap consults the configured packages root; a test must not depend on one.
vi.mock('../../src/utils/metadataResolver', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/metadataResolver')>()),
  resolveDbPathLocally: async () => null,
  remapDbPathLocally: async () => null,
}));

import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { readIndexedXml, resetStaleRootCache } from '../../src/utils/indexedXmlLookup';

const XML = '<AxForm><Name>SalesTable</Name></AxForm>';
// A CI-agent spelling: absolute on its own host, nothing like it here.
const AGENT_PATH = '/home/vsts/work/1/s/PackagesLocalDirectory/Pkg/Model/AxForm/SalesTable.xml';

let index: XppSymbolIndex;
let tmp: string;

beforeEach(() => {
  resetStaleRootCache();
  index = new XppSymbolIndex(':memory:', ':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'read-indexed-xml-'));
});
afterEach(() => {
  index.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const addForm = (filePath: string, model = 'Model', name = 'SalesTable') =>
  index.addSymbol({ name, type: 'form', filePath, model } as any);

const store = (model = 'Model', name = 'SalesTable', xml = XML) =>
  index.db.prepare('INSERT OR REPLACE INTO form_source (form_name, model, xml_gz, indexed_at) VALUES (?, ?, ?, ?)')
    .run(name, model, gzipSync(Buffer.from(xml)), '2026-10-01T10:00:00.000Z');

describe('readIndexedXml — stored form copy', () => {
  it('answers from the stored copy when the file is not on this host', async () => {
    addForm(AGENT_PATH);
    store();

    const r = await readIndexedXml(index.getReadDb(), 'SalesTable', ['form']);

    expect(r?.source).toBe('stored');
    expect(r?.xml).toBe(XML);
    expect(r?.storedAt).toBe('2026-10-01T10:00:00.000Z');
  });

  it('prefers a file that is here, and says so', async () => {
    const file = path.join(tmp, 'SalesTable.xml');
    fs.writeFileSync(file, '<AxForm><Name>FromDisk</Name></AxForm>');
    addForm(file);
    store();

    const r = await readIndexedXml(index.getReadDb(), 'SalesTable', ['form']);

    expect(r?.source).toBe('file');
    expect(r?.xml).toContain('FromDisk');
  });

  it('does not resurrect a form whose file is known to be deleted', async () => {
    // The file's metadata root is here and populated, so absence means deleted.
    const root = path.join(tmp, 'PackagesLocalDirectory');
    fs.mkdirSync(path.join(root, 'Pkg', 'Model', 'AxForm'), { recursive: true });
    addForm(path.join(root, 'Pkg', 'Model', 'AxForm', 'SalesTable.xml'));
    store();

    const r = await readIndexedXml(index.getReadDb(), 'SalesTable', ['form']);

    expect(r).toBeNull();
  });

  it('never consults the table for another object type', async () => {
    index.addSymbol({ name: 'SalesTable', type: 'query', filePath: AGENT_PATH.replace('AxForm', 'AxQuery'), model: 'Model' } as any);
    store();

    const r = await readIndexedXml(index.getReadDb(), 'SalesTable', ['query']);

    expect(r).toBeNull();
  });

  it('is a miss, not a throw, when there is no row, no table or a corrupt blob', async () => {
    addForm(AGENT_PATH);
    expect(await readIndexedXml(index.getReadDb(), 'SalesTable', ['form'])).toBeNull();

    index.db.prepare('INSERT INTO form_source (form_name, model, xml_gz, indexed_at) VALUES (?, ?, ?, ?)')
      .run('SalesTable', 'Model', Buffer.from('not gzip'), 'x');
    expect(await readIndexedXml(index.getReadDb(), 'SalesTable', ['form'])).toBeNull();

    index.db.exec('DROP TABLE form_source');
    expect(await readIndexedXml(index.getReadDb(), 'SalesTable', ['form'])).toBeNull();
  });

  it('keys on the symbol row\'s model, ignoring the caller\'s case and never using another model\'s row', async () => {
    addForm(AGENT_PATH, 'Model');
    store('OtherModel', 'SalesTable', '<AxForm><Name>Other</Name></AxForm>');

    // Only OtherModel has a stored copy: the form in Model must not be shown that one.
    expect(await readIndexedXml(index.getReadDb(), 'SalesTable', ['form'])).toBeNull();

    // A model spelled in another case still finds its own row.
    store('MODEL');
    const r = await readIndexedXml(index.getReadDb(), 'SalesTable', ['form'], 'whatever the caller passed');
    expect(r?.source).toBe('stored');
    expect(r?.xml).toBe(XML);
  });

  it('matches the form name case-insensitively through the symbol row', async () => {
    addForm(AGENT_PATH);
    store();
    const r = await readIndexedXml(index.getReadDb(), 'salestable', ['form']);
    expect(r?.source).toBe('stored');
  });
});
