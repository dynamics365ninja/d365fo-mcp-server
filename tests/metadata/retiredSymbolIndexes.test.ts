/**
 * Three indexes on `symbols` that no query needs are no longer built, and are
 * dropped from a database that still has them.
 *
 *   idx_symbols_file_path     BINARY, while every comparison of file_path is NOCASE
 *   idx_parent_type           a strict prefix of idx_parent_type_name
 *   idx_symbols_pattern_type  nothing filters on symbols.pattern_type
 *
 * Removing an index is only safe if the queries that could have used it still
 * plan on another one, so the plans are the assertions here. The SQL is taken
 * from what the methods really prepare, not from a copy that could drift.
 *
 * File-backed: a `:memory:` index builds every deferred index inline and has no
 * "existing database" to migrate, which are the two things under test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex, type XppSymbolIndexOptions } from '../../src/metadata/symbolIndex';
import { INDEXED_ROW_NAME_SQL } from '../../src/tools/sdlc/updateSymbolIndex';

const RETIRED = ['idx_symbols_file_path', 'idx_parent_type', 'idx_symbols_pattern_type'];
const OLD_DDL = [
  'CREATE INDEX idx_symbols_file_path ON symbols(file_path)',
  'CREATE INDEX idx_parent_type ON symbols(parent_name, type) WHERE parent_name IS NOT NULL',
  'CREATE INDEX idx_symbols_pattern_type ON symbols(pattern_type)',
];

const dirs: string[] = [];
const opened: XppSymbolIndex[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-retired-indexes-'));
  dirs.push(dir);
  return dir;
}

function openIn(dir: string, options: XppSymbolIndexOptions = {}): XppSymbolIndex {
  const idx = new XppSymbolIndex(path.join(dir, 'symbols.db'), path.join(dir, 'labels.db'), options);
  opened.push(idx);
  return idx;
}

afterEach(() => {
  for (const idx of opened) { try { idx.close(); } catch { /* already closed */ } }
  opened.length = 0;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

const hasIndex = (db: any, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);

const FILE = 'K:\\ContosoExt\\AxClass\\ContosoRentEquipmentService.xml';

/** Enough rows that the planner has a real choice between a seek and a scan. */
function seed(idx: XppSymbolIndex): void {
  idx.db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const owner = `ContosoRentFiller${i}`;
      const filePath = `K:\\ContosoExt\\AxClass\\${owner}.xml`;
      idx.addSymbol({ name: owner, type: 'class', filePath, model: 'ContosoExt' } as any);
      for (const m of ['run', 'validate', 'init']) {
        idx.addSymbol({ name: m, type: 'method', parentName: owner, filePath, model: 'ContosoExt' } as any);
      }
    }
    idx.addSymbol({ name: 'ContosoRentEquipmentService', type: 'class', filePath: FILE, model: 'ContosoExt' } as any);
    idx.addSymbol({ name: 'calcRent', type: 'method', parentName: 'ContosoRentEquipmentService', filePath: FILE, model: 'ContosoExt' } as any);
    idx.addSymbol({ name: 'ContosoRentEquipmentTable', type: 'table', filePath: 'K:\\ContosoExt\\AxTable\\ContosoRentEquipmentTable.xml', model: 'ContosoExt' } as any);
    idx.addSymbol({ name: 'EquipmentId', type: 'field', parentName: 'ContosoRentEquipmentTable', filePath: 'K:\\ContosoExt\\AxTable\\ContosoRentEquipmentTable.xml', model: 'ContosoExt' } as any);
  })();
}

/** The SQL a method prepares on the writer connection while `fn` runs. */
function preparedBy(idx: XppSymbolIndex, fn: () => void): string[] {
  const db = idx.db as any;
  const original = db.prepare;
  const seen: string[] = [];
  db.prepare = function (sql: string) {
    seen.push(sql);
    return original.call(db, sql);
  };
  try { fn(); } finally { db.prepare = original; }
  return seen;
}

function planOf(db: any, sql: string, ...params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map(r => r.detail).join(' | ');
}

/** No step of the plan may read the whole symbols table. */
const expectNoTableScan = (plan: string) => expect(plan).not.toMatch(/SCAN symbols(?! USING)/);

