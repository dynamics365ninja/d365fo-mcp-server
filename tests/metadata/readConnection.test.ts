/**
 * The read side of the symbol index: one read-only connection by default.
 *
 * The driver is synchronous and tools run on the main thread, so there is one
 * read in flight at a time. Three round-robin connections gave no concurrency,
 * only three small page caches for the same work, and a pool of labels
 * connections was opened beside them that nothing ever read from.
 *
 * File-backed: a `:memory:` index has no read connection at all (getReadDb()
 * returns the writer), so none of this is observable there.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  XppSymbolIndex,
  DEFAULT_READ_POOL_SIZE,
  READ_CACHE_BUDGET_KIB,
  readPoolSizeFromEnv,
  readCacheKibPerConnection,
} from '../../src/metadata/symbolIndex';

const dirs: string[] = [];
const opened: XppSymbolIndex[] = [];
let savedPoolSize: string | undefined;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-read-connection-'));
  dirs.push(dir);
  return dir;
}

function openIn(dir: string): XppSymbolIndex {
  const idx = new XppSymbolIndex(path.join(dir, 'symbols.db'), path.join(dir, 'labels.db'));
  opened.push(idx);
  return idx;
}

beforeEach(() => {
  savedPoolSize = process.env.READ_POOL_SIZE;
  delete process.env.READ_POOL_SIZE;
});

afterEach(() => {
  if (savedPoolSize === undefined) delete process.env.READ_POOL_SIZE;
  else process.env.READ_POOL_SIZE = savedPoolSize;
  for (const idx of opened) { try { idx.close(); } catch { /* already closed */ } }
  opened.length = 0;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

const pool = (idx: XppSymbolIndex): any[] => (idx as any).readPool;
const cacheSize = (db: any): number => db.pragma('cache_size', { simple: true }) as number;
const countSymbols = (db: any): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;

const addClass = (idx: XppSymbolIndex, name: string) =>
  idx.addSymbol({
    name, type: 'class', filePath: `K:\\ContosoExt\\AxClass\\${name}.xml`, model: 'ContosoExt',
  } as any);

describe('read connection — default', () => {
  it('opens exactly one, separate from the writer, with the whole cache budget', () => {
    const idx = openIn(tempDir());

    expect(DEFAULT_READ_POOL_SIZE).toBe(1);
    expect(pool(idx)).toHaveLength(1);
    const rdb = idx.getReadDb();
    expect(rdb).not.toBe(idx.db);
    expect(idx.getReadDb()).toBe(rdb); // every read lands on the same warm cache
    expect(cacheSize(rdb)).toBe(-READ_CACHE_BUDGET_KIB);
    expect(READ_CACHE_BUDGET_KIB).toBe(128_000);
  });

  it('is read-only', () => {
    const idx = openIn(tempDir());

    expect(() => idx.getReadDb().exec("DELETE FROM symbols WHERE name = 'x'")).toThrow(/readonly|read-only/i);
  });

  it('opens no labels read connections, and label reads still work', () => {
    const idx = openIn(tempDir());

    expect((idx as any).labelsReadPool).toBeUndefined();
    idx.addLabel({
      labelId: 'ContosoRentEquipment', labelFileId: 'ContosoExt', model: 'ContosoExt',
      language: 'en-US', text: 'Rental equipment', filePath: 'K:\\ContosoExt\\AxLabelFile\\ContosoExt.en-US.label.txt',
    } as any);
    expect(idx.searchLabels('Rental', 'en-US').map((l: any) => l.labelId)).toContain('ContosoRentEquipment');
  });

  it('has no read connection on :memory:, where the writer serves reads', () => {
    const idx = new XppSymbolIndex(':memory:', ':memory:');
    opened.push(idx);

    expect(pool(idx)).toHaveLength(0);
    expect(idx.getReadDb()).toBe(idx.db);
  });
});

