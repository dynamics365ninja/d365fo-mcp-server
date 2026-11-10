/**
 * find_references, name-based fallback: "which classes implement X".
 *
 * The lookup is `implements_interfaces LIKE '%X%'`, which cannot seek, and LIMIT
 * only ends a scan once enough rows matched. For a class — which nothing
 * implements — that meant reading every class row of the index on every
 * class-typed call that reached the fallback. The partial index
 * idx_symbols_implements holds only the rows that implement something, and the
 * query now names it. On a database where it is not built yet the lookup falls
 * back to the statement it used before.
 *
 * File-backed on purpose: a `:memory:` index has no read connection of its own
 * and never takes the background-build path, so it cannot show either the plan
 * on the connection tools really read through or the "index not built yet" state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex, type XppSymbolIndexOptions } from '../../src/metadata/symbolIndex';
import {
  CLASS_IMPLEMENTS_SQL,
  CLASS_IMPLEMENTS_SQL_NO_INDEX,
  findReferencesTool,
} from '../../src/tools/analysis/findReferences';

const dirs: string[] = [];
const opened: XppSymbolIndex[] = [];

function tempIndex(options: XppSymbolIndexOptions = {}): XppSymbolIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-implements-index-'));
  dirs.push(dir);
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

/** 240 classes, one in six implementing something — the proportion of a real index. */
function seed(idx: XppSymbolIndex): void {
  for (let i = 0; i < 240; i++) {
    const name = `ContosoRentClass${i}`;
    idx.addSymbol({
      name,
      type: 'class',
      filePath: `K:\\ContosoExt\\AxClass\\${name}.xml`,
      model: 'ContosoExt',
      implementsInterfaces:
        i === 6 ? 'ContosoRentIPriced, ContosoRentIAudited'
        : i % 6 === 0 ? 'ContosoRentIAudited'
        : undefined,
    } as any);
  }
  idx.addSymbol({
    name: 'ContosoRentIPriced', type: 'interface',
    filePath: 'K:\\ContosoExt\\AxClass\\ContosoRentIPriced.xml', model: 'ContosoExt',
  } as any);
}

