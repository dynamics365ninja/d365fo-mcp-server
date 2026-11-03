/**
 * CoC extensions with a method filter — only classes that wrap the method are counted.
 *
 * Background. `extension_info(mode="coc", target="SalesTable", method="validateWrite")`
 * answered "Found 12 extension class(es) wrapping "validateWrite"" on a live system where two
 * of the twelve wrap it. The filter kept every class with an EMPTY wrap list too
 * (`|| ext.wrappedMethods.length === 0`), a leftover from when the list held every base
 * method a class called. The bridge sends a list for every class
 * (`WrappedMethods = new List<string>()`), so empty means "wraps nothing", not "unknown".
 *
 * The non-wrappers are still useful (an agent about to add a validateWrite wrapper should see
 * the other extensions of the table), so they stay in the output under their own heading and
 * count. Only a class whose list is missing altogether — an older bridge, another source —
 * is "unknown", and it is never counted as a wrapper either.
 *
 * The filesystem fallback of the index path has the same clause and gets the same split: the
 * scanner reads every method body, so an empty cocMethods there means no `next` was found.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { tryBridgeCocExtensions } from '../../src/bridge/bridgeAdapter';
import type { BridgeClient } from '../../src/bridge/bridgeClient';
import type { BridgeExtensionClassEntry } from '../../src/bridge/bridgeTypes';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { findCocExtensionsTool } from '../../src/tools/knowledge/findCocExtensions';
import type { XppServerContext } from '../../src/types/context';
import type { FsExtensionScanResult } from '../../src/utils/fsExtensionScanner';

const fsScan = vi.hoisted(() => ({ results: [] as FsExtensionScanResult[] }));

vi.mock('../../src/utils/fsExtensionScanner', () => ({
  scanFsExtensions: vi.fn(async () => fsScan.results),
}));

vi.mock('../../src/utils/configManager', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils/configManager')>()),
  getConfigManager: vi.fn(() => ({ getPackagePath: () => 'K:\\AosService\\PackagesLocalDirectory' })),
}));

const SALESTABLE_EXTENSIONS: BridgeExtensionClassEntry[] = [
  { className: 'ContosoSalesTableValidate_Extension', module: 'ContosoSales', extendedElement: '/Tables/SalesTable', wrappedMethods: ['insert', 'validateWrite'] },
  { className: 'ContosoSalesTableUpdate_Extension', module: 'ContosoSales', extendedElement: '/Tables/SalesTable', wrappedMethods: ['update', 'insert'] },
  // Adds fields or methods of its own and wraps nothing.
  { className: 'ContosoSalesTableFields_Extension', module: 'ContosoSales', extendedElement: '/Tables/SalesTable', wrappedMethods: [] },
  // No list at all: the source could not say what the class wraps.
  { className: 'ContosoSalesTableLegacy_Extension', module: 'ContosoLegacy', extendedElement: '/Tables/SalesTable' },
  { className: 'ContosoSalesTableForm_SalesTableDS_Extension', module: 'ContosoSales', extendedElement: '/Forms/SalesTable/DataSources/SalesTable', wrappedMethods: ['validateWrite'] },
];

function cocBridge(extensions = SALESTABLE_EXTENSIONS): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findExtensionClasses: vi.fn(async () => ({
      baseClassName: 'SalesTable', count: extensions.length, extensions, _source: 'C# bridge (DYNAMICSXREFDB)',
    })),
  } as unknown as BridgeClient;
}

async function render(methodName?: string, extensions = SALESTABLE_EXTENSIONS): Promise<string> {
  const result = await tryBridgeCocExtensions(cocBridge(extensions), 'SalesTable', methodName);
  expect(result).not.toBeNull();
  return (result!.content[0] as { text: string }).text;
}

/** The text from `start` up to the next section line (or the end). */
function section(text: string, start: string): string {
  const from = text.indexOf(start);
  expect(from, `section "${start}"`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from + start.length);
  const next = rest.search(/^(Other extension classes|Extension classes of)/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('CoC extensions (bridge path) — method filter', () => {
  it('counts only the classes whose wrap list names the method', async () => {
    const text = await render('validateWrite');
    expect(text).toContain('Found 2 extension class(es) wrapping "validateWrite":');

    const wrappers = section(text, 'wrapping "validateWrite":');
    expect(wrappers).toContain('ContosoSalesTableValidate_Extension');
    expect(wrappers).toContain('ContosoSalesTableForm_SalesTableDS_Extension');
    expect(wrappers).not.toContain('ContosoSalesTableUpdate_Extension');
    expect(wrappers).not.toContain('ContosoSalesTableFields_Extension');
    expect(wrappers).not.toContain('ContosoSalesTableLegacy_Extension');
    // Still grouped by the element each class extends.
    expect(wrappers).toContain('### Table SalesTable — 1');
    expect(wrappers).toContain('### Form SalesTable › DataSource SalesTable — 1');
  });

  it('lists the other extension classes under their own heading and count', async () => {
    const text = await render('validateWrite');
    const heading = 'Other extension classes of SalesTable (no wrap of "validateWrite" recorded): 2';
    expect(text).toContain(heading);

    const others = section(text, heading);
    expect(others).toContain('### Table SalesTable — 2');
    expect(others).toContain('ContosoSalesTableUpdate_Extension');
    expect(others).toContain('Wraps methods: update, insert');
    expect(others).toContain('ContosoSalesTableFields_Extension');
    expect(others).not.toContain('ContosoSalesTableLegacy_Extension');
  });

  it('puts a class without a wrap list under "wraps unknown", never among the wrappers', async () => {
    const text = await render('validateWrite');
    const heading = 'Extension classes of SalesTable, wraps unknown (the source sent no wrap list): 1';
    expect(text).toContain(heading);
    expect(section(text, heading)).toContain('ContosoSalesTableLegacy_Extension');
    // The sections follow in this order: wrappers, others, unknown.
    expect(text.indexOf('Found 2')).toBeLessThan(text.indexOf('Other extension classes'));
    expect(text.indexOf('Other extension classes')).toBeLessThan(text.indexOf(heading));
  });

  it('lists every class exactly once', async () => {
    const text = await render('validateWrite');
    for (const ext of SALESTABLE_EXTENSIONS) {
      expect(text.split(`**${ext.className}**`).length - 1, ext.className).toBe(1);
    }
  });

  it('matches the method name case-insensitively', async () => {
    const text = await render('VALIDATEWRITE');
    expect(text).toContain('Found 2 extension class(es) wrapping "VALIDATEWRITE":');
    expect(text).toContain('(no wrap of "VALIDATEWRITE" recorded): 2');
  });

  it('says 0 when no class wraps the method, and still lists the others', async () => {
    const text = await render('delete');
    expect(text).toContain('Found 0 extension class(es) wrapping "delete":');
    expect(text).toContain('Other extension classes of SalesTable (no wrap of "delete" recorded): 4');
    expect(text).toContain('wraps unknown (the source sent no wrap list): 1');
  });

  it('omits the other and unknown headings when every class wraps the method', async () => {
    const text = await render('validateWrite', SALESTABLE_EXTENSIONS.filter(e => e.wrappedMethods?.includes('validateWrite')));
    expect(text).toContain('Found 2 extension class(es) wrapping "validateWrite":');
    expect(text).not.toContain('Other extension classes');
    expect(text).not.toContain('wraps unknown');
  });

  it('leaves the output without a method filter unchanged', async () => {
    // Snapshot taken from the formatter before this change.
    expect(await render()).toMatchInlineSnapshot(`
      "CoC Extensions of: SalesTable
      _Source: C# bridge (DYNAMICSXREFDB)_

      Found 5 extension class(es):

      ### Table SalesTable — 4

      - **ContosoSalesTableValidate_Extension** (ContosoSales)
          Wraps methods: insert, validateWrite
      - **ContosoSalesTableUpdate_Extension** (ContosoSales)
          Wraps methods: update, insert
      - **ContosoSalesTableFields_Extension** (ContosoSales)
      - **ContosoSalesTableLegacy_Extension** (ContosoLegacy)

      ### Form SalesTable › DataSource SalesTable — 1

      - **ContosoSalesTableForm_SalesTableDS_Extension** (ContosoSales)
          Wraps methods: validateWrite

      "
    `);
  });
});

// ---------------------------------------------------------------------------
// Index path, filesystem fallback (Windows only, empty index)
// ---------------------------------------------------------------------------

const fsExt = (name: string, addedMethods: string[], cocMethods: string[]): FsExtensionScanResult => ({
  name, model: 'ContosoSales', filePath: `K:\\AosService\\PackagesLocalDirectory\\ContosoSales\\ContosoSales\\AxClass\\${name}.xml`,
  addedFields: [], addedIndexes: [], addedMethods, cocMethods, addedValues: [], addedControls: [], addedDataSources: [],
});

const FS_EXTENSIONS = [
  fsExt('ContosoSalesTableValidate_Extension', ['validateWrite', 'contosoCheck'], ['validateWrite']),
  fsExt('ContosoSalesTableInsert_Extension', ['insert'], ['insert']),
  // Defines methods of its own and calls `next` in none of them.
  fsExt('ContosoSalesTableHelpers_Extension', ['contosoTotal'], []),
];

describe('CoC extensions (filesystem fallback) — method filter', () => {
  const originalPlatform = process.platform;
  let index: XppSymbolIndex;
  let context: XppServerContext;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    index = new XppSymbolIndex(':memory:', ':memory:');
    context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
    fsScan.results = FS_EXTENSIONS;
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    index.close();
  });

  const run = async (methodName?: string): Promise<string> => {
    const result = await findCocExtensionsTool({
      method: 'tools/call',
      params: { name: 'find_coc_extensions', arguments: { className: 'SalesTable', methodName, includeEventHandlers: false } },
    }, context);
    return result.content?.[0]?.text ?? '';
  };

  it('counts only the classes that wrap the method and lists the others separately', async () => {
    const text = await run('validateWrite');
    expect(text).toContain('Found 1 class extension(s) on disk (not yet in index) wrapping "validateWrite":');

    const [wrappers, others] = text.split('Other class extensions of SalesTable on disk (no wrap of "validateWrite" found): 2');
    expect(others, 'other heading').toBeDefined();
    expect(wrappers).toContain('[1] ContosoSalesTableValidate_Extension');
    expect(wrappers).not.toContain('ContosoSalesTableHelpers_Extension');
    expect(others).toContain('[2] ContosoSalesTableInsert_Extension');
    expect(others).toContain('Wraps methods: insert');
    expect(others).toContain('[3] ContosoSalesTableHelpers_Extension');
  });

  it('matches the method name case-insensitively', async () => {
    const text = await run('VALIDATEWRITE');
    expect(text).toContain('Found 1 class extension(s) on disk (not yet in index) wrapping "VALIDATEWRITE":');
    expect(text).toContain('(no wrap of "VALIDATEWRITE" found): 2');
  });

  it('leaves the output without a method filter unchanged', async () => {
    // Snapshot taken from the tool before this change.
    expect(await run()).toMatchInlineSnapshot(`
      "CoC Extensions of: SalesTable

      No class extensions found for: SalesTable
      Scanning filesystem for unindexed class extensions (K:\\AosService\\PackagesLocalDirectory)…

      Found 3 class extension(s) on disk (not yet in index):

      [1] ContosoSalesTableValidate_Extension (ContosoSales)
          File: K:\\AosService\\PackagesLocalDirectory\\ContosoSales\\ContosoSales\\AxClass\\ContosoSalesTableValidate_Extension.xml
          Wraps methods: validateWrite
          Uses 'next' keyword: ✓
          Added methods: contosoCheck
      [2] ContosoSalesTableInsert_Extension (ContosoSales)
          File: K:\\AosService\\PackagesLocalDirectory\\ContosoSales\\ContosoSales\\AxClass\\ContosoSalesTableInsert_Extension.xml
          Wraps methods: insert
          Uses 'next' keyword: ✓
      [3] ContosoSalesTableHelpers_Extension (ContosoSales)
          File: K:\\AosService\\PackagesLocalDirectory\\ContosoSales\\ContosoSales\\AxClass\\ContosoSalesTableHelpers_Extension.xml
          Added methods: contosoTotal

      ⚠️ Data sourced from disk — run extract-metadata + build-database to persist to index.
      "
    `);
  });
});
