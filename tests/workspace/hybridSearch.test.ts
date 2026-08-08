/**
 * HybridSearch — merging the external metadata index with local workspace files
 * (audit phase 4.5: the module was reached only incidentally, through other
 * tools' mocks, so nothing pinned its own ranking and de-duplication rules).
 *
 * Two behaviours carry real consequences for the agent and are asserted here:
 *
 *  • The relevance ladder decides what the agent reads first. An exact hit that
 *    ranks below a substring hit sends it to the wrong object, and it usually
 *    acts on the first result rather than re-reading the list.
 *  • De-duplication must prefer the WORKSPACE copy of a name. The workspace file
 *    is the version being edited; the indexed copy can be an older build, so
 *    returning the external one makes the agent reason about stale source.
 *
 * The index and scanner are hand-written stubs rather than vi.mock: this suite
 * is about HybridSearch's own arithmetic, and a stub makes the inputs that
 * produce each score visible in the test.
 */

import { describe, it, expect } from 'vitest';
import { HybridSearch } from '../../src/workspace/hybridSearch';
import type { XppSymbol } from '../../src/metadata/types';
import type { WorkspaceFile } from '../../src/workspace/workspaceScanner';

function symbol(name: string, type: XppSymbol['type'] = 'table'): XppSymbol {
  return { name, type } as XppSymbol;
}

function file(name: string): WorkspaceFile {
  return { path: `C:/ws/${name}.xml`, name, type: 'table', lastModified: new Date(0) };
}

interface StubCalls {
  searchSymbols: Array<{ query: string; limit: number; types?: string[] }>;
  searchInWorkspace: Array<{ workspacePath: string; query: string; type?: string }>;
}

function makeSearch(external: XppSymbol[], workspace: WorkspaceFile[] = []) {
  const calls: StubCalls = { searchSymbols: [], searchInWorkspace: [] };
  const index = {
    searchSymbols(query: string, limit: number, types?: string[]) {
      calls.searchSymbols.push({ query, limit, types });
      return external;
    },
    analyzeCodePatterns: () => [],
  };
  const scanner = {
    async searchInWorkspace(workspacePath: string, query: string, type?: string) {
      calls.searchInWorkspace.push({ workspacePath, query, type });
      return workspace;
    },
  };
  // The class needs only these two members of each collaborator.
  return { search: new HybridSearch(index as never, scanner as never), calls };
}

describe('HybridSearch ranking', () => {
  it('orders exact over prefix over substring over fuzzy', async () => {
    const { search } = makeSearch([
      symbol('MyCustTable'),        // substring
      symbol('CustTableExtended'),  // prefix
      symbol('CustTable'),          // exact
      symbol('CostTable'),          // fuzzy (one substitution)
    ]);

    const results = await search.search('CustTable');

    expect(results.map(r => r.symbol!.name)).toEqual([
      'CustTable', 'CustTableExtended', 'MyCustTable', 'CostTable',
    ]);
    expect(results.map(r => r.relevance)).toEqual([100, 80, 50, 47]);
  });

  it('scores case-insensitively, so a lowercase query still finds an exact match', async () => {
    // The agent types names as the user said them; the index stores AOT casing.
    const { search } = makeSearch([symbol('CustTable')]);
    const [top] = await search.search('custtable');
    expect(top.relevance).toBe(100);
  });

  it('scores an unrelated name at the floor rather than fuzzy-matching it', async () => {
    // similarity < 0.65 must not be dressed up as a near-miss: a 40-50 score
    // would put an unrelated object next to a genuine substring hit.
    const { search } = makeSearch([symbol('SalesLine')]);
    const [only] = await search.search('CustTable');
    expect(only.relevance).toBe(10);
  });
});

describe('HybridSearch workspace merge', () => {
  const WS = 'C:/ws';

  it('keeps the workspace copy when the same name exists in both', async () => {
    // The indexed copy can predate the edit in progress. Returning it makes the
    // agent reason about source that is no longer on disk.
    const { search } = makeSearch([symbol('CustTable')], [file('CustTable')]);

    const results = await search.search('CustTable', { includeWorkspace: true, workspacePath: WS });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('workspace');
    expect(results[0].file?.path).toBe('C:/ws/CustTable.xml');
  });

  it('does not touch the workspace unless both includeWorkspace and workspacePath are given', async () => {
    // Scanning is a filesystem walk; a half-specified request must not pay for it.
    for (const options of [
      { includeWorkspace: true },
      { workspacePath: WS },
      {},
    ]) {
      const { search, calls } = makeSearch([symbol('CustTable')], [file('CustTable')]);
      const results = await search.search('CustTable', options);
      expect(calls.searchInWorkspace, JSON.stringify(options)).toHaveLength(0);
      expect(results[0].source).toBe('external');
    }
  });

  it('passes the query and the first type through to the scanner', async () => {
    // Only the FIRST type reaches the workspace filter — the scanner takes one
    // type, not a set. Pinned so that a caller passing several types can see
    // here that the rest are dropped rather than discovering it from results.
    const { search, calls } = makeSearch([], [file('CustTable')]);

    await search.search('Cust', {
      includeWorkspace: true,
      workspacePath: WS,
      types: ['table', 'class'],
    });

    expect(calls.searchInWorkspace).toEqual([{ workspacePath: WS, query: 'Cust', type: 'table' }]);
  });

  it('applies the limit to the merged result, not to each source separately', async () => {
    const external = ['Cust1', 'Cust2', 'Cust3'].map(n => symbol(n));
    const workspace = ['Cust4', 'Cust5'].map(n => file(n));
    const { search, calls } = makeSearch(external, workspace);

    const results = await search.search('Cust', {
      includeWorkspace: true, workspacePath: WS, limit: 4,
    });

    expect(results).toHaveLength(4);
    // The limit is also handed to the index so it does not build rows that the
    // merge would only throw away.
    expect(calls.searchSymbols[0].limit).toBe(4);
  });

  it('collapses a name the index returned more than once', async () => {
    // The index carries one row per model, so a name extended in two models
    // comes back twice. Both rows score identically (the score is a function of
    // the name alone), so without the collapse the agent sees the same object
    // twice and burns a read deciding they are the same thing.
    const { search } = makeSearch([symbol('CustTable'), symbol('CustTable'), symbol('SalesTable')]);

    const results = await search.search('CustTable');

    expect(results.map(r => r.symbol!.name)).toEqual(['CustTable', 'SalesTable']);
  });
});
