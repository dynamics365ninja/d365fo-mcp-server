/**
 * getModelObjectNames — the sample prefix inference is derived from (#878).
 *
 * The query had no ORDER BY, so on a model with more objects than the cap SQLite
 * chose which ones inference saw. That matters because inference is threshold-based
 * (MIN_COVERAGE 60 %) and reads two DIFFERENT bands of evidence: extension names
 * state the model's infix outright ("CustTable.ConSKExtension"), regular names carry
 * the leading token. Extensions are rare, so an undefined window over the union can
 * drop every one of them — and the failure is silent AND self-reinforcing, because
 * this server writes new names with the inferred prefix and those names are the
 * evidence for the next inference.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex, readModelObjectNames } from '../../src/metadata/symbolIndex';
import { inferPrefixFromObjectNames } from '../../src/utils/modelPrefixInference';

let index: XppSymbolIndex;

const add = (name: string, type: string, parentName?: string) =>
  index.addSymbol({
    name,
    type,
    parentName,
    filePath: `Pkg/ConSK/${name.replace(/[.\\/]/g, '_')}.xml`,
    model: 'ContosoFinanceSK',
  } as any);

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
});

afterEach(() => index.close());

describe('getModelObjectNames', () => {
  it('is deterministic — the same model yields the same sample every call', () => {
    for (let i = 0; i < 50; i++) add(`ConSKTable${String(i).padStart(3, '0')}`, 'table');

    const first = index.getModelObjectNames('ContosoFinanceSK', 10);
    const second = index.getModelObjectNames('ContosoFinanceSK', 10);

    expect(first).toHaveLength(10);
    expect(second).toEqual(first);
  });

  it('keeps extensions in the sample when regular objects outnumber the cap', () => {
    // The shape that broke inference: a handful of extensions spelling the infix,
    // buried under hundreds of regular objects. An undefined window over the union
    // returns 400 tables and not one extension.
    for (let i = 0; i < 500; i++) add(`ConSKTable${String(i).padStart(3, '0')}`, 'table');
    for (let i = 0; i < 6; i++) {
      add(`CustTable${i}.ConSKExtension`, 'table-extension', `CustTable${i}`);
    }

    const names = index.getModelObjectNames('ContosoFinanceSK');

    expect(names.filter(n => n.endsWith('.ConSKExtension'))).toHaveLength(6);
    // Every extension, and only as many regular objects as inference can use — it
    // needs MIN_SAMPLE (4) of them and decides on 60 % coverage, so the other 440
    // were read on the first call of every session and changed no answer.
    expect(names.filter(n => !n.includes('.'))).toHaveLength(60);
  });

  it('gives the unused half of the budget back to the other band', () => {
    // Two extensions must not cost 200 regular-object slots: the regular band
    // carries the leading token, and starving it is the other way to skew the
    // sample.
    for (let i = 0; i < 500; i++) add(`ConSKTable${String(i).padStart(3, '0')}`, 'table');
    add('CustTable.ConSKExtension', 'table-extension', 'CustTable');
    add('VendTable.ConSKExtension', 'table-extension', 'VendTable');

    // Below the regular band's own cap, so what is measured here is the hand-back
    // and not the cap: 2 of the 20 extension slots used, 38 left for regulars.
    const names = index.getModelObjectNames('ContosoFinanceSK', 40);

    expect(names).toHaveLength(40);
    expect(names.filter(n => n.includes('.'))).toHaveLength(2);
  });

  /** The fixture the plan cases share: enough models and members for ANALYZE to matter. */
  const populateManyModels = () => {
    for (let m = 0; m < 40; m++) {
      for (let i = 0; i < 40; i++) {
        add(`Con${m}Table${String(i).padStart(3, '0')}`, 'table');
        index.addSymbol({
          name: 'validateWrite', type: 'method', parentName: `Con${m}Table${String(i).padStart(3, '0')}`,
          filePath: 'p', model: `Model${m}`,
        } as any);
      }
    }
    // Without stats the planner has no reason to prefer one index over another;
    // the choice this suite is about only appears once it has them, as in production.
    index.db.exec('ANALYZE');
  };

  it('has no index on parent_name for the bad plan to be chosen from', () => {
    // The original defect was a MISPRICE, not a typo: `parent_name IS NULL` reads
    // like a cheap equality and ANALYZE priced it as one (~13 rows per value), but
    // NULL is every top-level object of every model — 180,664 of 1,188,748 rows on
    // the production DB against 274 for the model asked about. Choosing that index
    // turned a session's first get_workspace_info into 483 s of random reads over
    // a 2.5 GB file.
    //
    // 1.17.3 defused the known instance with a unary `+`. Dropping the index
    // removes the loaded gun: no future query can be captured by it, whether or
    // not whoever writes it knows to add the guard. Verified on the production DB
    // before the drop — every legitimate `parent_name = ?` lookup already planned
    // on idx_parent_type_name or idx_type_parent, so the bare index earned nothing.
    populateManyModels();

    const indexes = (index.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols'`)
      .all() as Array<{ name: string }>).map(r => r.name);

    expect(indexes).not.toContain('idx_symbols_parent_name');
    // The partial indexes that DO carry member lookups must still be there —
    // dropping the bare one is only safe because these cover that work.
    expect(indexes).toEqual(expect.arrayContaining(['idx_parent_type_name', 'idx_type_parent']));

    // And the shape that used to be captured cannot be any more, guard or no guard.
    for (const guard of ['parent_name IS NULL', '+parent_name IS NULL']) {
      const plan = (index.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT name FROM symbols
           WHERE model = ? AND type NOT LIKE '%-extension' AND ${guard}
             AND type NOT IN ('method', 'field')
           ORDER BY type, name LIMIT ?`,
        )
        .all('ContosoFinanceSK', 60) as Array<{ detail: string }>)
        .map(r => r.detail)
        .join(' ');
      expect(plan).not.toContain('idx_symbols_parent_name');
    }
  });

  it('covers the SQL it ACTUALLY issues, in both bands, with no sort pass', () => {
    // The case above reasons about SQL written in the test. This one takes the SQL
    // out of the implementation, so a query that drifts is caught even if the
    // literal above still reads correctly — which is exactly how `doctor` came to
    // keep its own 483-second copy of this read for a release after the server's
    // was fixed.
    populateManyModels();

    const issued: string[] = [];
    readModelObjectNames(
      { prepare: (sql: string) => { issued.push(sql); return { all: () => [] }; } },
      'ContosoFinanceSK',
    );
    // Both bands, so a fix applied to only one of them cannot pass.
    expect(issued).toHaveLength(2);
    for (const sql of issued) {
      const plan = (index.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('ContosoFinanceSK', 60) as Array<{ detail: string }>)
        .map(r => r.detail)
        .join(' ');
      // COVERING: nothing touches the table, so the cost is the rows returned
      // rather than the rows the model has.
      expect(plan).toContain('COVERING INDEX idx_model_type_name');
      // And no sort pass. `ORDER BY type, name LIMIT n` over a plan that cannot
      // deliver that order has to read EVERY row of the model before the limit
      // can apply — 2.4 s warm on a large production model, even on the right
      // index. The temp B-tree is that pass, and its absence is the fix.
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });

  it('still excludes members and non-extension children', () => {
    add('ConSKPriceEngine', 'class');
    add('calculate', 'method', 'ConSKPriceEngine');
    add('AmountMST', 'field', 'ConSKTable');
    add('CustTable.ConSKExtension', 'table-extension', 'CustTable');

    const names = index.getModelObjectNames('ContosoFinanceSK');

    expect(names.sort()).toEqual(['ConSKPriceEngine', 'CustTable.ConSKExtension']);
  });

  it('infers the model infix from a sample that regular objects would have flooded', () => {
    // End to end: the 34-of-36 case from the issue, scaled past the cap. With the
    // extensions crowded out, inference sees only the regular token and flattens
    // the "SK" country code to "Sk".
    for (let i = 0; i < 450; i++) add(`ConSkTable${String(i).padStart(3, '0')}`, 'table');
    for (let i = 0; i < 35; i++) {
      add(`CustTable${i}.ConSKExtension`, 'table-extension', `CustTable${i}`);
    }

    const inferred = inferPrefixFromObjectNames(
      index.getModelObjectNames('ContosoFinanceSK'),
      'ContosoFinanceSK',
    );

    expect(inferred?.infix).toBe('ConSK');
  });
});
