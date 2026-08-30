/**
 * The substring fallback must stay inside the name index.
 *
 * FTS5 matches token prefixes, so a mid-token query ("CategoryPropert") is a
 * valid search that legitimately returns nothing and falls back to
 * `name LIKE '%q%'`. That scan cannot use an index for the comparison, but it
 * CAN be answered entirely from idx_symbols_name — as long as the statement
 * selects nothing but the rowid.
 *
 * Measured on the reference VM (1.19 M symbols, 2.5 GB): selecting the display
 * columns costs 98.8 s cold / ~2 s warm because every candidate is fetched from
 * the table; selecting only `id` costs 83.4 s cold / 0.27 s warm and touches no
 * table pages at all. It is also the index the startup warm-up preloads, so the
 * two changes only pay off together — which is why the plan is asserted here
 * rather than left to whoever next adds a column to the SELECT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: any;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  for (const name of ['ProcurementProductCategoryPropertyEntity', 'CategoryPropertyTable', 'CustTable']) {
    index.addSymbol({ name, type: name.endsWith('Table') ? 'table' : 'class', filePath: `K:/x/${name}.xml`, model: 'Foundation' });
  }
});
afterEach(() => { index.close?.(); });

describe('likeFallbackSearch', () => {
  it('still finds a mid-token substring FTS cannot match, in name order', () => {
    // Not "CategoryPropert": FTS indexes each name as ONE token and matches its
    // prefix, so that query hits CategoryPropertyTable outright and the fallback
    // never runs — the known limitation substringScanIsWorthIt documents.
    const hits = index.searchSymbols('ategoryPropert', 10);
    expect(hits.map((h: any) => h.name)).toEqual([
      'CategoryPropertyTable',
      'ProcurementProductCategoryPropertyEntity',
    ]);
  });

  it('returns the columns callers render, not just the id it scanned for', () => {
    const [first] = index.searchSymbols('ategoryPropertyTab', 10);
    expect(first).toMatchObject({ name: 'CategoryPropertyTable', type: 'table', model: 'Foundation' });
    expect(first.filePath).toContain('CategoryPropertyTable.xml');
  });

  it('scans the covering index, never the table', () => {
    const plan = index.getReadDb()
      .prepare(`EXPLAIN QUERY PLAN SELECT s.id FROM symbols s WHERE s.name LIKE ? ORDER BY s.name LIMIT ?`)
      .all('%QualityTier%', 10)
      .map((r: any) => r.detail)
      .join(' | ');
    expect(plan).toContain('COVERING INDEX');
  });

  it('honours the limit through the hydrate step', () => {
    expect(index.searchSymbols('ategoryPropert', 1)).toHaveLength(1);
  });
});
