/**
 * "How long is the customer name?" without the bridge.
 *
 * The full index build stored a table field's bare base type as its signature, so
 * DirPartyTable.Name indexed as "String" even though the extracted JSON carried
 * `extendedDataType: "DirPartyName"`. update_symbol_index already stored the EDT, so the
 * same column meant two different things depending on which path last wrote the table.
 * With the EDT gone, the index-only table reader (the only reader on a deployment without
 * the bridge) could not give a field's length at all, and an agent asked for it guessed.
 *
 * The length itself lives on the EDT chain: CustName declares no StringSize and extends
 * DirPartyName, which declares 160.
 *
 * Storing the EDT has a cost in search, which full-text-matches the signature: every field
 * typed with an EDT now matches that EDT's name. Measured on an ApplicationPlatform +
 * Directory + Foundation index, `CustName` returned 20 field rows out of 20 and lost every
 * EDT and method. Fields that match only on their EDT now rank below everything else.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { tableInfoTool } from '../../src/tools/readers/tableInfo';

let tmpDir: string;
let index: XppSymbolIndex;

const TABLE = 'DemoPartyTable';

const writeJson = async (model: string, kind: string, name: string, data: object) => {
  const dir = path.join(tmpDir, 'extracted', model, kind);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify({ name, model, ...data }));
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'table-field-size-'));
  // The reader refuses an index row whose source file is gone, so point it at a real one.
  const tableXml = path.join(tmpDir, `${TABLE}.xml`);
  await fs.writeFile(tableXml, '<AxTable />');

  await writeJson('Directory', 'edts', 'DirPartyName', { stringSize: '160', displayLength: '30' });
  await writeJson('Foundation', 'edts', 'CustName', { extends: 'DirPartyName' });
  await writeJson('Foundation', 'edts', 'CustNameAlias', { extends: 'DirPartyName' });
  await writeJson('Demo', 'tables', TABLE, {
    sourcePath: tableXml,
    fields: [
      { name: 'Name', type: 'String', extendedDataType: 'DirPartyName', mandatory: true },
      { name: 'Customer', type: 'String', extendedDataType: 'CustName', mandatory: false },
      // X++ is case-insensitive; the EDT's own file spells it CustName.
      { name: 'Invoicee', type: 'String', extendedDataType: 'custname', mandatory: false },
      { name: 'PartyType', type: 'Enum', enumType: 'DirPartyType', mandatory: false },
      { name: 'Untyped', type: 'String', mandatory: false },
    ],
  });
  // Tables with a field NAMED after its EDT -- the row that matches the EDT's name twice,
  // in its name and its signature, and outscored the EDT itself.
  for (let i = 0; i < 12; i++) {
    await writeJson('Demo', 'tables', `DemoReportTmp${i}`, {
      sourcePath: tableXml,
      fields: [{ name: 'CustName', type: 'String', extendedDataType: 'CustName', mandatory: false }],
    });
  }
  // A view field has always carried the field it maps to as its signature; its ranking
  // must not move.
  await writeJson('Demo', 'views', 'DemoCustView', {
    sourcePath: tableXml,
    fields: [{ name: 'CustName', dataField: 'CustName' }],
  });

  index = new XppSymbolIndex(':memory:', ':memory:');
  await index.indexMetadataDirectory(path.join(tmpDir, 'extracted'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const req = (tableName: string): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: { tableName } },
});

describe('full index build stores a field EDT, like update_symbol_index', () => {
  it('writes the EDT, the enum type, or the base type only when there is neither', () => {
    const rows = index.getReadDb().prepare(
      `SELECT name, signature FROM symbols WHERE type = 'field' AND parent_name = ?`,
    ).all(TABLE) as Array<{ name: string; signature: string }>;
    const sig = Object.fromEntries(rows.map(r => [r.name, r.signature]));

    expect(sig).toEqual({
      Name: 'DirPartyName',
      Customer: 'CustName',
      Invoicee: 'custname',
      PartyType: 'DirPartyType',
      Untyped: 'String',
    });
  });
});

describe('index-only table reader reports a field length', () => {
  it('gives the size of a field whose EDT declares it, and inherited sizes with their source', async () => {
    const result = await tableInfoTool(req(TABLE), { symbolIndex: index, parser: {} } as any);
    const text = result.content[0].text;

    expect(text).toContain('Served from symbol index');
    expect(text).toContain('**Name**: DirPartyName (String Size 160)');
    expect(text).toContain('**Customer**: CustName (String Size 160, inherited from DirPartyName)');
    // No EDT row, so no size claimed.
    expect(text).toMatch(/\*\*PartyType\*\*: DirPartyType\n/);
    expect(text).toMatch(/\*\*Untyped\*\*: String\n/);
  });

  it('resolves an EDT the field spells in a different case', async () => {
    const text = (await tableInfoTool(req(TABLE), { symbolIndex: index, parser: {} } as any)).content[0].text;
    expect(text).toContain('**Invoicee**: custname (String Size 160, inherited from DirPartyName)');
  });

  it('says the sizes leave EDT extensions out', async () => {
    const text = (await tableInfoTool(req(TABLE), { symbolIndex: index, parser: {} } as any)).content[0].text;
    expect(text).toContain('do NOT include EDT extensions');
  });
});

describe('search: a table field typed with an EDT does not crowd out the EDT', () => {
  const hits = (limit: number) =>
    (index.searchSymbols('CustName', limit) as any[]).map(r => `${r.type}:${r.parentName ?? ''}.${r.name}`);

  it('keeps the EDT in a window the same-named table fields would otherwise fill', () => {
    // Twelve table fields called CustName and typed CustName. Scored on their signature too,
    // all twelve outranked the EDT and a window of 5 held none of it.
    expect(hits(5)).toContain('edt:.CustName');
  });

  it('still finds the table fields typed with it', () => {
    expect(hits(50).filter(h => h.startsWith('field:DemoReportTmp'))).toHaveLength(12);
  });

  it('returns exactly what sorting on the score in SQL returns, at every window size', () => {
    // searchSymbols streams in ORDER BY rank order and stops early rather than sorting on
    // the score expression (2-3x slower on a full index). It must not change the answer.
    const sorted = index.getReadDb().prepare(
      `SELECT s.name, s.type, s.parent_name FROM symbols_fts fts JOIN symbols s ON s.id = fts.rowid
       WHERE symbols_fts MATCH ?
       ORDER BY CASE WHEN s.type = 'field' AND EXISTS (
         SELECT 1 FROM symbols t WHERE t.name = s.parent_name AND t.type = 'table'
       ) THEN bm25(symbols_fts, 1, 1, 1, 0, 1, 1, 1, 1) ELSE rank END, s.id`,
    ).all('{name type parent_name signature description tags} : "CustName"*') as any[];
    const expected = sorted.map(r => `${r.type}:${r.parent_name ?? ''}.${r.name}`);
    for (const limit of [1, 3, 5, 13, 50]) {
      expect(hits(limit)).toEqual(expected.slice(0, limit));
    }
  });

  it('leaves a view field scored on its signature, as it always was', () => {
    const h = hits(50);
    expect(h.indexOf('field:DemoCustView.CustName')).toBeLessThan(h.indexOf('edt:.CustName'));
  });
});

describe('search: streaming top-N by score', () => {
  const topByFtsScore = (XppSymbolIndex as any).topByFtsScore as (
    rows: Array<{ fts_rank: number; fts_score: number }>, limit: number,
  ) => Array<{ fts_rank: number; fts_score: number }>;

  it('keeps reading past a row that scores worse than the window until the rank rules out the rest', () => {
    // Rows arrive in rank order. The third is a table field whose EDT match inflated its
    // rank: its score is poor, but the fourth row's rank still beats the window's worst
    // score, so it belongs in the answer. Stopping on the third row's SCORE would drop it.
    const rows = [
      { fts_rank: -10, fts_score: -9 },
      { fts_rank: -9.5, fts_score: -8 },
      { fts_rank: -8.5, fts_score: -1 },
      { fts_rank: -8.4, fts_score: -8.4 },
      { fts_rank: -7, fts_score: -7 },
    ];
    expect(topByFtsScore(rows, 2).map(r => r.fts_score)).toEqual([-9, -8.4]);
  });

  it('stops once no later row can enter', () => {
    let read = 0;
    function* rows() {
      for (const r of [-10, -9, -8, -7, -6]) { read++; yield { fts_rank: r, fts_score: r }; }
    }
    expect(topByFtsScore(rows() as any, 2).map(r => r.fts_score)).toEqual([-10, -9]);
    expect(read).toBe(3);
  });

  it('returns nothing for a zero window', () => {
    expect(topByFtsScore([{ fts_rank: -1, fts_score: -1 }], 0)).toEqual([]);
  });
});
