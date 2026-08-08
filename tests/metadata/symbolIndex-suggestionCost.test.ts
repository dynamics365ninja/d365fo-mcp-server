/**
 * Cost of the failed-search "did you mean" path.
 *
 * A search that finds nothing calls getAllSymbolNames() + getSymbolsByTerm(), and
 * agents probe names they get wrong routinely. Both used to run unindexed work on
 * every probe: `name LIKE '%root%'` cannot use any index, so SQLite scanned the
 * whole symbols table, and getSymbolsByTerm re-hydrated the same 3000 rows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, type = 'table') =>
    index.addSymbol({
      name, type, filePath: '/x.xml', model: 'Test',
      usedTypes: 'CustTable', // stored as the raw column value, not an array
    } as any);

  sym('CustTable');
  sym('CustInvoiceJour');
  sym('CustTrans');
  sym('SalesTable');
  sym('VendTable');
});

afterEach(() => index.close());

describe('getAllSymbolNames', () => {
  it('probes symbols_fts by prefix instead of scanning with LIKE', () => {
    const getReadStmt = vi.spyOn(index, 'getReadStmt');

    const names = index.getAllSymbolNames('CusTable');

    expect(names).toContain('CustTable');
    expect(getReadStmt.mock.calls.map(c => c[1])).toContain('suggest_fts_prefix');
    // The unindexed contains-scan must be gone, not merely supplemented.
    expect(getReadStmt.mock.calls.map(c => c[1])).not.toContain('suggest_contains');
  });

  it('answers a repeated probe from cache', () => {
    index.getAllSymbolNames('CusTable');
    const getReadStmt = vi.spyOn(index, 'getReadStmt');

    const again = index.getAllSymbolNames('CusTable');

    expect(again).toContain('CustTable');
    expect(getReadStmt).not.toHaveBeenCalled();
  });

  it('drops the cached pool when symbols change', () => {
    index.getAllSymbolNames('Cus');
    index.addSymbol({ name: 'CusPredicted', type: 'class', filePath: '/y.xml', model: 'Test' } as any);

    expect(index.getAllSymbolNames('Cus')).toContain('CusPredicted');
  });
});

describe('getSymbolsByTerm', () => {
  it('hydrates its 3000-row window once per index generation', () => {
    const first = index.getSymbolsByTerm();
    const prepare = vi.spyOn(index.db, 'prepare');

    const second = index.getSymbolsByTerm();

    expect(second).toBe(first);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rebuilds after a write', () => {
    const first = index.getSymbolsByTerm();
    index.addSymbol({
      name: 'CustPostingProfile', type: 'table', filePath: '/z.xml', model: 'Test',
      usedTypes: 'CustTable', // stored as the raw column value, not an array
    } as any);

    const second = index.getSymbolsByTerm();
    expect(second).not.toBe(first);
    expect(second.has('custpostingprofile')).toBe(true);
  });
});
