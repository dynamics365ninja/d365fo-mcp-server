/**
 * Every published modify operation must be REACHABLE.
 *
 * `add-entry-point` shipped complete on paper — a schema enum entry, an op-spec,
 * a dispatcher case in modifyD365File.ts and a working direct-XML writer with its
 * own unit tests — and could not be invoked at all:
 *
 *   ❌ Operation 'add-entry-point' on object type 'security-privilege'
 *      is not supported by the bridge.
 *
 * `canBridgeModify()` gates every modify before dispatch, and the operation was
 * absent from BOTH sets it has to clear (`BRIDGE_MODIFY_OPS` and, for a type the
 * bridge cannot write, `XML_ONLY_MODIFY_PAIRS`). The first check short-circuits,
 * so the handler was dead code behind a published schema. The feature's own tests
 * drove the writer module directly and never the dispatch path, so all of them
 * passed while the tool surface offered an operation that always failed.
 *
 * That is a whole CLASS of defect — advertise an operation, forget one gate — and
 * it is mechanically checkable, so this checks it mechanically rather than
 * relying on the next operation's author to remember. Caught live by eval case
 * L2-object-delete-and-entry-point-cleanup, 2026-08-23.
 */

import { describe, it, expect } from 'vitest';
import { d365foFileTool } from '../../src/server/toolSchemas/d365foFile.js';
import { canBridgeModify } from '../../src/bridge/bridgeAdapter.js';

const schema = d365foFileTool.inputSchema.properties as Record<string, { enum?: string[] }>;
const OPERATIONS = schema.operation?.enum ?? [];
const OBJECT_TYPES = schema.objectType?.enum ?? [];

describe('published modify operations are reachable through the dispatch gate', () => {
  it('the schema actually exposes both enums (guard against a silent empty sweep)', () => {
    // Without this, a renamed schema key would make every case below vacuously
    // pass over an empty list — the test would go green by testing nothing.
    expect(OPERATIONS.length).toBeGreaterThan(30);
    expect(OBJECT_TYPES.length).toBeGreaterThan(20);
  });

  it.each(OPERATIONS.map(op => [op] as const))(
    '%s is accepted by canBridgeModify for at least one published objectType',
    op => {
      const accepted = OBJECT_TYPES.filter(t => canBridgeModify(t, op));
      expect(
        accepted,
        `Operation "${op}" is published in the d365fo_file schema but canBridgeModify() ` +
          `rejects it for EVERY objectType, so calling it can only ever fail. Add it to ` +
          `BRIDGE_MODIFY_OPS in src/bridge/bridgeAdapter.ts, and — if the bridge has no ` +
          `write path for its object type — to XML_ONLY_MODIFY_PAIRS as well. Both are ` +
          `required; either one alone still returns false.`,
      ).not.toEqual([]);
    },
  );

  it('add-entry-point reaches security-privilege specifically', () => {
    // The regression that motivated the sweep above, pinned on its own so the
    // failure names the operation rather than one row of a parametrised list.
    expect(canBridgeModify('security-privilege', 'add-entry-point')).toBe(true);
  });

  it('still refuses an operation that is genuinely not published', () => {
    // The sweep would also pass if canBridgeModify() simply returned true for
    // everything, so pin the negative side too.
    expect(canBridgeModify('security-privilege', 'add-nonexistent-operation')).toBe(false);
  });
});
