/**
 * symbolLookup — index-safe case-insensitive lookups against a REAL in-memory
 * symbol index (production schema incl. symbols_fts). Locks the exact-probe +
 * FTS-fallback shape extracted from prepare (d93f004): the former
 * `name = ? COLLATE NOCASE` queries full-scanned the 1.17M-row symbols table
 * (13–180 s cold) and got the MCP server killed by clients.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  lookupSymbolNocase,
  lookupSymbolsNocase,
  lookupChildSymbolsNocase,
  canonicalSymbolName,
  distinctSymbolTypesNocase,
} from '../../src/utils/symbolLookup';

let index: XppSymbolIndex;
let db: any;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, type: string, parentName?: string) =>
    index.addSymbol({ name, type, parentName, filePath: '/x.xml', model: 'Test' } as any);

  sym('CustTable', 'table');
  sym('CustTable', 'form');            // cross-type name collision (real in AOT)
  sym('AccountNum', 'field', 'CustTable');
  sym('validateWrite', 'method', 'CustTable');
  sym('SalesStatus', 'enum');
  sym('CustAccount', 'edt');
  // An EXTENSION row: its `parent_name` is the object it extends, so it is NOT a
  // top-level row and every helper above is blind to it by design (#995).
  sym('NumberSeqModule', 'enum');
  sym('NumberSeqModule.Kitting', 'enum-extension', 'NumberSeqModule');
  db = index.getReadDb();
});

afterAll(() => index.close());

describe('lookupSymbolNocase', () => {
  it('finds an exact-case top-level object (index probe, no FTS)', () => {
    const hit = lookupSymbolNocase(db, 'CustTable', ['table']);
    expect(hit).toMatchObject({ name: 'CustTable', type: 'table', model: 'Test' });
  });

  it('resolves canonical casing for differently-cased input (FTS fallback)', () => {
    expect(lookupSymbolNocase(db, 'custtable', ['table'])?.name).toBe('CustTable');
    expect(lookupSymbolNocase(db, 'CUSTTABLE', ['table'])?.name).toBe('CustTable');
    expect(lookupSymbolNocase(db, 'salesstatus', ['enum', 'enum-extension'])?.name).toBe('SalesStatus');
  });

  it('respects the type filter', () => {
    expect(lookupSymbolNocase(db, 'custtable', ['enum'])).toBeUndefined();
    expect(lookupSymbolNocase(db, 'custaccount', ['edt'])?.name).toBe('CustAccount');
  });

  it('does not match non-top-level symbols (fields, methods)', () => {
    expect(lookupSymbolNocase(db, 'accountnum')).toBeUndefined();
    expect(lookupSymbolNocase(db, 'validatewrite')).toBeUndefined();
  });

  it('returns undefined for unknown names', () => {
    expect(lookupSymbolNocase(db, 'NoSuchObject123')).toBeUndefined();
    expect(lookupSymbolNocase(db, '')).toBeUndefined();
  });
});

describe('lookupSymbolsNocase', () => {
  it('returns all top-level rows for a name across types, deduplicated', () => {
    const rows = lookupSymbolsNocase(db, 'custtable', { limit: 5 });
    expect(rows.map(r => r.type).sort()).toEqual(['form', 'table']);
  });
});

describe('canonicalSymbolName', () => {
  it('canonicalizes casing so parent_name probes can stay BINARY', () => {
    expect(canonicalSymbolName(db, 'cUsTtAbLe')).toBe('CustTable');
    expect(canonicalSymbolName(db, 'Missing')).toBeUndefined();
  });
});

describe('distinctSymbolTypesNocase', () => {
  it('includes child-symbol types (methods, fields), any casing', () => {
    expect(distinctSymbolTypesNocase(db, 'validatewrite')).toEqual(['method']);
    expect(distinctSymbolTypesNocase(db, 'AccountNum')).toEqual(['field']);
  });

  it('unions types across casings of a top-level name', () => {
    expect(distinctSymbolTypesNocase(db, 'CUSTTABLE').sort()).toEqual(['form', 'table']);
  });

  it('returns [] for unknown names', () => {
    expect(distinctSymbolTypesNocase(db, 'NoSuchObject123')).toEqual([]);
  });
});

/**
 * `lookupChildSymbolsNocase` — the rows the helpers above deliberately cannot see.
 *
 * Extension rows do not carry `parent_name IS NULL`; they record the object they
 * EXTEND there. So `prepare`'s collision check cleared `NumberSeqModule.Kitting`
 * — an enum-extension sitting in the index — as "no collision", immediately
 * before a write (#995).
 *
 * The index-safety contract is the same one this whole module exists for: the
 * exact-case probe must ride idx_name_type. Written first as
 * `name = ? COLLATE NOCASE AND parent_name IS NOT NULL`, it could not use that
 * BINARY index and scanned it — 60 SECONDS measured on a production-size DB,
 * which node:sqlite spends blocking the event loop.
 */
describe('lookupChildSymbolsNocase', () => {
  it('finds an extension row that the top-level helpers cannot', () => {
    expect(lookupSymbolNocase(db, 'NumberSeqModule.Kitting')).toBeUndefined();
    const hits = lookupChildSymbolsNocase(db, 'NumberSeqModule.Kitting');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: 'NumberSeqModule.Kitting', type: 'enum-extension' });
  });

  it('matches differently-cased input through the FTS fallback', () => {
    const hits = lookupChildSymbolsNocase(db, 'numberseqmodule.kitting');
    expect(hits.map(h => h.name)).toEqual(['NumberSeqModule.Kitting']);
  });

  it('never returns a top-level row — that is the other helper\'s job', () => {
    expect(lookupChildSymbolsNocase(db, 'CustTable')).toEqual([]);
    expect(lookupChildSymbolsNocase(db, 'NumberSeqModule')).toEqual([]);
  });

  it('returns nothing for an empty name rather than scanning', () => {
    expect(lookupChildSymbolsNocase(db, '')).toEqual([]);
  });

  it('keeps the extension-sibling query on idx_type_parent (prepare #995)', () => {
    // `parent_name = ? COLLATE NOCASE` drops the planner to `(type=?)` and then
    // walks every extension row of that type. Canonicalize the base once, stay
    // BINARY — the rule this module's header states.
    const binary = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT name FROM symbols INDEXED BY idx_type_parent
       WHERE type = ? AND parent_name = ? LIMIT 6`,
    ).all('enum-extension', 'NumberSeqModule') as Array<{ detail: string }>;
    expect(binary.map(r => r.detail).join(' ')).toMatch(/parent_name=\?/);

    const nocase = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT name FROM symbols INDEXED BY idx_type_parent
       WHERE type = ? AND parent_name = ? COLLATE NOCASE LIMIT 6`,
    ).all('enum-extension', 'NumberSeqModule') as Array<{ detail: string }>;
    // Proof the COLLATE really is what costs the seek, not a guess about it.
    expect(nocase.map(r => r.detail).join(' ')).not.toMatch(/parent_name=\?/);
  });

  it('keeps the exact-case probe on idx_name_type (the 60-second regression)', () => {
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT s.name FROM symbols s INDEXED BY idx_name_type
       WHERE s.name = ? AND s.parent_name IS NOT NULL LIMIT 3`,
    ).all('NumberSeqModule.Kitting') as Array<{ detail: string }>;
    const detail = plan.map(r => r.detail).join(' ');
    // SEARCH = index seek. SCAN would be the 60-second shape.
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/SCAN/);
  });
});
