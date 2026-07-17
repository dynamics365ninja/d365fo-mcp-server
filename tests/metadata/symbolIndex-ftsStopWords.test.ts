/**
 * sanitizeFtsQuery stop-word handling (audit section 5).
 *
 * Regression: the stop-word set includes common X++ identifiers (find, get,
 * list, process, ...). A search for a method literally named "find" had its
 * only token dropped, and the zero-token fallback then did a phrase search of
 * the raw string, which behaves differently. Stop words must only be dropped
 * while at least one non-stop-word token remains.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, type: string, parentName?: string) =>
    index.addSymbol({ name, type, parentName, filePath: '/x.xml', model: 'Test' } as any);

  sym('CustTable', 'table');
  sym('find', 'method', 'CustTable');
  sym('findRecord', 'method', 'CustTable');
  sym('SalesInvoiceHeader', 'table');
});

afterAll(() => index.close());

describe('searchSymbols with stop-word queries', () => {
  it('a query that is itself a stop word still matches symbols named like it', () => {
    const names = index.searchSymbols('find', 20).map(s => s.name);

    expect(names).toContain('find');
    expect(names).toContain('findRecord');
  });

  it('still drops stop words when a real token remains', () => {
    // If 'find' were kept, the implicit-AND FTS query would match nothing here.
    const names = index.searchSymbols('find SalesInvoiceHeader', 20).map(s => s.name);

    expect(names).toContain('SalesInvoiceHeader');
  });
});
