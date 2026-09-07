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
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
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

  it('seeks on idx_symbols_model, not on the parent_name index', () => {
    // The plan IS the assertion. `parent_name IS NULL` reads like a cheap equality
    // and ANALYZE prices it as one (~13 rows per value), but NULL is every
    // top-level object of every model — 180,664 of 1,188,748 rows on the production
    // DB against 274 for the model. Picking that index turned the first
    // get_workspace_info of a session into 337 s of random reads over a 2.5 GB file.
    for (let m = 0; m < 40; m++) {
      for (let i = 0; i < 40; i++) {
        add(`Con${m}Table${String(i).padStart(3, '0')}`, 'table');
        index.addSymbol({
          name: 'validateWrite', type: 'method', parentName: `Con${m}Table${String(i).padStart(3, '0')}`,
          filePath: 'p', model: `Model${m}`,
        } as any);
      }
    }
    // Without stats the planner has no reason to prefer either index; the bad
    // choice only appears once it has them, exactly as in production.
    index.db.exec('ANALYZE');

    const planOf = (guard: string) => (index.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT name FROM symbols
         WHERE model = ? AND type NOT LIKE '%-extension' AND ${guard}
           AND type NOT IN ('method', 'field')
         ORDER BY type, name LIMIT ?`,
      )
      .all('ContosoFinanceSK', 60) as Array<{ detail: string }>)
      .map(r => r.detail)
      .join('\n');

    // Both halves, so the fixture cannot go quietly vacuous: if the unguarded form
    // ever stops choosing the wrong index here, this test has stopped reproducing
    // the thing the guard exists for and the assertion below proves nothing.
    expect(planOf('parent_name IS NULL')).toContain('idx_symbols_parent_name');
    expect(planOf('+parent_name IS NULL')).toContain('idx_symbols_model');
    expect(planOf('+parent_name IS NULL')).not.toContain('idx_symbols_parent_name');
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
