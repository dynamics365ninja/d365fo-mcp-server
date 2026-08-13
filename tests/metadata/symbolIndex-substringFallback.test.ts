/**
 * searchSymbols LIKE fallback on a zero-row FTS5 result (not just a thrown
 * syntax error).
 *
 * Regression: FTS5's default tokenizer treats each symbol name as one
 * indivisible token and only matches token PREFIXES. A mid-token substring
 * query (e.g. "CategoryPropert" against "ProcurementProductCategoryPropertyEntity")
 * is a syntactically valid FTS5 query that legitimately returns zero rows —
 * so the LIKE fallback must also trigger there, not only when FTS5 throws.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;

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
});
