/**
 * EDT Extension Validator tests
 *
 * Covers the rules in src/utils/edtExtensionValidator.ts, with an emphasis
 * on the StringSize / DatabaseStringSize invariants that D365FO enforces:
 *   - StringSize / DisplayLength are inherited; only the root EDT may carry them.
 *   - StringSize must not exceed the effective DatabaseStringSize (unless -1).
 *   - DatabaseStringSize must not be lowered below the current StringSize.
 *   - Extends can never be set via AxEdtExtension.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  extractBaseEdtName,
  lookupBaseEdtFromIndex,
  resolveEdtChain,
  resolveEffectiveDatabaseStringSize,
  validateEdtExtensionProperty,
} from '../../src/utils/edtExtensionValidator';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE edt_metadata (
      edt_name TEXT PRIMARY KEY,
      model TEXT,
      base_type TEXT,
      extends TEXT,
      string_size TEXT,
      database_string_size TEXT
    );
  `);
  return db;
}

function insertEdt(db: any, row: {
  name: string;
  extends?: string | null;
  stringSize?: string | null;
  dbSize?: string | null;
  model?: string;
}) {
  db.prepare(`
    INSERT OR REPLACE INTO edt_metadata
      (edt_name, model, base_type, extends, string_size, database_string_size)
    VALUES (?, ?, 'String', ?, ?, ?)
  `).run(
    row.name,
    row.model ?? 'Test',
    row.extends ?? null,
    row.stringSize ?? null,
    row.dbSize ?? null,
  );
}

describe('extractBaseEdtName', () => {
  it('splits on dot convention', () => {
    expect(extractBaseEdtName('AccountNum.MyExt')).toBe('AccountNum');
  });

  it('splits on underscore Extension convention', () => {
    expect(extractBaseEdtName('AccountNum_ContosoExtension')).toBe('AccountNum');
  });

  it('returns input unchanged when no separator', () => {
    expect(extractBaseEdtName('MyEdt')).toBe('MyEdt');
  });

  it('does not split arbitrary underscores in EDT names', () => {
    expect(extractBaseEdtName('Sales_Order')).toBe('Sales_Order');
  });
});

describe('lookupBaseEdtFromIndex (DatabaseStringSize)', () => {
  let db: any;
  beforeEach(() => { db = makeDb(); });

  it('reads database_string_size column when present', () => {
    insertEdt(db, { name: 'Foo', stringSize: '20', dbSize: '60' });
    const info = lookupBaseEdtFromIndex(db, 'Foo');
    expect(info?.databaseStringSize).toBe('60');
  });

  it('preserves null database_string_size', () => {
    insertEdt(db, { name: 'Foo', stringSize: '20' });
    const info = lookupBaseEdtFromIndex(db, 'Foo');
    expect(info?.databaseStringSize).toBeNull();
  });

  it('falls back gracefully on legacy schema without the new column', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE edt_metadata (
        edt_name TEXT, model TEXT, extends TEXT, string_size TEXT
      );
      INSERT INTO edt_metadata VALUES ('Foo','Test',NULL,'10');
    `);
    const info = lookupBaseEdtFromIndex(legacy, 'Foo');
    expect(info?.edtName).toBe('Foo');
    expect(info?.stringSize).toBe('10');
    expect(info?.databaseStringSize).toBeUndefined();
  });
});

describe('resolveEffectiveDatabaseStringSize', () => {
  let db: any;
  beforeEach(() => {
    db = makeDb();
    // Chain: Leaf → Mid → Root
    insertEdt(db, { name: 'Root', stringSize: '20', dbSize: '60' });
    insertEdt(db, { name: 'Mid', extends: 'Root', stringSize: '15' });
    insertEdt(db, { name: 'Leaf', extends: 'Mid' });
  });

  it('returns local DatabaseStringSize when defined', () => {
    expect(resolveEffectiveDatabaseStringSize(db, 'Root')).toBe(60);
  });

  it('walks Extends chain to find inherited DatabaseStringSize', () => {
    expect(resolveEffectiveDatabaseStringSize(db, 'Leaf')).toBe(60);
  });

  it('returns -1 when chain says unlimited (memo)', () => {
    insertEdt(db, { name: 'BigText', dbSize: '-1' });
    insertEdt(db, { name: 'BigDerived', extends: 'BigText' });
    expect(resolveEffectiveDatabaseStringSize(db, 'BigDerived')).toBe(-1);
  });

  it('returns null when the chain has no DatabaseStringSize at all', () => {
    insertEdt(db, { name: 'A', stringSize: '10' });
    insertEdt(db, { name: 'B', extends: 'A' });
    expect(resolveEffectiveDatabaseStringSize(db, 'B')).toBeNull();
  });
});

describe('validateEdtExtensionProperty — Extends', () => {
  it('refuses changing Extends via extension', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'Foo', extends: null, stringSize: '10' },
      'Extends',
      'OtherEdt',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Extends/);
  });
});

describe('validateEdtExtensionProperty — StringSize on derived EDT', () => {
  it('refuses StringSize change when base has Extends', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'AccountNumDerived', extends: 'AccountNum', stringSize: '20' },
      'StringSize',
      '60',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/inherited/i);
  });

  it('also refuses DisplayLength on derived EDT', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'Foo', extends: 'Bar', stringSize: '10' },
      'DisplayLength',
      '40',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/inherited/i);
  });
});

describe('validateEdtExtensionProperty — StringSize on root EDT (extensibility)', () => {
  it('refuses when IsExtensible is explicitly false', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'RootEdt', extends: null, stringSize: '20', isExtensible: false },
      'StringSize',
      '60',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not extensible|IsExtensible/i);
  });

  it('refuses (fail-closed) when IsExtensible is unknown', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'RootEdt', extends: null, stringSize: '20', isExtensible: null },
      'StringSize',
      '60',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/verify|IsExtensible/i);
  });

  it('allows when IsExtensible is true and size grows', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'RootEdt', extends: null, stringSize: '20', isExtensible: true, databaseStringSize: '60' },
      'StringSize',
      '40',
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateEdtExtensionProperty — StringSize ≤ DatabaseStringSize invariant', () => {
  let db: any;
  beforeEach(() => {
    db = makeDb();
    insertEdt(db, { name: 'NarrowDb', stringSize: '20', dbSize: '30' });
    insertEdt(db, { name: 'Unlimited', stringSize: '20', dbSize: '-1' });
    insertEdt(db, { name: 'NoDbSize', stringSize: '20' });
  });

  it('refuses StringSize > local DatabaseStringSize', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'NarrowDb', extends: null, stringSize: '20', databaseStringSize: '30', isExtensible: true },
      'StringSize',
      '60',
      db,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/DatabaseStringSize/);
    expect(r.message).toMatch(/30/);
  });

  it('allows StringSize = DatabaseStringSize', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'NarrowDb', extends: null, stringSize: '20', databaseStringSize: '30', isExtensible: true },
      'StringSize',
      '30',
      db,
    );
    expect(r.ok).toBe(true);
  });

  it('allows any StringSize when DatabaseStringSize is -1 (unlimited)', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'Unlimited', extends: null, stringSize: '20', databaseStringSize: '-1', isExtensible: true },
      'StringSize',
      '4000',
      db,
    );
    expect(r.ok).toBe(true);
  });

  it('allows StringSize change when DatabaseStringSize is unknown', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'NoDbSize', extends: null, stringSize: '20', databaseStringSize: null, isExtensible: true },
      'StringSize',
      '4000',
      db,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses shrinking StringSize regardless of DatabaseStringSize', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'NarrowDb', extends: null, stringSize: '20', databaseStringSize: '30', isExtensible: true },
      'StringSize',
      '10',
      db,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/shrink/i);
  });
});

describe('validateEdtExtensionProperty — DatabaseStringSize on derived EDT', () => {
  it('refuses DatabaseStringSize change when base has Extends', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'Derived', extends: 'Root', stringSize: '20' },
      'DatabaseStringSize',
      '60',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/inherited/i);
  });
});

describe('validateEdtExtensionProperty — DatabaseStringSize ≥ StringSize invariant', () => {
  it('refuses lowering DatabaseStringSize below current StringSize', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'RootEdt', extends: null, stringSize: '40', databaseStringSize: '60', isExtensible: true },
      'DatabaseStringSize',
      '20',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/StringSize/);
  });

  it('allows lowering DatabaseStringSize when still ≥ StringSize', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'RootEdt', extends: null, stringSize: '20', databaseStringSize: '60', isExtensible: true },
      'DatabaseStringSize',
      '40',
    );
    expect(r.ok).toBe(true);
  });

  it('allows setting DatabaseStringSize to -1 (unlimited)', () => {
    const r = validateEdtExtensionProperty(
      { edtName: 'RootEdt', extends: null, stringSize: '40', databaseStringSize: '60', isExtensible: true },
      'DatabaseStringSize',
      '-1',
    );
    expect(r.ok).toBe(true);
  });
});

describe('resolveEdtChain', () => {
  it('walks the chain root-ward and stops at root', () => {
    const db = makeDb();
    insertEdt(db, { name: 'Root', stringSize: '20', dbSize: '60' });
    insertEdt(db, { name: 'Mid', extends: 'Root' });
    insertEdt(db, { name: 'Leaf', extends: 'Mid' });
    const chain = resolveEdtChain(db, 'Leaf');
    expect(chain.map(c => c.edtName)).toEqual(['Leaf', 'Mid', 'Root']);
  });

  it('terminates on cycles defensively', () => {
    const db = makeDb();
    insertEdt(db, { name: 'A', extends: 'B' });
    insertEdt(db, { name: 'B', extends: 'A' });
    const chain = resolveEdtChain(db, 'A');
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});
