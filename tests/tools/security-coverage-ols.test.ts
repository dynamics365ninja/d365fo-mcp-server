/**
 * Regression: get_security_coverage_for_object must not answer "no row-level
 * security" when it simply has no OLS data (#690).
 *
 * The OLS section used to render only when the security_policies query returned
 * rows, so a database whose security_policies table is empty (any DB assembled
 * from a prebuilt standard-model database built before the AxSecurityPolicy
 * extractor landed) made an XDS-constrained table look exactly like an
 * unconstrained one — a silent false negative on a security question.
 *
 * The distinction under test is "no policies for THIS table" (honest none) vs
 * "no policies indexed at all" (unknown).
 */

import { describe, it, expect, vi } from 'vitest';
import { securityCoverageInfoTool } from '../../src/tools/readers/securityCoverageInfo';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_security_coverage_for_object', arguments: args },
});

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

/**
 * Route mock query results by a substring of the SQL text (see
 * new-object-info.test.ts). `throws` simulates a table absent from the schema.
 *
 * Both security_policies statements share the table name, so they are routed on
 * disjoint substrings: 'WHERE primary_table' for the lookup, 'SELECT 1 FROM
 * security_policies' for the emptiness probe.
 */
type Route = { match: string; get?: any; all?: any[]; throws?: boolean };
const routedDb = (routes: Route[]) => ({
  prepare: vi.fn((sql: string) => {
    const r = routes.find(rt => sql.includes(rt.match));
    if (r?.throws) throw new Error('no such table: security_policies');
    return {
      get: vi.fn(() => r?.get),
      all: vi.fn(() => r?.all ?? []),
      run: vi.fn(() => ({ changes: 0 })),
    };
  }),
});

const ctx = (db: any): XppServerContext =>
  ({ symbolIndex: { getReadDb: vi.fn(() => db) } } as any);

/** The table exists in the symbol index; symbolLookup reads it via all(). */
const CUST_TABLE: Route = {
  match: 'FROM symbols s',
  all: [{ name: 'CustTable', type: 'table', model: 'Foundation', extends_class: null, file_path: '/CustTable.xml' }],
};

const POLICY_ROW = {
  policy_name: 'CustTablePolicy', query_name: 'CustTableQuery',
  operation: 'AllOperations', constrained_table: 1, label: '@SYS1',
};

describe('security coverage OLS section (#690)', () => {
  it('flags OLS as unknown when no policies are indexed at all', async () => {
    const db = routedDb([
      CUST_TABLE,
      { match: 'WHERE primary_table', all: [] },
      { match: 'SELECT 1 FROM security_policies', get: undefined }, // table empty
    ]);
    const r: any = await securityCoverageInfoTool(req({ objectName: 'CustTable', objectType: 'table' }), ctx(db));

    const text = textOf(r);
    expect(text).toContain('unknown');
    expect(text).toContain('not indexed');
    // The caveat must actively deny the "none" reading a silent omission implied.
    expect(text).toContain('NOT the same as "no row-level security"');
  });

  it('stays silent about OLS when policies ARE indexed but none constrain this table', async () => {
    const db = routedDb([
      CUST_TABLE,
      { match: 'WHERE primary_table', all: [] },
      { match: 'SELECT 1 FROM security_policies', get: { 1: 1 } }, // table populated
    ]);
    const r: any = await securityCoverageInfoTool(req({ objectName: 'CustTable', objectType: 'table' }), ctx(db));

    // "No policies for this table" is a real answer — it must not be muddied
    // by an unknown-coverage caveat.
    expect(textOf(r)).not.toContain('unknown');
    expect(textOf(r)).not.toContain('not indexed');
  });

  it('flags OLS as unknown when the security_policies table is absent (older database)', async () => {
    const db = routedDb([
      CUST_TABLE,
      { match: 'security_policies', throws: true },
    ]);
    const r: any = await securityCoverageInfoTool(req({ objectName: 'CustTable', objectType: 'table' }), ctx(db));

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('unknown');
  });

  it('still renders constraining policies when they are indexed', async () => {
    const db = routedDb([
      CUST_TABLE,
      { match: 'WHERE primary_table', all: [POLICY_ROW] },
      { match: 'SELECT 1 FROM security_policies', get: { 1: 1 } },
    ]);
    const r: any = await securityCoverageInfoTool(req({ objectName: 'CustTable', objectType: 'table' }), ctx(db));

    const text = textOf(r);
    expect(text).toContain('CustTablePolicy');
    expect(text).toContain('CustTableQuery');
    expect(text).not.toContain('not indexed');
  });

  it('does not probe OLS for an object type that cannot carry a policy', async () => {
    const db = routedDb([
      { match: 'FROM symbols s', all: [{ name: 'CustPost', type: 'class', model: 'Foundation', extends_class: null, file_path: '/CustPost.xml' }] },
      { match: 'SELECT 1 FROM security_policies', get: undefined },
    ]);
    const r: any = await securityCoverageInfoTool(req({ objectName: 'CustPost', objectType: 'class' }), ctx(db));

    // OLS applies to tables; an unknown-coverage caveat on a class is noise.
    expect(textOf(r)).not.toContain('not indexed');
  });
});
