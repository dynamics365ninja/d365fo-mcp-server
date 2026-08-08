/**
 * find_event_handlers — delegate subscription branch.
 *
 * The static-handler branch already narrowed through symbols_fts. The delegate
 * branch ran two raw queries instead:
 *
 *   SELECT … FROM symbols WHERE type='method' AND source_snippet LIKE '%X%.on%'
 *    ORDER BY model, parent_name, name LIMIT 20
 *
 * which carried both halves of the defect fixed in the EDT and api-usage paths:
 * the LIKE cannot use an index, and ORDER BY forces every match to be read and
 * sorted before LIMIT applies, so the cost is paid over all 627 K method rows —
 * each carrying source_snippet in overflow pages. Measured warm on the 2 GB
 * index: 3.2 s + 2.3 s per call, all of it blocking (node:sqlite is synchronous).
 *
 * The pre-filter is also the more accurate query. LIKE matches substrings, so
 * `%SalesTable%.on%` reported SalesLine.setAddressFromSalesTable_BR — a method
 * that only has the name inside a longer identifier and subscribes to nothing.
 * FTS matches tokens and drops it. Measured after: 0–51 ms.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';
import { findEventHandlersTool } from '../../src/tools/knowledge/findEventHandlers';

const open: any[] = [];

function makeIndex(methods: Array<{ name: string; parent: string; snippet: string }>) {
  const index: any = new XppSymbolIndex(':memory:', ':memory:');
  open.push(index);
  const ins = index.db.prepare(
    `INSERT INTO symbols (name, type, parent_name, source_snippet, model, file_path)
     VALUES (?, 'method', ?, ?, 'ApplicationSuite', ?)`);
  for (const m of methods) ins.run(m.name, m.parent, m.snippet, `K:\\Pkg\\${m.parent}.xml`);
  index.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
  return index;
}

afterEach(() => {
  for (const i of open.splice(0)) i.close?.();
});

const METHODS = [
  // a genuine delegate subscription on SalesTable
  { name: 'attachHandlers', parent: 'SalesTableEventSubscriber',
    snippet: 'public void attachHandlers()\n{\n    SalesTable.onInserted += eventhandler(this.handleInsert);\n}' },
  // The false positive the substring LIKE used to report (this shape was found
  // in the production index): the queried name appears only inside a longer
  // identifier, and a later unrelated `.on…` call completes the `%X%.on%` match.
  // Nothing here subscribes to anything.
  { name: 'setAddressFromSalesTable_BR', parent: 'SalesLine',
    snippet: '/// Executes after the original setAddressFromSalesTable_BR method.\npublic void setAddressFromSalesTable_BR()\n{\n    next setAddressFromSalesTable_BR();\n    this.onModifiedField(fieldNum(SalesLine, DeliveryPostalAddress));\n}' },
  // a subscription on a different table, to prove the filter is not a pass-through
  { name: 'attachInvent', parent: 'InventTableSubscriber',
    snippet: 'InventTable.onUpdated += eventhandler(this.onInventUpdated);' },
];

const req = (targetClass: string) => ({
  method: 'tools/call' as const,
  params: { name: 'find_event_handlers', arguments: { targetClass, handlerType: 'delegate' as const } },
});

const ctx = (index: any) => ({ symbolIndex: index, bridge: null } as any);

/**
 * Context that records the SQL the tool actually prepares, so a plan assertion
 * can be made against the real query rather than one restated in the test.
 */
function recordingCtx(index: any) {
  const sql: string[] = [];
  const real = index.getReadDb();
  const proxy = new Proxy(real, {
    get(target: any, prop: string | symbol) {
      if (prop === 'prepare') {
        return (text: string) => { sql.push(text); return target.prepare(text); };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { sql, ctx: { symbolIndex: { getReadDb: () => proxy }, bridge: null } as any };
}

describe('find_event_handlers — delegate search', () => {
  it('finds a genuine delegate subscription', async () => {
    const index = makeIndex(METHODS);
    const result: any = await findEventHandlersTool(req('SalesTable'), ctx(index));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesTableEventSubscriber');
  });

  it('does not report a method that only contains the name inside a longer identifier', async () => {
    const index = makeIndex(METHODS);
    const result: any = await findEventHandlersTool(req('SalesTable'), ctx(index));

    expect(result.content[0].text).not.toContain('setAddressFromSalesTable_BR');
  });

  it('does not leak subscriptions belonging to another table', async () => {
    const index = makeIndex(METHODS);
    const result: any = await findEventHandlersTool(req('SalesTable'), ctx(index));

    expect(result.content[0].text).not.toContain('InventTableSubscriber');
  });

  it('answers a target nothing subscribes to without error', async () => {
    const index = makeIndex(METHODS);
    const result: any = await findEventHandlersTool(req('ZzzNoSuchClass'), ctx(index));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain('SalesTableEventSubscriber');
  });

  it('still answers when the index predates symbols_fts', async () => {
    const index = makeIndex(METHODS);
    index.db.exec('DROP TABLE symbols_fts');

    // The pre-filter is an optimisation, not the source of truth: without it the
    // tool must still find the subscription rather than erroring out.
    const result: any = await findEventHandlersTool(req('SalesTable'), ctx(index));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesTableEventSubscriber');
  });

  it('keeps the delegate scan bounded by an index rather than a full table read', async () => {
    // Behaviour alone cannot catch a return to the unbounded query — on a
    // fixture-sized table a full scan is instant and answers the same, and the
    // cost only exists at a scale no unit test can build. So take the SQL the
    // tool really prepared and check the plan SQLite gives it.
    const index = makeIndex(METHODS);
    const { sql, ctx: recording } = recordingCtx(index);

    await findEventHandlersTool(req('SalesTable'), recording);

    const delegateQueries = sql.filter(s => s.includes('source_snippet LIKE'));
    expect(delegateQueries.length).toBeGreaterThan(0);

    for (const query of delegateQueries) {
      const plan = index.db
        .prepare('EXPLAIN QUERY PLAN ' + query)
        .all()
        .map((r: any) => r.detail)
        .join(' | ');
      expect(plan, `unbounded plan for: ${query}`).toMatch(/symbols_fts/);
      expect(plan, `full table scan for: ${query}`).not.toMatch(/SCAN symbols\b/);
    }
  });
});
