/**
 * Method bodies served from the symbol index.
 *
 * The readers resolved a body bridge-first, then by parsing the object's XML
 * off disk — both Windows-VM facilities — so an Azure read-only deployment
 * could never return one, while `symbols.source` held it the whole time
 * (620,851 method rows, 100% populated, on a production-size index). These
 * cover the helper and the "database has it, nothing else can reach it" path.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  readIndexedMethodSource,
  readIndexedMethodSources,
  obsoleteWarning,
} from '../../src/utils/indexedMethodSource';

const BODY = 'static CustTable find(CustAccount _custAccount)\n{\n    CustTable custTable;\n    return custTable;\n}';

/** A db whose prepare() returns fixed rows, capturing the SQL it was handed. */
function fakeDb(rows: any[], captured: string[] = []) {
  return {
    sql: captured,
    prepare(sql: string) {
      captured.push(sql);
      return {
        get: () => rows[0],
        all: () => rows,
      };
    },
  };
}

describe('readIndexedMethodSource', () => {
  it('returns the stored body, and the AOT spelling rather than the caller casing', () => {
    const db = fakeDb([{ name: 'find', source: BODY, signature: 'static CustTable find()', model: 'Foundation' }]);

    const hit = readIndexedMethodSource(db as any, 'CustTable', 'FIND');

    expect(hit).not.toBeNull();
    expect(hit!.name).toBe('find');
    expect(hit!.source).toBe(BODY);
    expect(hit!.model).toBe('Foundation');
  });

  it('stays on idx_parent_type_name — no NOCASE compare on parent_name', () => {
    const captured: string[] = [];
    const db = fakeDb([{ name: 'find', source: BODY, signature: null, model: null }], captured);

    readIndexedMethodSource(db as any, 'CustTable', 'find');

    const sql = captured.join(' ').replace(/\s+/g, ' ');
    expect(sql).toContain("parent_name = ?");
    expect(sql).toContain("type = 'method'");
    expect(sql).toContain('name = ? COLLATE NOCASE');
    // A NOCASE compare on the parent would scan every method row (620k+).
    expect(sql).not.toMatch(/parent_name\s*=\s*\?\s*COLLATE/i);
  });

  it('treats a NULL source as "not indexed", not as an empty method', () => {
    const db = fakeDb([{ name: 'find', source: null, signature: 'x', model: 'm' }]);
    expect(readIndexedMethodSource(db as any, 'CustTable', 'find')).toBeNull();
  });

  it('treats an empty-string source the same way', () => {
    const db = fakeDb([{ name: 'find', source: '', signature: 'x', model: 'm' }]);
    expect(readIndexedMethodSource(db as any, 'CustTable', 'find')).toBeNull();
  });

  it('returns null for a missing row', () => {
    expect(readIndexedMethodSource(fakeDb([]) as any, 'CustTable', 'nope')).toBeNull();
  });

  it('returns null rather than throwing when the DB is unavailable', () => {
    const db = { prepare: () => { throw new Error('database is locked'); } };
    expect(readIndexedMethodSource(db as any, 'CustTable', 'find')).toBeNull();
  });
});

describe('readIndexedMethodSources', () => {
  it('keys every populated body by lowercased name', () => {
    const db = fakeDb([
      { name: 'find', source: BODY, signature: null, model: null },
      { name: 'InitValue', source: 'public void initValue() {}', signature: null, model: null },
    ]);

    const map = readIndexedMethodSources(db as any, 'CustTable');

    expect(map.size).toBe(2);
    expect(map.get('find')!.source).toBe(BODY);
    // Keyed lowercase, but the AOT spelling is preserved in the value.
    expect(map.get('initvalue')!.name).toBe('InitValue');
  });

  it('skips rows with no body instead of yielding blank code fences', () => {
    const db = fakeDb([
      { name: 'find', source: BODY, signature: null, model: null },
      { name: 'ghost', source: null, signature: null, model: null },
    ]);

    const map = readIndexedMethodSources(db as any, 'CustTable');

    expect(map.size).toBe(1);
    expect(map.has('ghost')).toBe(false);
  });

  it('returns an empty map when the DB throws', () => {
    const db = { prepare: () => { throw new Error('no such table: symbols'); } };
    expect(readIndexedMethodSources(db as any, 'CustTable').size).toBe(0);
  });
});

describe('obsoleteWarning', () => {
  it('reports a SysObsolete attribute and carries its replacement hint', () => {
    const w = obsoleteWarning('[SysObsolete("Use newMethod instead", false)]\npublic void old() {}');
    expect(w).toContain('marked obsolete');
    expect(w).toContain('Use newMethod instead');
  });

  it('reports a plain Obsolete attribute too', () => {
    expect(obsoleteWarning('[Obsolete("gone")]\nvoid x() {}')).toContain('gone');
  });

  it('is empty for an ordinary method', () => {
    expect(obsoleteWarning(BODY)).toBe('');
  });
});
