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
import { findCocExtensionsTool } from '../../src/tools/knowledge/findCocExtensions';
import { analyzeExtensionPointsTool } from '../../src/tools/knowledge/analyzeExtensionPoints';
import { subscribesToFtsMatch } from '../../src/utils/symbolLookup';

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

// ── SubscribesTo searches: the target narrows the full-text match ────────────
//
// Four queries matched `source_snippet:SubscribesTo` (every subscriber method in
// the index) and left the target to a LIKE that reads each snippet. The target
// now goes into the MATCH as a prefix term. These tests pin recall: for every
// target shape the narrowed query must return the rows the old shape returned.

describe('SubscribesTo searches narrowed by target', () => {
  const sub = (name: string, parent: string, attr: string) => ({
    name, parent,
    snippet: `[${attr}]\npublic static void ${name}(Common _sender, DataEventArgs _e)\n{\n}`,
  });

  const SUBSCRIBERS = [
    sub('rentInserted', 'ContosoRentHandler',
      'SubscribesTo(tableStr(ContosoRent), delegateStr(ContosoRent, onInserted))'),
    // the target is a prefix of a longer subscribed name
    sub('equipmentInserted', 'ContosoRentEquipmentHandler',
      'SubscribesTo(tableStr(ContosoRentEquipmentTable), delegateStr(ContosoRentEquipmentTable, onInserted))'),
    sub('equipmentPosted', 'ContosoRentEquipmentPostHandler',
      'SubscribesTo(classStr(ContosoRentEquipmentPost), delegateStr(ContosoRentEquipmentPost, posted))'),
    sub('rentFormClosing', 'ContosoRentFormHandler',
      'SubscribesTo(formStr(ContosoRent), delegateStr(ContosoRent, onClosing))'),
    // underscores: the tokenizer splits these names into several tokens
    sub('legacyUpdated', 'ContosoLegacyHandler',
      'SubscribesTo(tableStr(Contoso_Rent_Table), delegateStr(Contoso_Rent_Table, onUpdated))'),
    sub('legacyRentalUpdated', 'ContosoLegacyRentalHandler',
      'SubscribesTo(tableStr(Contoso_Rental), delegateStr(Contoso_Rental, onUpdated))'),
    // `_` is a LIKE wildcard, so the old query also matched this for "Contoso_Rent"
    sub('xRentUpdated', 'ContosoXRentHandler',
      'SubscribesTo(tableStr(ContosoXRent), delegateStr(ContosoXRent, onUpdated))'),
    // a name that begins with a separator
    sub('privateUpdated', 'ContosoPrivateHandler',
      'SubscribesTo(tableStr(_ContosoPrivate), delegateStr(_ContosoPrivate, onUpdated))'),
    // digits belong to the token
    sub('v2Inserted', 'ContosoRentV2Handler',
      'SubscribesTo(tableStr(ContosoRent2Line), delegateStr(ContosoRent2Line, onInserted))'),
    // unrelated subscriber, and a non-subscriber that mentions the target
    sub('custInserted', 'ContosoCustHandler',
      'SubscribesTo(tableStr(CustTable), delegateStr(CustTable, onInserted))'),
    { name: 'findRent', parent: 'ContosoRentReader',
      snippet: 'public void findRent()\n{\n    info(tableStr(ContosoRent));\n}' },
  ];

  const COLS = `SELECT s.name, s.parent_name FROM symbols_fts fts JOIN symbols s ON s.id = fts.rowid`;
  const ORDER = ` ORDER BY s.parent_name, s.name`;

  /** The static-handler query as it was (old) and as the tools issue it now (new). */
  function attributeRows(index: any, target: string) {
    const like = `AND s.type = 'method'
       AND (s.source_snippet LIKE ? OR s.source_snippet LIKE ? OR s.source_snippet LIKE ?)`;
    const patterns = [
      `%SubscribesTo(classStr(${target}%`,
      `%SubscribesTo(tableStr(${target}%`,
      `%SubscribesTo(formStr(${target}%`,
    ];
    const oldRows = index.db.prepare(
      `${COLS} WHERE symbols_fts MATCH 'source_snippet:SubscribesTo' ${like}${ORDER}`,
    ).all(...patterns);
    const newRows = index.db.prepare(
      `${COLS} WHERE symbols_fts MATCH ? ${like}${ORDER}`,
    ).all(subscribesToFtsMatch(target), ...patterns);
    return { oldRows, newRows };
  }

  /** The analyze_extension_points shape: the name anywhere in the snippet. */
  function substringRows(index: any, target: string) {
    const like = `AND s.type = 'method' AND s.source_snippet LIKE ?`;
    const oldRows = index.db.prepare(
      `${COLS} WHERE symbols_fts MATCH 'source_snippet:SubscribesTo' ${like}${ORDER}`,
    ).all(`%${target}%`);
    const newRows = index.db.prepare(
      `${COLS} WHERE symbols_fts MATCH ? ${like}${ORDER}`,
    ).all(subscribesToFtsMatch(target), `%${target}%`);
    return { oldRows, newRows };
  }

  it('builds a prefix term from the leading letters and digits of the target', () => {
    expect(subscribesToFtsMatch('ContosoRent'))
      .toBe('{source_snippet} : (SubscribesTo AND "ContosoRent"*)');
    expect(subscribesToFtsMatch('Contoso_Rent_Table'))
      .toBe('{source_snippet} : (SubscribesTo AND "Contoso"*)');
    expect(subscribesToFtsMatch('ContosoRent2Line.sub'))
      .toBe('{source_snippet} : (SubscribesTo AND "ContosoRent2Line"*)');
    expect(subscribesToFtsMatch('Contoso"Rent')).not.toContain('Contoso"Rent');
  });

  it('falls back to the unfiltered match for a target with no leading token', () => {
    expect(subscribesToFtsMatch('_ContosoPrivate')).toBe('source_snippet:SubscribesTo');
    expect(subscribesToFtsMatch('')).toBe('source_snippet:SubscribesTo');
    expect(subscribesToFtsMatch('"')).toBe('source_snippet:SubscribesTo');
  });

  const TARGETS: Array<[string, string, string[]]> = [
    ['a prefix of longer subscribed names', 'ContosoRent', [
      'ContosoRentEquipmentHandler', 'ContosoRentEquipmentPostHandler', 'ContosoRentFormHandler',
      'ContosoRentHandler', 'ContosoRentV2Handler']],
    ['an exact name', 'ContosoRentEquipmentTable', ['ContosoRentEquipmentHandler']],
    ['a name with underscores', 'Contoso_Rent_Table', ['ContosoLegacyHandler']],
    ['an underscore name that is a prefix (and a LIKE wildcard)', 'Contoso_Rent', [
      'ContosoLegacyHandler', 'ContosoLegacyRentalHandler', 'ContosoXRentHandler']],
    ['mixed case', 'cONTOSOrentEQUIPMENTtable', ['ContosoRentEquipmentHandler']],
    ['lower case with an underscore', 'contoso_rental', ['ContosoLegacyRentalHandler']],
    ['a name with digits', 'ContosoRent2', ['ContosoRentV2Handler']],
    ['a name starting with a separator', '_ContosoPrivate', ['ContosoPrivateHandler']],
    ['a name with a double quote', 'Contoso"Rent', []],
    ['a name nothing subscribes to', 'ContosoNoSuchTable', []],
  ];

  for (const [label, target, expected] of TARGETS) {
    it(`returns the same rows as the old query for ${label}`, () => {
      const index = makeIndex(SUBSCRIBERS);
      const { oldRows, newRows } = attributeRows(index, target);
      expect(newRows).toEqual(oldRows);
      expect(newRows.map((r: any) => r.parent_name)).toEqual(expected);
    });
  }

  it('returns the same rows for the name-anywhere shape when the name starts an identifier', () => {
    const index = makeIndex(SUBSCRIBERS);
    for (const target of ['ContosoRent', 'Contoso_Rent_Table', 'contosorentequipmentpost', 'CustTable', '_ContosoPrivate']) {
      const { oldRows, newRows } = substringRows(index, target);
      expect(newRows, target).toEqual(oldRows);
      expect(newRows.length, target).toBeGreaterThan(0);
    }
  });

  it('name-anywhere shape: drops only a subscriber that has the name inside a longer identifier', () => {
    // The one place the narrowed query differs. `%RentEquipment%` used to match
    // every snippet containing those letters, including subscribers of
    // ContosoRentEquipmentTable when the object asked about is "RentEquipment".
    // A token match needs the name at the START of an identifier, the same
    // trade the delegate search above already makes.
    const index = makeIndex(SUBSCRIBERS);
    const { oldRows, newRows } = substringRows(index, 'RentEquipment');
    expect(oldRows.length).toBe(2);
    expect(newRows).toEqual([]);
  });

  const call = (name: string, args: Record<string, unknown>) => ({
    method: 'tools/call' as const,
    params: { name, arguments: args },
  });

  it('find_event_handlers lists the static handlers of the target and its longer-named matches', async () => {
    const index = makeIndex(SUBSCRIBERS);
    const result: any = await findEventHandlersTool(
      call('find_event_handlers', { targetTable: 'contosorent', handlerType: 'static' }) as any, ctx(index));
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    for (const handler of ['ContosoRentHandler', 'ContosoRentEquipmentHandler', 'ContosoRentFormHandler', 'ContosoRentV2Handler']) {
      expect(text).toContain(handler);
    }
    expect(text).not.toContain('ContosoCustHandler');
    expect(text).not.toContain('ContosoRentReader');
  });

  it('find_event_handlers passes the target into the full-text match', async () => {
    const index = makeIndex(SUBSCRIBERS);
    const { sql, ctx: recording } = recordingCtx(index);
    await findEventHandlersTool(
      call('find_event_handlers', { targetTable: 'ContosoRent', handlerType: 'static' }) as any, recording);
    const staticQuery = sql.find(s => s.includes('symbols_fts fts JOIN symbols'));
    expect(staticQuery).toContain('symbols_fts MATCH ?');
    expect(staticQuery).not.toContain("MATCH 'source_snippet:SubscribesTo'");
  });

  it('find_coc_extensions and analyze_extension_points still find the subscribers', async () => {
    const index = makeIndex(SUBSCRIBERS);
    const coc: any = await findCocExtensionsTool(
      call('find_coc_extensions', { className: 'Contoso_Rent_Table' }) as any, ctx(index));
    expect(coc.content[0].text).toContain('ContosoLegacyHandler.legacyUpdated');
    expect(coc.content[0].text).not.toContain('ContosoCustHandler');

    const points: any = await analyzeExtensionPointsTool(
      call('analyze_extension_points', { objectName: 'ContosoRentEquipmentTable', objectType: 'table' }) as any,
      ctx(index));
    expect(points.isError).toBeFalsy();
    expect(points.content[0].text).toContain('ContosoRentEquipmentHandler.equipmentInserted');
  });
});
