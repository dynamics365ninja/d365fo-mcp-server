/**
 * Every parameter an op-spec advertises must be DECLARED in the args schema.
 *
 * The dispatcher merges `{...args, ...args.params}` and hands the result to
 * `ModifyD365FileArgsSchema`. Zod STRIPS keys it does not declare — silently. So a
 * parameter can exist in the op-spec, be read by the dispatcher and be honoured by
 * the writer, and still never arrive.
 *
 * That is exactly what happened to `accessLevel` on `add-entry-point`: declared in
 * d365foFileOpSpecs.ts, read at the dispatch site, honoured by the writer — and
 * absent from the schema. `args.accessLevel` was therefore always undefined and the
 * writer fell back to `?? 'view'`, so EVERY entry point the operation ever wrote
 * granted Read only, under a ✅, for callers who asked for `maintain`. A security
 * object that grants less than it says, builds clean and passes xppbp.
 *
 * The existing silent-parameter-drop guard cannot see this class. `findIgnoredParams`
 * compares the caller's raw argument keys against the OP-SPEC — which lists
 * `accessLevel` — so the key is judged consumed while Zod has already discarded it.
 * It catches caller typos, not op-spec/schema divergence.
 *
 * This is the third defect in the same family (see also
 * tests/tools/modifyOpReachability.test.ts, where an operation existed everywhere
 * except the bridge gate). The shape of the mistake is always "present in every
 * place a human would look, missing from the one gate that decides". Both tables
 * are in-repo, so the check is a pure unit test.
 *
 * Found by eval case L2-object-delete-and-entry-point-cleanup, 2026-08-23.
 */

import { describe, it, expect } from 'vitest';
import { ModifyD365FileArgsSchema } from '../../src/tools/write/modifyD365File.js';
import {
  D365FO_FILE_OP_SPECS,
  D365FO_FILE_CORE_PARAMS,
  OP_PARAM_ALIASES,
} from '../../src/tools/specs/d365foFileOpSpecs.js';

const SCHEMA_KEYS = new Set(Object.keys(ModifyD365FileArgsSchema.shape));
/** Alternative spellings the dispatcher normalises before the schema sees them. */
const ALIASES = new Set(Object.values(OP_PARAM_ALIASES).flat());

const OPS = Object.entries(D365FO_FILE_OP_SPECS);

describe('op-spec parameters survive the args schema', () => {
  it('both tables are non-empty (guard against a vacuous sweep)', () => {
    // Without this, a renamed export would make every case below pass over an
    // empty list — green by testing nothing, which is the failure mode this whole
    // file exists to prevent.
    expect(OPS.length).toBeGreaterThan(30);
    expect(SCHEMA_KEYS.size).toBeGreaterThan(50);
  });

  it.each(OPS.map(([op, spec]) => [op, spec] as const))(
    '%s: every advertised parameter is a declared schema key',
    (op, spec) => {
      const advertised = [...(spec.required ?? []), ...(spec.optional ?? [])];
      const dropped = advertised.filter(
        p => !SCHEMA_KEYS.has(p) && !D365FO_FILE_CORE_PARAMS.has(p) && !ALIASES.has(p),
      );
      expect(
        dropped,
        `Operation "${op}" advertises ${dropped.map(d => `"${d}"`).join(', ')} in ` +
          `d365foFileOpSpecs.ts, but ModifyD365FileArgsSchema does not declare it. Zod strips ` +
          `undeclared keys, so the value never reaches the writer — the call reports success ` +
          `and silently uses the default. Add it to the schema in src/tools/write/modifyD365File.ts.`,
      ).toEqual([]);
    },
  );

  it('accessLevel specifically reaches add-entry-point', () => {
    // The regression that motivated the sweep, pinned so the failure names it
    // rather than appearing as one row of a parametrised list.
    expect(SCHEMA_KEYS.has('accessLevel')).toBe(true);
    const parsed = ModifyD365FileArgsSchema.parse({
      action: 'modify',
      objectType: 'security-privilege',
      objectName: 'MyPrivilege',
      operation: 'add-entry-point',
      accessLevel: 'maintain',
    });
    expect((parsed as Record<string, unknown>).accessLevel).toBe('maintain');
  });

  it('still strips a key nothing declares', () => {
    // The sweep would also pass if the schema were passthrough, which would defeat
    // the point — the guarantee is "declared keys survive", not "everything survives".
    const parsed = ModifyD365FileArgsSchema.parse({
      action: 'modify',
      objectType: 'security-privilege',
      objectName: 'MyPrivilege',
      operation: 'add-entry-point',
      totallyUndeclaredKey: 'x',
    });
    expect((parsed as Record<string, unknown>).totallyUndeclaredKey).toBeUndefined();
  });
});
