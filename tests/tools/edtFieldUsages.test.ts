/**
 * `get_object_info(objectType="edt", mode="hierarchy")` — field usages.
 *
 * Two defects, both in the one query that listed "fields using this EDT":
 *
 *   SELECT parent_name, name, model FROM symbols
 *    WHERE type = 'field' AND signature LIKE '%EdtName%'
 *    ORDER BY model, parent_name LIMIT 50
 *
 * 1. Correctness. For a `type='field'` row, `signature` holds the field's type
 *    name, so this is an equality question. As a substring test, AmountMST also
 *    matched fields typed QuotationAmountMST, AdjustAmountMST, BaseAmountMST,
 *    PaymAmountMST — reported to the agent as fields of the EDT it asked about.
 *
 * 2. Performance. The LIKE could not use an index, and ORDER BY forced every
 *    match to be read and sorted before LIMIT 50 applied. Measured against the
 *    2 GB production index: 63 s for a name that exists. node:sqlite is
 *    synchronous, so that is 63 s of blocked event loop.
 *
 * The rewrite pre-filters through symbols_fts and decides with a COLLATE NOCASE
 * equality (X++ identifiers are case-insensitive): 22–41 ms on the same index,
 * with 100 % recall against a case-insensitive full scan.
 *
 * Separately, hierarchy mode probed edt_metadata by exact equality and had no
 * canonicalization step, so `amountmst` reported the EDT as missing while
 * `AmountMST` returned it — disagreeing with basic mode about what exists.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from '../../src/database/sqlite.js';
import { getEdtInfoTool } from '../../src/tools/edtInfo';

interface FieldRow { table: string; field: string; signature: string; model?: string }

function makeDb(edts: Array<{ name: string; extends?: string }>, fields: FieldRow[]) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE edt_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      edt_name TEXT NOT NULL, extends TEXT, enum_type TEXT, reference_table TEXT,
      relation_type TEXT, string_size TEXT, database_string_size TEXT,
      display_length TEXT, label TEXT, model TEXT NOT NULL
    );
    CREATE INDEX idx_edt_metadata_name ON edt_metadata(edt_name);
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, parent_name TEXT,
      signature TEXT, file_path TEXT, model TEXT, description TEXT, extends_class TEXT
    );
    CREATE INDEX idx_name_type ON symbols(name, type);
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, type, parent_name, signature, description, tags);
  `);

  const insEdt = db.prepare(
    `INSERT INTO edt_metadata (edt_name, extends, model) VALUES (?, ?, 'ApplicationSuite')`);
  const insSym = db.prepare(
    `INSERT INTO symbols (name, type, parent_name, signature, model) VALUES (?, ?, ?, ?, ?)`);
  const insFts = db.prepare(
    `INSERT INTO symbols_fts (rowid, name, type, parent_name, signature) VALUES (?, ?, ?, ?, ?)`);

  for (const e of edts) {
    insEdt.run(e.name, e.extends ?? null);
    const info = insSym.run(e.name, 'edt', null, null, 'ApplicationSuite');
    insFts.run(info.lastInsertRowid, e.name, 'edt', null, null);
  }
  for (const f of fields) {
    const model = f.model ?? 'ApplicationSuite';
    const info = insSym.run(f.field, 'field', f.table, f.signature, model);
    insFts.run(info.lastInsertRowid, f.field, 'field', f.table, f.signature);
  }
  return db;
}

/** Bridge absent, so the tool answers from the index — the VM's real shape. */
function ctx(db: any) {
  return {
    symbolIndex: { getReadDb: () => db },
    bridge: { isReady: true, metadataAvailable: true, readEdt: vi.fn(async () => null) },
  } as any;
}

const req = (edtName: string) => ({
  method: 'tools/call' as const,
  params: { name: 'get_edt_info', arguments: { edtName, mode: 'hierarchy' } },
});

const FIELDS: FieldRow[] = [
  { table: 'CustTrans',      field: 'AmountMST',       signature: 'AmountMST' },
  { table: 'VendTrans',      field: 'AmountMST',       signature: 'amountMST' },   // case variant
  { table: 'LedgerTrans',    field: 'AmountMst',       signature: 'AmountMst' },   // case variant
  { table: 'SalesQuotation', field: 'QuotationAmount', signature: 'QuotationAmountMST' },
  { table: 'AssetTrans',     field: 'AdjustAmount',    signature: 'AdjustAmountMST' },
  { table: 'PaymTrans',      field: 'PaymAmount',      signature: 'PaymAmountMST' },
  { table: 'CustTable',      field: 'AccountNum',      signature: 'CustAccount' },
];

async function usageLines(edtName: string, db: any): Promise<string[]> {
  const result: any = await getEdtInfoTool(req(edtName), ctx(db));
  const text: string = result.content[0].text;
  const start = text.indexOf('Field Usages');
  if (start < 0) return [];
  return text
    .slice(start)
    .split('\n')
    .slice(1)
    .map(l => l.trim())
    .filter(l => l.includes('.') && l.includes('['));
}

describe('EDT hierarchy — field usages list fields of that exact type', () => {
  it('does not report fields whose type merely contains the EDT name', async () => {
    const db = makeDb([{ name: 'AmountMST', extends: 'Amount' }], FIELDS);
    const lines = await usageLines('AmountMST', db);

    expect(lines.join('\n')).not.toMatch(/QuotationAmount|AdjustAmount|PaymAmount/);
    expect(lines).toHaveLength(3); // the exact-type fields, case variants included
  });

  it('treats X++ case variants of the type name as the same type', async () => {
    const db = makeDb([{ name: 'AmountMST', extends: 'Amount' }], FIELDS);
    const lines = await usageLines('AmountMST', db);

    // signature stored as AmountMST / amountMST / AmountMst — all one X++ type
    expect(lines.join('\n')).toContain('CustTrans.AmountMST');
    expect(lines.join('\n')).toContain('VendTrans.AmountMST');
    expect(lines.join('\n')).toContain('LedgerTrans.AmountMst');
  });

  it('resolves the EDT itself case-insensitively, as basic mode does', async () => {
    const db = makeDb([{ name: 'AmountMST', extends: 'Amount' }], FIELDS);

    const result: any = await getEdtInfoTool(req('amountmst'), ctx(db));
    const text: string = result.content[0].text;

    expect(text).not.toMatch(/not found/i);
    expect(text).toContain('AmountMST');
    expect(await usageLines('amountmst', db)).toHaveLength(3);
  });

  it('still reports a genuinely unknown EDT as not found', async () => {
    const db = makeDb([{ name: 'AmountMST' }], FIELDS);

    const result: any = await getEdtInfoTool(req('ZzzNoSuchEdt'), ctx(db));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it('answers from a plain scan when the index predates symbols_fts', async () => {
    const db = makeDb([{ name: 'AmountMST' }], FIELDS);
    db.exec('DROP TABLE symbols_fts');

    // The FTS pre-filter is an optimisation, not the source of truth — without it
    // the equality test alone must still produce the same answer.
    expect(await usageLines('AmountMST', db)).toHaveLength(3);
  });
});
