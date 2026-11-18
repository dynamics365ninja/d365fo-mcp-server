/**
 * Indexes and relations from the symbol index, for a host without the bridge (#1276).
 *
 * `table_relations` was filled for every table but never read by get_object_info, and
 * indexes were not stored at all. Both a source table (extracted JSON) and a binary-ISV
 * table (toTableInfo output) must list them.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/bridge/bridgeAdapter', () => ({ tryBridgeTable: vi.fn(async () => null) }));

import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { tableInfoTool } from '../../src/tools/readers/tableInfo';

let tmpDir: string;
let index: XppSymbolIndex;

const writeJson = async (model: string, name: string, data: object) => {
  const dir = path.join(tmpDir, 'extracted', model, 'tables');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify({ name, model, ...data }));
};

const relations = [
  { name: 'ContosoCust', relatedTable: 'CustTable', constraints: [{ field: 'CustAccount', relatedField: 'AccountNum' }] },
  { name: 'ContosoItem', relatedTable: 'InventTable', constraints: [] },
];
const indexes = [
  { name: 'AccountIdx', fields: ['CustAccount', 'Id'], unique: true, clustered: false },
  { name: 'ItemIdx', fields: ['ItemId'], unique: false, clustered: true },
];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'table-idx-rel-'));
  const xml = path.join(tmpDir, 'T.xml');
  await fs.writeFile(xml, '<AxTable />');
  const fields = [{ name: 'Id', type: 'String', mandatory: false }];
  await writeJson('ContosoExt', 'ContosoSourceTable', {
    sourcePath: xml, fields, relations, indexes, primaryIndex: 'AccountIdx', clusteredIndex: 'ItemIdx',
  });
  // Binary-ISV shape (toTableInfo): primary and clustered named on the table.
  await writeJson('ContosoVendor', 'ContosoBinaryTable', {
    sourcePath: xml, fields, relations, indexes, primaryIndex: 'ItemIdx', clusteredIndex: 'ItemIdx',
  });
  await writeJson('ContosoExt', 'ContosoBareTable', { sourcePath: xml, fields });
  index = new XppSymbolIndex(':memory:', ':memory:');
  await index.indexMetadataDirectory(path.join(tmpDir, 'extracted'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const call = async (tableName: string, extra: object = {}) => {
  const req: CallToolRequest = {
    method: 'tools/call',
    params: { name: 'get_object_info', arguments: { tableName, ...extra } },
  };
  const r: any = await tableInfoTool(req, { symbolIndex: index, parser: {}, bridge: null } as any);
  return r.content[0].text as string;
};

describe('get_object_info(table) from the index', () => {
  it('lists indexes with unique, primary and clustered marked', async () => {
    const t = await call('ContosoSourceTable');
    expect(t).toContain('## Indexes (2)');
    expect(t).toContain('**AccountIdx** (CustAccount, Id) [unique, primary]');
    expect(t).toContain('**ItemIdx** (ItemId) [clustered]');
  });

  it('marks a binary table the same way', async () => {
    const t = await call('ContosoBinaryTable');
    expect(t).toContain('**ItemIdx** (ItemId) [primary, clustered]');
    expect(t).toContain('**AccountIdx** (CustAccount, Id) [unique]');
  });

  it('shows only the relation count by default', async () => {
    const t = await call('ContosoSourceTable');
    expect(t).toContain('**Relations:** 2');
    expect(t).not.toContain('ContosoCust');
  });

  it('lists relations with constraints when relations:true, and drops the "not applied" note', async () => {
    const t = await call('ContosoBinaryTable', { relations: true });
    expect(t).toContain('## Relations (2)');
    expect(t).toContain('**ContosoCust** -> CustTable: CustAccount = CustTable.AccountNum');
    expect(t).toContain('**ContosoItem** -> InventTable');
    expect(t).not.toContain('NOT applied');
  });

  it('still names compact:false as not applied', async () => {
    const t = await call('ContosoSourceTable', { compact: false });
    expect(t).toContain('`compact:false`');
  });

  it('says a table without stored indexes may need a re-index', async () => {
    const t = await call('ContosoBareTable');
    expect(t).toContain('No indexes stored');
    expect(t).toContain('**Relations:** 0');
  });

  it('clearModels removes the stored indexes', () => {
    const db = index.getReadDb();
    const count = () => (db.prepare('SELECT COUNT(*) c FROM table_indexes WHERE model = ?').get('ContosoVendor') as any).c;
    expect(count()).toBe(2);
    index.clearModels(['ContosoVendor']);
    expect(count()).toBe(0);
  });
});
