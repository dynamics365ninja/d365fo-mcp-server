/**
 * Finding #14 (2026-07-21 golden-capture sweep, HIGH):
 *   `get_object_info(objectType="edt", name="Num"|"Notes"|"CustAccount")` all
 *   answered `EDT "X" not found. Bridge returned no data — ensure the EDT exists
 *   in D365FO metadata.` while the same EDTs resolved through
 *   validate_code(references) and appeared in search.
 *
 * Root cause: getEdtInfoTool's standard mode consulted ONE source (the C# bridge)
 * and translated "the bridge returned null" — which also means "bridge absent",
 * "bridge errored", "provider did not resolve the name" — into the factual claim
 * that the EDT does not exist. The tool held a fully populated `edt_metadata`
 * table the whole time (hierarchy mode reads it) and never looked.
 *
 * That is the worst failure mode in the loop: the agent "corrects" working code
 * away from a valid standard EDT.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from '../../src/database/sqlite.js';
import { getEdtInfoTool } from '../../src/tools/edtInfo';

function makeDb(rows: Array<{ name: string; extends?: string; stringSize?: string; model?: string }>) {
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
    `INSERT INTO edt_metadata (edt_name, extends, string_size, model) VALUES (?, ?, ?, ?)`,
  );
  const insSym = db.prepare(`INSERT INTO symbols (name, type, model) VALUES (?, 'edt', ?)`);
  const insFts = db.prepare(`INSERT INTO symbols_fts (rowid, name, type) VALUES (?, ?, 'edt')`);
  for (const r of rows) {
    insEdt.run(r.name, r.extends ?? null, r.stringSize ?? null, r.model ?? 'ApplicationPlatform');
    const info = insSym.run(r.name, r.model ?? 'ApplicationPlatform');
    insFts.run(info.lastInsertRowid, r.name);
  }
  return db;
}

/** Context whose bridge answers exactly like the VM did: nothing, for every EDT. */
function ctx(db: any) {
  return {
    symbolIndex: { getReadDb: () => db },
    bridge: { isReady: true, metadataAvailable: true, readEdt: vi.fn(async () => null) },
  } as any;
}

const req = (edtName: string) => ({
  method: 'tools/call' as const,
  params: { name: 'get_edt_info', arguments: { edtName } },
});

describe('get_edt_info — bridge returns no data (#14)', () => {
  it('answers from the SQLite index instead of denying that Num exists', async () => {
    const db = makeDb([{ name: 'Num', extends: 'str', stringSize: '20' }]);

    const result = await getEdtInfoTool(req('Num'), ctx(db));

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('Num');
    expect(text).toContain('SQLite symbol index');
    // The lie the finding is about must be gone.
    expect(text).not.toMatch(/not found/i);
  });

  it.each(['Notes', 'CustAccount'])('resolves the standard EDT %s from the index', async (name) => {
    const db = makeDb([{ name, extends: 'str' }]);
    const result = await getEdtInfoTool(req(name), ctx(db));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).toContain(name);
  });

  it('resolves a differently-cased name through the canonicalizing lookup', async () => {
    const db = makeDb([{ name: 'CustAccount', extends: 'str' }]);
    const result = await getEdtInfoTool(req('custaccount'), ctx(db));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).toContain('CustAccount');
  });

  it('falls back to the symbols row when edt_metadata has none, and says so', async () => {
    const db = makeDb([]);
    db.prepare(`INSERT INTO symbols (name, type, model) VALUES ('ConDemoId', 'edt', 'Contoso')`).run();
    db.prepare(`INSERT INTO symbols_fts (rowid, name, type) VALUES (1, 'ConDemoId', 'edt')`).run();

    const result = await getEdtInfoTool(req('ConDemoId'), ctx(db));

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('ConDemoId');
    expect(text).toContain('missing data, not an empty EDT');
  });

  it('when NOTHING knows the name, reports "no data" and refuses to claim non-existence', async () => {
    const db = makeDb([{ name: 'Num' }]);

    const result = await getEdtInfoTool(req('NoSuchEdtAnywhere'), ctx(db));

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('No data available');
    expect(text).toContain('NOT proof the EDT does not exist');
    // It must point at the sources that DID resolve these EDTs on the VM.
    expect(text).toContain('validate_code');
    expect(text).toContain('search(');
  });

  it('still prefers the bridge when the bridge has data', async () => {
    const db = makeDb([{ name: 'Num', extends: 'str' }]);
    const context = ctx(db);
    context.bridge.readEdt = vi.fn(async () => ({ name: 'Num', baseType: 'String', model: 'AppPlatform' }));

    const result = await getEdtInfoTool(req('Num'), context);

    expect(result.content[0].text as string).toContain('C# bridge');
  });
});