describe('read connection — READ_POOL_SIZE override', () => {
  it('opens N, hands them out in turn, and splits the budget instead of multiplying it', () => {
    process.env.READ_POOL_SIZE = '3';
    const idx = openIn(tempDir());

    expect(pool(idx)).toHaveLength(3);
    const [a, b, c, again] = [idx.getReadDb(), idx.getReadDb(), idx.getReadDb(), idx.getReadDb()];
    expect(new Set([a, b, c]).size).toBe(3);
    expect(again).toBe(a);
    for (const conn of [a, b, c]) {
      expect(conn).not.toBe(idx.db);
      expect(cacheSize(conn)).toBe(-Math.floor(READ_CACHE_BUDGET_KIB / 3));
    }
  });

  it('never gives a connection less than the 32 MB it had before', () => {
    expect(readCacheKibPerConnection(1)).toBe(READ_CACHE_BUDGET_KIB);
    expect(readCacheKibPerConnection(2)).toBe(64_000);
    expect(readCacheKibPerConnection(4)).toBe(32_000);
    expect(readCacheKibPerConnection(8)).toBe(32_000);
  });

  it('clamps to 1-8 and falls back to the default on anything that is not a count', () => {
    expect(readPoolSizeFromEnv({})).toBe(1);
    expect(readPoolSizeFromEnv({ READ_POOL_SIZE: '' })).toBe(1);
    expect(readPoolSizeFromEnv({ READ_POOL_SIZE: 'many' })).toBe(1);
    expect(readPoolSizeFromEnv({ READ_POOL_SIZE: '0' })).toBe(1);
    expect(readPoolSizeFromEnv({ READ_POOL_SIZE: '-2' })).toBe(1);
    expect(readPoolSizeFromEnv({ READ_POOL_SIZE: '2' })).toBe(2);
    expect(readPoolSizeFromEnv({ READ_POOL_SIZE: '99' })).toBe(8);

    process.env.READ_POOL_SIZE = '99';
    expect(pool(openIn(tempDir()))).toHaveLength(8);
  });
});

describe('read connection — snapshot and lifetime', () => {
  it('reads committed data while the writer holds an open transaction, and sees the commit after', () => {
    const idx = openIn(tempDir());
    addClass(idx, 'ContosoRentCommitted');
    const rdb = idx.getReadDb();
    expect(countSymbols(rdb)).toBe(1);

    idx.db.exec('BEGIN IMMEDIATE');
    try {
      addClass(idx, 'ContosoRentPending');
      // The writer sees its own row. The reader is neither blocked nor shown it.
      expect(countSymbols(idx.db)).toBe(2);
      expect(countSymbols(rdb)).toBe(1);
      expect(rdb.prepare("SELECT name FROM symbols WHERE name = 'ContosoRentPending'").get()).toBeUndefined();
      idx.db.exec('COMMIT');
    } catch (e) {
      idx.db.exec('ROLLBACK');
      throw e;
    }

    expect(countSymbols(rdb)).toBe(2);
  });

  it('closeReadPool closes the read connection and reads fall back to the writer', () => {
    const idx = openIn(tempDir());
    addClass(idx, 'ContosoRentCommitted');
    const rdb = idx.getReadDb();

    idx.closeReadPool();

    expect(pool(idx)).toHaveLength(0);
    expect(() => rdb.prepare('SELECT 1').get()).toThrow();
    expect(idx.getReadDb()).toBe(idx.db);
    expect(countSymbols(idx.getReadDb())).toBe(1);
    // With no other connection left the writer can take the file exclusively,
    // which is what the build scripts close the pool for.
    idx.db.pragma('journal_mode = MEMORY');
    idx.db.pragma('locking_mode = EXCLUSIVE');
    expect(() => addClass(idx, 'ContosoRentExclusive')).not.toThrow();
  });

  it('close() closes every connection, so the files can be removed', () => {
    process.env.READ_POOL_SIZE = '2';
    const dir = tempDir();
    const idx = openIn(dir);
    addClass(idx, 'ContosoRentCommitted');
    const readers = [...pool(idx)];
    const writer = idx.db;
    const labels = idx.labelsDb;

    idx.close();

    for (const conn of [...readers, writer, labels]) {
      expect(() => conn.prepare('SELECT 1').get()).toThrow();
    }
    // An open handle keeps the file locked on Windows, so this is the proof
    // that nothing was left open. No try/catch on purpose.
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
});
