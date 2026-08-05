/**
 * XppSymbolIndex.getApiUsagePatterns — reachable from the agent as
 * `analyze_code(mode="api-usage", apiName=…)`.
 *
 * The query behind it was:
 *
 *   SELECT name, parent_name, method_calls, source_snippet FROM symbols
 *    WHERE type = 'method' AND used_types LIKE '%apiName%'
 *    LIMIT 20
 *
 * `used_types` is a comma-separated list of exact type names, so the substring
 * test answered "SalesTable" with methods that only use AxSalesTable or
 * MCRSalesTableRefRecId.
 *
 * It was also unbounded work. LIMIT 20 only stops the scan once 20 matches
 * exist, so an apiName with no matches read used_types out of every method row —
 * each carrying source_snippet and source in overflow pages. Measured against
 * the 2 GB production index: the `type='method'` count alone is 56 ms from the
 * index, but touching used_types on those rows costs 37 s, and the full
 * no-match query ran past 7 minutes. node:sqlite is synchronous, so the server
 * is blocked for all of it — the failure mode is the MCP client giving up and
 * killing the process.
 *
 * The rewrite pre-filters through symbols_fts and decides with exact membership
 * in the list: 0–230 ms on the same index.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';

const open: any[] = [];

function makeIndex(methods: Array<{ name: string; parent: string; usedTypes: string; snippet: string }>) {
  const index: any = new XppSymbolIndex(':memory:', ':memory:');
  open.push(index);
  const ins = index.db.prepare(
    `INSERT INTO symbols (name, type, parent_name, used_types, source_snippet, method_calls, model, file_path)
     VALUES (?, 'method', ?, ?, ?, ?, 'ApplicationSuite', ?)`);
  for (const m of methods) {
    ins.run(m.name, m.parent, m.usedTypes, m.snippet, 'insert,update', `K:\\Pkg\\${m.parent}.xml`);
  }
  // Populate the external-content FTS index the same way a build does.
  index.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
  return index;
}

afterEach(() => {
  for (const i of open.splice(0)) i.close?.();
});

const METHODS = [
  { name: 'postInvoice', parent: 'SalesInvoicePost',
    usedTypes: 'SalesTable, SalesLine, CustTable',
    snippet: 'SalesTable salesTable;\nsalesTable = SalesTable::find(salesId);' },
  { name: 'confirmOrder', parent: 'SalesOrderConfirm',
    usedTypes: 'SalesTable, SalesParmTable',
    snippet: 'SalesTable salesTable = SalesTable::find(_salesId);' },
  // used_types names a DIFFERENT type that merely contains the query string
  { name: 'buildAxRecord', parent: 'AxSalesTableBuilder',
    usedTypes: 'AxSalesTable, AxSalesLine',
    snippet: 'AxSalesTable axSalesTable = AxSalesTable::construct();' },
  { name: 'resolveRef', parent: 'MCRRefResolver',
    usedTypes: 'MCRSalesTableRefRecId',
    snippet: 'MCRSalesTableRefRecId refId;' },
  // case variant of the queried type — X++ identifiers are case-insensitive
  { name: 'updateLine', parent: 'SalesLineUpdate',
    usedTypes: 'salestable, SalesLine',
    snippet: 'salestable st = SalesTable::find(id);' },
];

describe('getApiUsagePatterns', () => {
  it('returns nothing, quickly, for a class no method uses', () => {
    const index = makeIndex(METHODS);
    expect(index.getApiUsagePatterns('ZzzNoSuchClass')).toEqual([]);
  });

  it('does not count types that merely contain the queried name', () => {
    const index = makeIndex(METHODS);
    const patterns = index.getApiUsagePatterns('SalesTable');

    const classes: string[] = patterns.flatMap((p: any) => p.classes ?? []);
    expect(classes).toEqual(expect.arrayContaining(['SalesInvoicePost', 'SalesOrderConfirm']));
    expect(classes).not.toContain('AxSalesTableBuilder');
    expect(classes).not.toContain('MCRRefResolver');
  });

  it('matches a used_types entry regardless of its casing', () => {
    const index = makeIndex(METHODS);
    const classes: string[] = index.getApiUsagePatterns('SalesTable').flatMap((p: any) => p.classes ?? []);
    expect(classes).toContain('SalesLineUpdate');
  });

  it('finds the same methods when the caller varies the casing', () => {
    const index = makeIndex(METHODS);
    const asAsked = index.getApiUsagePatterns('SalesTable').flatMap((p: any) => p.classes ?? []);
    const lowered = index.getApiUsagePatterns('salestable').flatMap((p: any) => p.classes ?? []);
    expect(new Set(lowered)).toEqual(new Set(asAsked));
  });

  it('does not throw on a name containing FTS5 syntax characters', () => {
    const index = makeIndex(METHODS);
    for (const probe of ['Sales"Table', 'Sales(Table)', '"', '   ']) {
      expect(() => index.getApiUsagePatterns(probe)).not.toThrow();
    }
  });

  it('keeps the candidate set bounded by an index rather than scanning', () => {
    // The behavioural tests above cannot catch a return to the unbounded query:
    // on a fixture-sized table a full scan is instant and answers identically.
    // What made the old query a server-stalling defect was the plan it forced on
    // the 2 GB index — so assert the plan, and take the SQL from what the method
    // really prepares rather than restating it here, which would let the
    // production query drift back without the test noticing.
    const index = makeIndex(METHODS);
    const prepared: string[] = [];
    const realDb = index.db;
    index.db = new Proxy(realDb, {
      get(target: any, prop: string | symbol) {
        if (prop === 'prepare') {
          return (text: string) => { prepared.push(text); return target.prepare(text); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    index.getApiUsagePatterns('SalesTable');
    index.db = realDb;

    const query = prepared.find(s => s.includes('used_types'));
    expect(query, 'getApiUsagePatterns prepared no query touching used_types').toBeDefined();

    const plan = realDb
      .prepare('EXPLAIN QUERY PLAN ' + query)
      .all()
      .map((r: any) => r.detail)
      .join(' | ');

    // The FTS virtual table drives the query; symbols is probed by rowid.
    expect(plan, `unbounded plan for: ${query}`).toMatch(/symbols_fts/);
    expect(plan, `full table scan for: ${query}`).not.toMatch(/SCAN symbols\b/);
  });
});
