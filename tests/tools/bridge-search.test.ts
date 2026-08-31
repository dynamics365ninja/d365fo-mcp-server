/**
 * Tests for tryBridgeSearch — verifies that the new object types introduced in
 * PR #511 (menu items, security artifacts, query, view, data-entity, extensions)
 * are correctly routed, formatted and passed through with the right maxResults.
 */

import { describe, it, expect, vi } from 'vitest';
import { tryBridgeSearch } from '../../src/bridge/bridgeAdapter';
import type { BridgeClient } from '../../src/bridge/bridgeClient';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeBridge(results: { name: string; type: string }[] = []): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    searchObjects: vi.fn(async () => ({
      results,
      totalCount: results.length,
    })),
  } as unknown as BridgeClient;
}

// ─── basic routing ────────────────────────────────────────────────────────────

describe('tryBridgeSearch — basic', () => {
  it('returns null when bridge is not ready', async () => {
    const bridge = { isReady: false, metadataAvailable: true } as unknown as BridgeClient;
    expect(await tryBridgeSearch(bridge, 'ProjPosted')).toBeNull();
  });

  it('returns null when bridge has no metadata', async () => {
    const bridge = { isReady: true, metadataAvailable: false } as unknown as BridgeClient;
    expect(await tryBridgeSearch(bridge, 'ProjPosted')).toBeNull();
  });

  it('returns null when bridge returns empty results', async () => {
    const bridge = makeBridge([]);
    expect(await tryBridgeSearch(bridge, 'ProjPosted')).toBeNull();
  });

  it('includes result count and source annotation', async () => {
    const bridge = makeBridge([{ name: 'ProjPostingTrans', type: 'table' }]);
    const result = await tryBridgeSearch(bridge, 'ProjPosting');
    expect(result).not.toBeNull();
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('Results:');
    expect(text).toContain('C# bridge');
  });
});

// ─── menu item types (PR #511 additions) ──────────────────────────────────────

describe('tryBridgeSearch — menu item types', () => {
  it('searches for menu-item-display and shows type in output', async () => {
    const bridge = makeBridge([
      { name: 'ProjPostedProjectTransactions', type: 'menu-item-display' },
    ]);
    const result = await tryBridgeSearch(bridge, 'ProjPosted', 'menu-item-display', 20);
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('ProjPostedProjectTransactions');
    expect(text).toContain('menu-item-display');
    // Confirms the type filter is shown in the header
    expect(text).toContain('type: menu-item-display');
    // Confirms searchObjects was called with the right objectType
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'ProjPosted',
      'menu-item-display',
      20,
    );
  });

  it('searches for menu-item-action', async () => {
    const bridge = makeBridge([{ name: 'ProjCreate', type: 'menu-item-action' }]);
    const result = await tryBridgeSearch(bridge, 'ProjCreate', 'menu-item-action', 10);
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('menu-item-action');
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'ProjCreate',
      'menu-item-action',
      10,
    );
  });

  it('searches for menu-item-output', async () => {
    const bridge = makeBridge([{ name: 'ProjInvoice', type: 'menu-item-output' }]);
    const result = await tryBridgeSearch(bridge, 'ProjInvoice', 'menu-item-output', 10);
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'ProjInvoice',
      'menu-item-output',
      10,
    );
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('menu-item-output');
  });
});

// ─── security artifact types (PR #511 additions) ─────────────────────────────

describe('tryBridgeSearch — security artifact types', () => {
  it('searches for security-privilege', async () => {
    const bridge = makeBridge([{ name: 'SalesSalesOrderMaintain', type: 'security-privilege' }]);
    const result = await tryBridgeSearch(bridge, 'SalesSales', 'security-privilege', 20);
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('SalesSalesOrderMaintain');
    expect(text).toContain('security-privilege');
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'SalesSales',
      'security-privilege',
      20,
    );
  });

  it('searches for security-duty', async () => {
    const bridge = makeBridge([{ name: 'SalesOrderMaintain', type: 'security-duty' }]);
    const result = await tryBridgeSearch(bridge, 'SalesOrder', 'security-duty', 10);
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'SalesOrder',
      'security-duty',
      10,
    );
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('security-duty');
  });

  it('searches for security-role', async () => {
    const bridge = makeBridge([{ name: 'SalesManager', type: 'security-role' }]);
    const result = await tryBridgeSearch(bridge, 'Sales', 'security-role', 10);
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'Sales',
      'security-role',
      10,
    );
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('SalesManager');
  });
});

