/**
 * Binary ISV models as the index-only readers present them (no bridge).
 *
 * A synthetic Contoso dump goes the way `npm run extract-binary-models` takes it: converted
 * into the per-object JSON, indexed by XppSymbolIndex, then read through the tools. A model
 * with XML sources sits next to it, so every check also says what a source object shows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { convertBinaryModel, type BinaryModelDump } from '../../src/metadata/binaryModelImport';
import { tableInfoTool } from '../../src/tools/readers/tableInfo';
import { getEdtInfoTool } from '../../src/tools/readers/edtInfo';

const BINARY_MODEL = 'ContosoTools';
const SOURCE_MODEL = 'ContosoExt';

const DUMP: BinaryModelDump = {
  Model: 'Contoso Tools',
  ModelInfo: { Module: BINARY_MODEL, Publisher: 'Contoso' },
  Tables: [{ Name: 'ContosoToolLog', Fields: [{ Name: 'Code', Type: 'String', Edt: 'ContosoToolCode' }] }],
  // The dump's JSON numbers are what used to come out as "15.0".
  Edts: [
    { Name: 'ContosoToolCode', BaseType: 'String', StringSize: 15 },
    { Name: 'ContosoToolChildCode', BaseType: 'String', Extends: 'ContosoToolCode' },
  ],
};

let tmp: string;
let index: XppSymbolIndex;

function writeJson(model: string, folder: string, obj: Record<string, unknown>): void {
  const dir = path.join(tmp, 'meta', model, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${obj.name}.json`), JSON.stringify(obj));
}

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: args },
});

const ctx = () => ({ symbolIndex: index, bridge: undefined, parser: {} }) as any;

async function text(result: Promise<any>): Promise<string> {
  const r = await result;
  return r.content[0].text as string;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-isv-readers-'));

  const m = convertBinaryModel(DUMP);
  for (const t of m.tables) writeJson(m.model, 'tables', t);
  for (const e of m.edts) writeJson(m.model, 'edts', e);

  // A source model, extracted from XML: its objects point at a real file.
  const xml = path.join(tmp, 'ContosoRentEquipmentTable.xml');
  fs.writeFileSync(xml, '<AxTable />');
  writeJson(SOURCE_MODEL, 'tables', {
    name: 'ContosoRentEquipmentTable',
    model: SOURCE_MODEL,
    sourcePath: xml,
    fields: [{ name: 'EquipmentId', type: 'String', extendedDataType: 'ContosoEquipmentId' }],
  });
  writeJson(SOURCE_MODEL, 'edts', { name: 'ContosoEquipmentId', model: SOURCE_MODEL, sourcePath: xml, stringSize: '20' });

  index = new XppSymbolIndex(':memory:', ':memory:');
  await index.indexMetadataDirectory(path.join(tmp, 'meta'));
});

afterAll(() => {
  index?.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NOTICE = '🔒 **Binary ISV, signatures only**';

describe('binary ISV notice in the table and EDT reads', () => {
  it('a table of a binary model carries the notice', async () => {
    const out = await text(tableInfoTool(req({ tableName: 'ContosoToolLog' }), ctx()));
    expect(out).toContain(NOTICE);
    expect(out).toContain('no AxTable XML, X++ source or method bodies exist');
    // Between the header and the fields, where the class reader puts it.
    expect(out.indexOf(NOTICE)).toBeLessThan(out.indexOf('## Fields'));
  });

  it('a table of a source model does not', async () => {
    const out = await text(tableInfoTool(req({ tableName: 'ContosoRentEquipmentTable' }), ctx()));
    expect(out).toContain('# Table: ContosoRentEquipmentTable');
    expect(out).not.toContain('Binary ISV');
  });

  it('an EDT of a binary model carries the notice, one of a source model does not', async () => {
    const binary = await text(getEdtInfoTool(req({ edtName: 'ContosoToolCode' }), ctx()));
    expect(binary).toContain(NOTICE);
    expect(binary).toContain('no AxEdt XML exists');

    const source = await text(getEdtInfoTool(req({ edtName: 'ContosoEquipmentId' }), ctx()));
    expect(source).toContain('# Extended Data Type: ContosoEquipmentId');
    expect(source).not.toContain('Binary ISV');
  });
});

describe('EDT string size of a binary ISV model', () => {
  it('is stored as integer text', () => {
    const row = index.getReadDb()
      .prepare(`SELECT string_size FROM edt_metadata WHERE edt_name = 'ContosoToolCode'`)
      .get() as { string_size: string };
    expect(row.string_size).toBe('15');
  });

  it('prints as an integer in the EDT read, the hierarchy and a table field', async () => {
    const edt = await text(getEdtInfoTool(req({ edtName: 'ContosoToolCode' }), ctx()));
    expect(edt).toContain('| String Size | 15 |');

    const child = await text(getEdtInfoTool(req({ edtName: 'ContosoToolChildCode', mode: 'hierarchy' }), ctx()));
    expect(child).toContain('Effective String Size: 15 (inherited from ContosoToolCode)');

    const table = await text(tableInfoTool(req({ tableName: 'ContosoToolLog' }), ctx()));
    expect(table).toContain('- **Code**: ContosoToolCode (String Size 15)');

    for (const out of [edt, child, table]) expect(out).not.toContain('15.0');
  });

  it('leaves the size of a source EDT as it was', async () => {
    const edt = await text(getEdtInfoTool(req({ edtName: 'ContosoEquipmentId' }), ctx()));
    expect(edt).toContain('| String Size | 20 |');
  });
});
