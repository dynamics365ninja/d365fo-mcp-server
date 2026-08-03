/**
 * Regression test — C# bridge `addField` dispatch parity
 *
 * RequestDispatcher.cs dispatches `addField` from TWO places:
 *
 *   1. the single-op RPC `case "addfield":` in Dispatch() — this is the one
 *      BridgeClient.addField() actually calls, and therefore the one every
 *      d365fo_file modify → bridgeAddField request goes through;
 *   2. the `case "addfield": case "add-field":` arm inside HandleBatchModify().
 *
 * When the data-entity-extension mapped-field path was added to
 * MetadataWriteService.AddField(dataField, dataSource, fieldGroupName), only (2)
 * was updated. (1) kept calling the 6-argument overload, so the three new
 * parameters were silently dropped on the single-op path: AddField saw no
 * binding, fell through to the table/table-extension branch, and every real
 * request died with "Table or table-extension '<entity>.<ext>' not found".
 *
 * Repo tests could not catch this — they mock BridgeClient, so they assert the
 * arguments Node SENDS, never the ones C# READS. It took an end-to-end run
 * against a real AxDataEntityViewExtension on the VM to surface it. This test is
 * the cheap standing guard: both dispatch sites must forward the same parameters.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_CS = path.join(
  path.resolve(__dirname, '..', '..'),
  'bridge', 'D365MetadataBridge', 'Protocol', 'RequestDispatcher.cs',
);

/** Parameters that select the data-entity-extension mapped-field path in AddField. */
const MAPPED_FIELD_PARAMS = ['dataField', 'dataSource', 'fieldGroupName'];

let source: string;

/**
 * Slices the body of a `case "<name>":` arm — up to the next case label that
 * starts a DIFFERENT arm. Consecutive fall-through labels (`case "addfield":`
 * immediately followed by `case "add-field":`) share one body, so they are
 * skipped rather than treated as the end.
 */
function caseBody(from: number): string {
  let cursor = from;
  for (;;) {
    const next = source.indexOf('case "', cursor + 1);
    if (next === -1) return source.slice(from);
    // Only whitespace between the labels ⇒ fall-through, same body: keep going.
    if (/^\s*$/.test(source.slice(source.indexOf(':', cursor) + 1, next))) {
      cursor = next;
      continue;
    }
    return source.slice(from, next);
  }
}

describe('bridge addField dispatch parity', () => {
  beforeAll(() => {
    source = fs.readFileSync(DISPATCHER_CS, 'utf8');
  });

  it('dispatches addField from exactly the two known sites', () => {
    const sites = source.match(/case "addfield":/g) ?? [];
    expect(
      sites.length,
      'a third addField dispatch site appeared — extend this test to cover it',
    ).toBe(2);
  });

  it('forwards the mapped-field parameters on the single-op RPC path', () => {
    // The single-op arm is the first one and reads params via request.GetStringParam.
    const body = caseBody(source.indexOf('case "addfield":'));
    expect(body).toContain('GetStringParam("objectName")');

    for (const param of MAPPED_FIELD_PARAMS) {
      expect(
        body,
        `single-op addField drops '${param}' — data-entity-extension add-field ` +
          `falls through to the table branch and fails with "Table or ` +
          `table-extension not found"`,
      ).toContain(`GetStringParam("${param}")`);
    }
  });

  it('forwards the mapped-field parameters on the batch-modify path', () => {
    // The batch arm is the second one and reads params via the local S() helper.
    const body = caseBody(source.indexOf('case "addfield":', source.indexOf('case "addfield":') + 1));

    for (const param of MAPPED_FIELD_PARAMS) {
      expect(body, `batch addField drops '${param}'`).toContain(`S("${param}")`);
    }
  });
});