// ─── maxResults passthrough (PR #511 fix) ────────────────────────────────────

describe('tryBridgeSearch — maxResults passthrough', () => {
  it('passes custom maxResults to bridge.searchObjects', async () => {
    const bridge = makeBridge([{ name: 'SalesTable', type: 'table' }]);
    await tryBridgeSearch(bridge, 'Sales', 'table', 75);
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'Sales',
      'table',
      75,
    );
  });

  it('uses default maxResults of 50 when not specified', async () => {
    const bridge = makeBridge([{ name: 'SalesTable', type: 'table' }]);
    await tryBridgeSearch(bridge, 'Sales');
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'Sales',
      undefined,
      50,
    );
  });

  it('omits objectType param when searching all types', async () => {
    const bridge = makeBridge([{ name: 'CustTable', type: 'table' }]);
    // undefined objectType means "all" — should be passed as undefined, not "all"
    await tryBridgeSearch(bridge, 'Cust', undefined, 20);
    expect((bridge.searchObjects as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'Cust',
      undefined,
      20,
    );
  });
});

// ─── mixed result types ───────────────────────────────────────────────────────

describe('tryBridgeSearch — mixed results', () => {
  it('renders all result types in output when searching all', async () => {
    const bridge = makeBridge([
      { name: 'ProjPostedProjectTransactions', type: 'menu-item-display' },
      { name: 'ProjPostedEnum', type: 'enum' },
      { name: 'ProjPostedPrivilege', type: 'security-privilege' },
    ]);
    const result = await tryBridgeSearch(bridge, 'ProjPosted', undefined, 50);
    const text = (result!.content[0] as { text: string }).text;
    expect(text).toContain('ProjPostedProjectTransactions');
    expect(text).toContain('menu-item-display');
    expect(text).toContain('ProjPostedEnum');
    expect(text).toContain('ProjPostedPrivilege');
    expect(text).toContain('security-privilege');
  });
});

/**
 * The type filter is a promise the TOOL makes, so the adapter has to keep it
 * even when the bridge does not.
 *
 * The bridge's C#-side type map has no entry for every AOT kind — `report` is
 * one — and an unmapped type runs the query UNFILTERED. `search(type="report")`
 * therefore answered with tables and queries, confidently: "Cust" returned six
 * tables, and `FMRentalsByCustomer` came back as two queries beside the report.
 * A caller acting on that list looks for a report among tables.
 *
 * Filtering adapter-side covers every unmapped type at once, not just the one
 * that happened to be noticed.
 */
describe('tryBridgeSearch — the requested type is enforced', () => {
  it('drops results of the wrong type when the bridge ignores the filter', async () => {
    const bridge = makeBridge([
      { name: 'FMRentalsByCustomer', type: 'report' },
      { name: 'FMRentalsByCustomer', type: 'query' },
      { name: 'FMRentalsByCustomerState', type: 'query' },
    ]);
    const result = await tryBridgeSearch(bridge, 'FMRentalsByCustomer', 'report');
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? '';

    expect(text).toContain('FMRentalsByCustomer');
    expect(text).not.toContain('(query)');
    expect(text).not.toContain('FMRentalsByCustomerState');
  });

  it('returns null rather than a wrong list when nothing matches the type', async () => {
    // Falling through lets the symbol-index path answer. A confidently wrong
    // list is worse than none, because the caller acts on it.
    const bridge = makeBridge([
      { name: 'ServicesCustomer', type: 'table' },
      { name: 'SubBillCopyCustomerSplitTmp', type: 'table' },
    ]);
    expect(await tryBridgeSearch(bridge, 'Cust', 'report')).toBeNull();
  });

  it('leaves an untyped search alone', async () => {
    const bridge = makeBridge([
      { name: 'FMRentalsByCustomer', type: 'report' },
      { name: 'FMRentalsByCustomer', type: 'query' },
    ]);
    const result = await tryBridgeSearch(bridge, 'FMRentalsByCustomer');
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? '';
    expect(text).toContain('(report)');
    expect(text).toContain('(query)');
  });

  it('treats type "all" as no filter', async () => {
    const bridge = makeBridge([
      { name: 'CustTable', type: 'table' },
      { name: 'CustGroup', type: 'table' },
    ]);
    const result = await tryBridgeSearch(bridge, 'Cust', 'all');
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? '';
    expect(text).toContain('CustTable');
  });
});
