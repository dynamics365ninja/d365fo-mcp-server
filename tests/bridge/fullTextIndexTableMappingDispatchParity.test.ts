/**
 * Regression test — C# bridge dispatch parity for the ops PR #804 added.
 *
 * RequestDispatcher.cs dispatches every write op from TWO places:
 *
 *   1. the single-op RPC arm in Dispatch() — this is the one BridgeClient.<op>()
 *      actually calls, and therefore the one every real d365fo_file modify request
 *      goes through;
 *   2. the corresponding arm inside HandleBatchModify().
 *
 * PR #804 added `add-full-text-index` / `remove-full-text-index` /
 * `add-table-mapping` / `remove-table-mapping` to (2) only. (1) had no case for
 * any of the four at all, so BridgeClient.addFullTextIndex() etc. — which call
 * Dispatch() directly, not HandleBatchModify() — died with "-32601 Unknown
 * method" on every real call, despite the ops being fully implemented in
 * MetadataWriteService and advertised as supported in the tool schema.
 *
 * The same PR also added `extendBaseFieldGroup` to `AddFieldToFieldGroup`, and
 * forwarded it in (2) but not (1): BridgeClient.addFieldToFieldGroup() — which
 * also goes through Dispatch() — silently dropped the flag, so a caller passing
 * extendBaseFieldGroup=true always got the "extension owns the group" behaviour
 * and a confusing error telling them to pass the flag they already passed.
 *
 * Repo tests could not catch either defect — they mock BridgeClient, so they
 * assert the arguments Node SENDS, never the ones C# READS (or whether C# has a
 * route for the method name at all). This is the cheap standing guard.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_CS = path.join(
  path.resolve(__dirname, '..', '..'),
  'bridge', 'D365MetadataBridge', 'Protocol', 'RequestDispatcher.cs',
);

let source: string;

/**
 * Slices the body of a `case "<name>":` arm — up to the next case label that
 * starts a DIFFERENT arm. Consecutive fall-through labels (e.g.
 * `case "addfulltextindex":` immediately followed by `case "add-full-text-index":`)
 * share one body, so they are skipped rather than treated as the end.
 */
function caseBody(from: number): string {
  let cursor = from;
  for (;;) {
    const next = source.indexOf('case "', cursor + 1);
    if (next === -1) return source.slice(from);
    if (/^\s*$/.test(source.slice(source.indexOf(':', cursor) + 1, next))) {
      cursor = next;
      continue;
    }
    return source.slice(from, next);
  }
}

/** Both occurrences of `case "<op>":` — [Dispatch() single-op body, HandleBatchModify() body]. */
function bothSites(op: string): [string, string] {
  const first = source.indexOf(`case "${op}":`);
  expect(first, `no dispatch site found for '${op}'`).toBeGreaterThanOrEqual(0);
  const second = source.indexOf(`case "${op}":`, first + 1);
  expect(
    second,
    `'${op}' has only ONE dispatch site — expected the single-op RPC arm in ` +
      `Dispatch() plus the arm in HandleBatchModify()`,
  ).toBeGreaterThan(first);
  return [caseBody(first), caseBody(second)];
}

describe('bridge dispatch parity — full-text-index / table-mapping / extendBaseFieldGroup', () => {
  beforeAll(() => {
    source = fs.readFileSync(DISPATCHER_CS, 'utf8');
  });

  it.each([
    'addfulltextindex',
    'removefulltextindex',
    'addtablemapping',
    'removetablemapping',
  ])('dispatches %s from exactly the two known sites', (op) => {
    const sites = source.match(new RegExp(`case "${op}":`, 'g')) ?? [];
    expect(
      sites.length,
      `'${op}' must be reachable from Dispatch() (single-op RPC) AND HandleBatchModify() — ` +
        `found ${sites.length} site(s). If this is 1, the single-op RPC that BridgeClient ` +
        `actually calls has no route and every real request fails with "Unknown method".`,
    ).toBe(2);
  });

  it('forwards indexName + fields on both addFullTextIndex dispatch sites', () => {
    const [single, batch] = bothSites('addfulltextindex');
    expect(single).toContain('GetStringParam("indexName")');
    expect(single).toMatch(/GetParam<[^>]*List<string>[^>]*>\("fields"\)/);
    expect(batch).toContain('S("indexName")');
    expect(batch).toMatch(/GetTypedParam<[^>]*List<string>[^>]*>\("fields"\)/);
  });

  it('forwards indexName on both removeFullTextIndex dispatch sites', () => {
    const [single, batch] = bothSites('removefulltextindex');
    expect(single).toContain('GetStringParam("indexName")');
    expect(batch).toContain('S("indexName")');
  });

  it('forwards mapName + mappingTable + connections on both addTableMapping dispatch sites', () => {
    const [single, batch] = bothSites('addtablemapping');
    expect(single).toContain('GetStringParam("mapName")');
    expect(single).toContain('GetStringParam("mappingTable")');
    expect(single).toMatch(/GetParam<[^>]*List<WriteMappingConnection>[^>]*>\("connections"\)/);
    expect(batch).toContain('S("mapName")');
    expect(batch).toContain('S("mappingTable")');
    expect(batch).toMatch(/GetTypedParam<[^>]*List<WriteMappingConnection>[^>]*>\("connections"\)/);
  });

  it('forwards mapName on both removeTableMapping dispatch sites', () => {
    const [single, batch] = bothSites('removetablemapping');
    expect(single).toContain('GetStringParam("mapName")');
    expect(batch).toContain('S("mapName")');
  });

  it('forwards extendBaseFieldGroup on both addFieldToFieldGroup dispatch sites', () => {
    const [single, batch] = bothSites('addfieldtofieldgroup');
    expect(
      single,
      'single-op addFieldToFieldGroup drops extendBaseFieldGroup — a caller extending a ' +
        'base-table field group always gets the "extension owns the group" behaviour instead',
    ).toContain('GetBoolParam("extendBaseFieldGroup")');
    expect(batch).toContain('B("extendBaseFieldGroup")');
  });
});
