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

    expect(names).toHaveLength(400);
    expect(names.filter(n => n.endsWith('.ConSKExtension'))).toHaveLength(6);
  });

  it('gives the unused half of the budget back to the other band', () => {
    // Two extensions must not cost 200 regular-object slots: the regular band
    // carries the leading token, and starving it is the other way to skew the
    // sample.
    for (let i = 0; i < 500; i++) add(`ConSKTable${String(i).padStart(3, '0')}`, 'table');
    add('CustTable.ConSKExtension', 'table-extension', 'CustTable');
    add('VendTable.ConSKExtension', 'table-extension', 'VendTable');

    const names = index.getModelObjectNames('ContosoFinanceSK', 100);

    expect(names).toHaveLength(100);
    expect(names.filter(n => n.includes('.'))).toHaveLength(2);
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