const planOf = (db: any): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${CLASS_IMPLEMENTS_SQL}`).all('%ContosoRentIPriced%', 50) as any[])
    .map(r => r.detail).join(' | ');

const run = async (idx: XppSymbolIndex, args: Record<string, unknown>): Promise<string> =>
  (await findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: idx } as any,
  )).content[0].text as string;

describe('find_references fallback — implemented interfaces are indexed', () => {
  it('stores "implements nothing" as NULL, which is what the partial index keys on', () => {
    const idx = tempIndex();
    seed(idx);

    const empties = idx.db
      .prepare("SELECT COUNT(*) AS n FROM symbols WHERE type = 'class' AND implements_interfaces = ''")
      .get() as { n: number };
    const nulls = idx.db
      .prepare("SELECT COUNT(*) AS n FROM symbols WHERE type = 'class' AND implements_interfaces IS NULL")
      .get() as { n: number };

    expect(empties.n).toBe(0);
    expect(nulls.n).toBe(200);
  });

  it('plans the lookup on idx_symbols_implements, on the connection tools read through', () => {
    const idx = tempIndex();
    seed(idx);
    expect(hasIndex(idx.db, 'idx_symbols_implements')).toBe(true);

    const rdb = idx.getReadDb();
    expect(rdb).not.toBe(idx.db); // file-backed: a real read connection, not the writer
    const plan = planOf(rdb);

    expect(plan).toContain('idx_symbols_implements');
    expect(plan).not.toMatch(/SCAN symbols(?! USING)/);
  });

  it('keeps that plan once ANALYZE statistics exist, as on a pre-built database', () => {
    const idx = tempIndex();
    seed(idx);
    idx.db.exec('ANALYZE');
    const dbFile = (idx as any).dbPath as string;
    const labelsFile = (idx as any).labelsDbPath as string;
    idx.close();

    // A fresh open, so the read connection loads the statistics with the schema.
    const reopened = new XppSymbolIndex(dbFile, labelsFile, {});
    opened.push(reopened);

    expect(planOf(reopened.getReadDb())).toContain('idx_symbols_implements');
  });

  it('finds the implementers of an interface, and none for a class nobody implements', async () => {
    const idx = tempIndex();
    seed(idx);

    const hit = await run(idx, { targetName: 'ContosoRentIPriced', targetType: 'class' });
    expect(hit).toContain('**implements**: 1 reference(s)');
    expect(hit).toContain('**Caller:** ContosoRentClass6');
    expect(hit).not.toContain('**Caller:** ContosoRentClass12');

    const miss = await run(idx, { targetName: 'ContosoRentClass7', targetType: 'class' });
    expect(miss).not.toContain('**implements**');
  });

  it('answers the same before the index exists (an existing database, build still pending)', async () => {
    // The state of a user's first start after upgrading: the build is deferred and
    // the index is not there yet. The indexed statement cannot even be prepared,
    // so the tool has to fall back to the one it ran before, not fail or go empty.
    const idx = tempIndex({ backgroundIndexBuilds: false, deferFilePathIndexes: true });
    seed(idx);
    expect(hasIndex(idx.db, 'idx_symbols_implements')).toBe(false);

    const rdb = idx.getReadDb();
    expect(() => rdb.prepare(CLASS_IMPLEMENTS_SQL)).toThrow(/no such index/i);
    const fallbackPlan = (rdb.prepare(`EXPLAIN QUERY PLAN ${CLASS_IMPLEMENTS_SQL_NO_INDEX}`)
      .all('%ContosoRentIPriced%', 50) as any[]).map(r => r.detail).join(' | ');
    expect(fallbackPlan).toContain('idx_type_name'); // the old plan, not a table scan

    const before = await run(idx, { targetName: 'ContosoRentIPriced', targetType: 'class' });
    expect(before).toContain('**implements**: 1 reference(s)');
    expect(before).toContain('**Caller:** ContosoRentClass6');

    idx.ensureDeferredIndexes();

    expect(hasIndex(idx.db, 'idx_symbols_implements')).toBe(true);
    expect(planOf(rdb)).toContain('idx_symbols_implements');
    const after = await run(idx, { targetName: 'ContosoRentIPriced', targetType: 'class' });
    expect(after).toContain('**implements**: 1 reference(s)');
    expect(after).toContain('**Caller:** ContosoRentClass6');
  });

  it('returns the same rows from both statements', () => {
    const idx = tempIndex();
    seed(idx);
    const rdb = idx.getReadDb();
    const names = (sql: string, like: string) =>
      (rdb.prepare(sql).all(like, 500) as any[]).map(r => r.name).sort();

    for (const like of ['%ContosoRentIPriced%', '%ContosoRentIAudited%', '%ContosoRentClass7%']) {
      expect(names(CLASS_IMPLEMENTS_SQL, like)).toEqual(names(CLASS_IMPLEMENTS_SQL_NO_INDEX, like));
    }
    expect(names(CLASS_IMPLEMENTS_SQL, '%ContosoRentIAudited%')).toHaveLength(40);
    expect(names(CLASS_IMPLEMENTS_SQL, '%ContosoRentClass7%')).toEqual([]);
  });

  it('defers the build to a worker on a large database, like the other deferred indexes', () => {
    const idx = tempIndex({ largeDbThresholdBytes: 0 });

    expect(hasIndex(idx.db, 'idx_symbols_implements')).toBe(false);
    expect(idx.hasPendingIndexBuilds()).toBe(true);
  });

  it('runs the method-body search once per class lookup, not twice', async () => {
    const idx = tempIndex();
    seed(idx);
    const rdb = idx.getReadDb();
    let ftsPrepares = 0;
    const counting = {
      prepare: (sql: string) => {
        if (sql.includes('symbols_fts MATCH')) ftsPrepares++;
        return rdb.prepare(sql);
      },
    };
    const stub = { getReadDb: () => counting, db: counting, searchLabels: () => [] };

    await findReferencesTool(
      { method: 'tools/call', params: { name: 'find_references', arguments: { targetName: 'ContosoRentIPriced', targetType: 'class' } } } as any,
      { symbolIndex: stub } as any,
    );

    expect(ftsPrepares).toBe(1);
  });
});