describe('retired symbols indexes', () => {
  it('are not created on a fresh database', () => {
    const idx = openIn(tempDir());

    for (const name of RETIRED) expect(hasIndex(idx.db, name), name).toBe(false);
    expect([...XppSymbolIndex.RETIRED_SYMBOL_INDEXES].sort()).toEqual([...RETIRED].sort());
    // The ones that carry the real lookups, and the ones plans are pinned to by name.
    for (const name of [
      'idx_symbols_file_path_nocase', 'idx_parent_type_name', 'idx_type_parent',
      'idx_symbols_name', 'idx_symbols_type', 'idx_symbols_model',
    ]) {
      expect(hasIndex(idx.db, name), name).toBe(true);
    }
  });

  it('are dropped from an existing database on the next open, and nothing else is', () => {
    const dir = tempDir();
    const first = openIn(dir);
    seed(first);
    for (const ddl of OLD_DDL) first.db.exec(ddl);
    for (const name of RETIRED) expect(hasIndex(first.db, name), name).toBe(true);
    const others = (first.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols' ORDER BY name")
      .all() as Array<{ name: string }>).map(r => r.name).filter(n => !RETIRED.includes(n));
    first.close();

    const reopened = openIn(dir);

    for (const name of RETIRED) expect(hasIndex(reopened.db, name), name).toBe(false);
    const after = (reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols' ORDER BY name")
      .all() as Array<{ name: string }>).map(r => r.name);
    expect(after).toEqual(others);
    // The data is untouched and still reachable through the read connection.
    expect(reopened.getClassMethods('ContosoRentEquipmentService').map(m => m.name)).toEqual(['calcRent']);
    expect(reopened.getReadDb().prepare('SELECT COUNT(*) AS n FROM symbols').get()).toEqual({ n: 1604 });
  });

  it('leaves the drop to a worker on a large database instead of blocking the open', () => {
    const dir = tempDir();
    const first = openIn(dir);
    for (const ddl of OLD_DDL) first.db.exec(ddl);
    first.close();

    // Threshold 0 makes this database "large". DROP INDEX walks every page of the
    // index, so on the main thread it would be part of startup.
    const reopened = openIn(dir, { largeDbThresholdBytes: 0 });

    for (const name of RETIRED) expect(hasIndex(reopened.db, name), name).toBe(true);
    expect(reopened.hasPendingIndexBuilds()).toBe(true);
  });

  it('drops them inline for a build script (no worker, deferred until asked)', () => {
    const dir = tempDir();
    const first = openIn(dir);
    for (const ddl of OLD_DDL) first.db.exec(ddl);
    first.close();

    const build = openIn(dir, { largeDbThresholdBytes: 0, backgroundIndexBuilds: false, deferFilePathIndexes: true });
    for (const name of RETIRED) expect(hasIndex(build.db, name), name).toBe(true);

    build.ensureDeferredIndexes();

    for (const name of RETIRED) expect(hasIndex(build.db, name), name).toBe(false);
    expect(build.hasPendingIndexBuilds()).toBe(false);
  });
});

describe('the queries those indexes could have served still use an index', () => {
  for (const analyzed of [false, true]) {
    const label = analyzed ? 'with ANALYZE statistics' : 'without statistics';

    it(`getClassMethods, getTableFields and getCompletions seek idx_parent_type_name (${label})`, () => {
      const idx = openIn(tempDir());
      seed(idx);
      if (analyzed) idx.db.exec('ANALYZE');

      const sqls = [
        ...preparedBy(idx, () => idx.getClassMethods('ContosoRentEquipmentService')),
        ...preparedBy(idx, () => idx.getTableFields('ContosoRentEquipmentTable')),
        ...preparedBy(idx, () => idx.getCompletions('ContosoRentEquipmentService')),
      ];
      expect(sqls).toHaveLength(3);

      for (const sql of sqls) {
        const plan = planOf(idx.db, sql, 'ContosoRentEquipmentService');
        expect(plan, sql).toContain('idx_parent_type_name');
        expectNoTableScan(plan);
      }
      expect(idx.getClassMethods('ContosoRentEquipmentService').map(m => m.name)).toEqual(['calcRent']);
      expect(idx.getTableFields('ContosoRentEquipmentTable').map(f => f.name)).toEqual(['EquipmentId']);
      expect(idx.getCompletions('ContosoRentEquipmentService').map(c => c.label)).toEqual(['calcRent']);
    });

    it(`the update_symbol_index row lookup seeks the NOCASE file_path index (${label})`, () => {
      const idx = openIn(tempDir());
      seed(idx);
      if (analyzed) idx.db.exec('ANALYZE');

      const plan = planOf(idx.db, INDEXED_ROW_NAME_SQL, FILE, 'class');

      expect(plan).toContain('idx_symbols_file_path_nocase');
      expectNoTableScan(plan);
    });
  }

  it('the row lookup finds the object whatever the letter case of the path, and only for that type', () => {
    const idx = openIn(tempDir());
    seed(idx);
    const get = (file: string, type: string) =>
      idx.db.prepare(INDEXED_ROW_NAME_SQL).get(file, type) as { name?: string } | undefined;

    expect(get(FILE, 'class')?.name).toBe('ContosoRentEquipmentService');
    expect(get(FILE.toLowerCase(), 'class')?.name).toBe('ContosoRentEquipmentService');
    // The method row of the same file has a parent, and no table lives in that file.
    expect(get(FILE, 'method')).toBeUndefined();
    expect(get(FILE, 'table')).toBeUndefined();
    expect(get('K:\\ContosoExt\\AxClass\\NoSuchFile.xml', 'class')).toBeUndefined();
  });

  it('a BINARY comparison of file_path, which nothing issues any more, would scan', () => {
    // The negative: this is the shape the retired index served. It is pinned so
    // that anyone adding such a query sees why it must be COLLATE NOCASE.
    const idx = openIn(tempDir());
    seed(idx);
    idx.db.exec('ANALYZE');

    const plan = planOf(idx.db, 'SELECT name FROM symbols WHERE file_path = ?', FILE);

    expect(plan).not.toContain('idx_symbols_file_path');
  });

  it('removeSymbolsByFile still deletes by index', () => {
    const idx = openIn(tempDir());
    seed(idx);
    idx.db.exec('ANALYZE');

    const plan = planOf(idx.db, 'DELETE FROM symbols WHERE file_path COLLATE NOCASE IN (?, ?)', FILE, FILE);
    expect(plan).toContain('idx_symbols_file_path_nocase');
    expectNoTableScan(plan);

    expect(idx.removeSymbolsByFile(FILE.toUpperCase()).deletedCount).toBe(2);
  });
});
