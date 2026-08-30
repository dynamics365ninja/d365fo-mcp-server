/**
 * searchSymbols LIKE fallback on a zero-row FTS5 result (not just a thrown
 * syntax error), and the guard that keeps that fallback off the queries it
 * cannot answer.
 *
 * Regression: FTS5's default tokenizer treats each symbol name as one
 * indivisible token and only matches token PREFIXES. A mid-token substring
 * query (e.g. "CategoryPropert" against "ProcurementProductCategoryPropertyEntity")
 * is a syntactically valid FTS5 query that legitimately returns zero rows —
 * so the LIKE fallback must also trigger there, not only when FTS5 throws.
 *
 * The other half is cost: `name LIKE '%q%'` cannot use idx_symbols_name, so it
 * scans the whole index (1.19M rows, ~300 ms warm on the production DB) and the
 * zero-row path is reachable on every ordinary miss. The scan must therefore be
 * skipped whenever it provably cannot match — asserted here by spying on the
 * statement cache, since a guarded and an unguarded miss both return [].
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;

/** Statement-cache keys likeFallbackSearch prepares under; nothing else uses them. */
const isFallbackKey = (key: string) => key.startsWith('fallback_');

/** Run `fn` and report whether it reached the LIKE fallback statement. */
function scanned(fn: () => unknown): boolean {
  const spy = vi.spyOn(index, 'getReadStmt');
  try {
    fn();
    return spy.mock.calls.some(([, key]) => isFallbackKey(key as string));
  } finally {
    spy.mockRestore();
  }
}

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, type: string) =>
    index.addSymbol({ name, type, filePath: '/x.xml', model: 'Test' } as any);

  sym('ProcurementProductCategoryPropertyEntity', 'table');
  sym('CustTable', 'table');
});

afterAll(() => index.close());

describe('searchSymbols substring fallback', () => {
  it('matches a mid-token substring that FTS5 prefix matching cannot find', () => {
    const names = index.searchSymbols('CategoryPropert', 20).map(s => s.name);

    expect(names).toContain('ProcurementProductCategoryPropertyEntity');
  });

  it('answers an empty query with nothing, not an alphabetical slice of the index', () => {
    // LIKE '%%' matches every row, so an unguarded fallback turns "no query" into
    // "here are the first N symbols alphabetically" — and skips the caller's
    // no-results/"did you mean" path.
    expect(index.searchSymbols('', 20)).toEqual([]);
    expect(index.searchSymbols('   ', 20)).toEqual([]);
  });

  /**
   * The whitespace guard was right about the SQL it was guarding and wrong about
   * the query. `name LIKE '%procurement category propert%'` is indeed guaranteed
   * empty — but a multi-word query never meant that. It means "a name containing
   * all of these", which is one AND of LIKEs over the same single scan.
   *
   * Measured on the VM: `search(query="ProcessGuide AdjustIn")` returned nothing
   * while `InventProcessGuideAdjustInController` sat in the index, and an eval
   * run took the empty answer as proof and targeted an obsolete class instead.
   */
  it('answers a multi-word query with names carrying every token', () => {
    const names = index.searchSymbols('procurement category propert', 20).map(s => s.name);

    expect(names).toContain('ProcurementProductCategoryPropertyEntity');
  });

  it('requires ALL tokens, not any of them', () => {
    const names = index.searchSymbols('procurement custtable', 20).map(s => s.name);

    // Each token matches a different symbol; no single name carries both.
    expect(names).toEqual([]);
  });

  it('does not scan for a whitespace query with no selective token left', () => {
    // Tokens under 3 chars are dropped, so this AND would collapse to a
    // corpus-wide match — exactly what the original guard existed to prevent.
    expect(scanned(() => index.searchSymbols('a b c', 20))).toBe(false);
    expect(scanned(() => index.searchSymbols('of  a', 20))).toBe(false);
  });

  it('does not scan for a query too short to be a useful substring probe', () => {
    expect(scanned(() => index.searchSymbols('Ca', 20))).toBe(false);
  });

  it('does not scan when the caller opts out, even for a query that would match', () => {
    expect(
      scanned(() => index.searchSymbols('CategoryPropert', 20, undefined, { substringFallback: false }))
    ).toBe(false);
    expect(index.searchSymbols('CategoryPropert', 20, undefined, { substringFallback: false })).toEqual([]);
  });

  it('still scans for a plain single-token miss', () => {
    expect(scanned(() => index.searchSymbols('CategoryPropert', 20))).toBe(true);
  });
});
